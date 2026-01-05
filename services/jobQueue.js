const { Queue, Worker, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');
const cron = require('node-cron');

const config = require('../config');
const { logger } = require('./logger');
const { CryptoLockedError, vault } = require('./encryption');

function getBullPrefix() {
    const base = (config.REDIS_PREFIX || 'wp-panel:').replace(/:+$/, '');
    return `${base}:bull`;
}

function parseDateMs(value) {
    if (!value) return null;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
}

class JobQueue {
    constructor({ accountManager, metrics } = {}) {
        this.accountManager = accountManager;
        this.metrics = metrics || null;
        this.enabled = Boolean(config.REDIS_URL) && Boolean(config.JOB_QUEUE_ENABLED);
        this.prefix = getBullPrefix();
        this.connection = null;
        this.queue = null;
        this.scheduler = null;
        this.worker = null;
        this.dlq = null;
    }

    isEnabled() {
        return this.enabled;
    }

    async start() {
        if (!this.enabled) return;

        this.connection = new IORedis(config.REDIS_URL, {
            maxRetriesPerRequest: null
        });

        this.queue = new Queue('jobs', { connection: this.connection, prefix: this.prefix });
        this.scheduler = new QueueScheduler('jobs', { connection: this.connection, prefix: this.prefix });
        this.dlq = new Queue('dlq', { connection: this.connection, prefix: this.prefix });

        this.worker = new Worker(
            'jobs',
            async (job) => this.process(job),
            {
                connection: this.connection,
                prefix: this.prefix,
                concurrency: config.JOB_QUEUE_CONCURRENCY
            }
        );

        this.worker.on('failed', async (job, error) => {
            try {
                const attempts = job?.opts?.attempts || 1;
                const attemptsMade = job?.attemptsMade || 0;
                if (!job || attemptsMade < attempts) return;

                await this.dlq.add(
                    'dead-letter',
                    {
                        original: {
                            id: job.id,
                            name: job.name,
                            data: job.data,
                            opts: { attempts, backoff: job.opts?.backoff || null }
                        },
                        error: {
                            message: error?.message || String(error),
                            stack: error?.stack || null
                        },
                        failedAt: Date.now()
                    },
                    {
                        removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
                        removeOnFail: { age: 30 * 24 * 3600, count: 20000 }
                    }
                );
            } catch (e) {}
        });

        await this.bootstrap();
        logger.info('Job queue started', { category: 'jobs', prefix: this.prefix });
    }

    async close() {
        if (!this.enabled) return;
        try {
            await this.worker?.close?.();
        } catch (e) {}
        try {
            await this.scheduler?.close?.();
        } catch (e) {}
        try {
            await this.queue?.close?.();
        } catch (e) {}
        try {
            await this.dlq?.close?.();
        } catch (e) {}
        try {
            await this.connection?.quit?.();
        } catch (e) {}
        logger.info('Job queue stopped', { category: 'jobs' });
    }

    recordJob(accountId, job, outcome, durationSeconds = null) {
        const labels = { accountId: accountId || 'unknown', job, outcome };
        try {
            this.metrics?.backgroundJobRunsTotal?.inc?.(labels, 1);
        } catch (e) {}

        if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
            try {
                this.metrics?.backgroundJobDurationSeconds?.observe?.(labels, durationSeconds);
            } catch (e) {}
        }
    }

    async bootstrap() {
        if (!this.enabled) return;
        const accounts = this.accountManager?.listAccounts?.() || [];
        for (const account of accounts) {
            const accountId = account?.id;
            if (!accountId) continue;
            await this.ensureCleanupJobs(accountId);
            await this.syncScheduledJobs(accountId);
        }
    }

    async ensureCleanupJobs(accountId) {
        if (!this.enabled) return;
        const daily = config.CLEANUP_DAILY_CRON;
        const weekly = config.CLEANUP_WEEKLY_CRON;

        if (cron.validate(daily)) {
            await this.queue.add(
                'cleanup.daily',
                { accountId },
                {
                    jobId: `cleanup.daily:${accountId}`,
                    repeat: { pattern: daily },
                    attempts: 1,
                    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
                    removeOnFail: { age: 30 * 24 * 3600, count: 1000 }
                }
            );
        }

        if (cron.validate(weekly)) {
            await this.queue.add(
                'cleanup.weekly',
                { accountId },
                {
                    jobId: `cleanup.weekly:${accountId}`,
                    repeat: { pattern: weekly },
                    attempts: 1,
                    removeOnComplete: { age: 30 * 24 * 3600, count: 500 },
                    removeOnFail: { age: 90 * 24 * 3600, count: 1000 }
                }
            );
        }
    }

    async syncScheduledJobs(accountId) {
        if (!this.enabled) return;
        const context = this.accountManager.getAccountContext(accountId);
        const rows = context.db.db.prepare(`
            SELECT id, scheduled_at, next_attempt_at, retry_count, is_sent, is_recurring, cron_expression
            FROM scheduled_messages
        `).all();

        for (const row of rows) {
            if (row.is_recurring && row.cron_expression) {
                await this.ensureRecurringSchedule(accountId, row.id, row.cron_expression);
                continue;
            }

            if (row.is_sent) continue;
            const scheduledAtMs = parseDateMs(row.scheduled_at);
            const nextAttemptMs = parseDateMs(row.next_attempt_at);
            const runAtMs = nextAttemptMs || scheduledAtMs || Date.now();
            await this.enqueueOneTimeSchedule(accountId, row.id, runAtMs);
        }
    }

    async enqueueOneTimeSchedule(accountId, scheduledId, runAtMs) {
        if (!this.enabled) return;
        const delay = Math.max(0, (runAtMs || Date.now()) - Date.now());
        await this.queue.add(
            'scheduled.send',
            { accountId, scheduledId },
            {
                jobId: `scheduled.send:${accountId}:${scheduledId}`,
                delay,
                attempts: config.SCHEDULER_MAX_RETRIES || 5,
                backoff: { type: 'exponential', delay: config.SCHEDULER_RETRY_BASE_MS || 60000 },
                removeOnComplete: { age: 30 * 24 * 3600, count: 20000 },
                removeOnFail: { age: 90 * 24 * 3600, count: 20000 }
            }
        );
    }

    async ensureRecurringSchedule(accountId, scheduledId, cronExpression) {
        if (!this.enabled) return;
        if (!cron.validate(cronExpression)) {
            throw new Error('Invalid cron_expression');
        }
        await this.queue.add(
            'scheduled.recurring',
            { accountId, scheduledId },
            {
                jobId: `scheduled.recurring:${accountId}:${scheduledId}`,
                repeat: { pattern: cronExpression },
                attempts: 3,
                backoff: { type: 'exponential', delay: 30000 },
                removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
                removeOnFail: { age: 30 * 24 * 3600, count: 10000 }
            }
        );
    }

    async removeSchedule(accountId, scheduledId, cronExpression) {
        if (!this.enabled) return;
        try {
            if (cronExpression) {
                await this.queue.removeRepeatable(
                    'scheduled.recurring',
                    { pattern: cronExpression },
                    `scheduled.recurring:${accountId}:${scheduledId}`
                );
                return;
            }
        } catch (e) {}

        try {
            const job = await this.queue.getJob(`scheduled.send:${accountId}:${scheduledId}`);
            if (job) await job.remove();
        } catch (e) {}
    }

    async process(job) {
        const startNs = process.hrtime.bigint();
        const name = job?.name || 'unknown';
        const accountId = job?.data?.accountId || 'unknown';
        try {
            if (name === 'cleanup.daily') {
                const context = this.accountManager.getAccountContext(accountId);
                context.cleanup.runDailyCleanup();
                const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
                this.recordJob(accountId, 'cleanup.daily', 'success', durationSeconds);
                return;
            }

            if (name === 'cleanup.weekly') {
                const context = this.accountManager.getAccountContext(accountId);
                context.cleanup.runWeeklyCleanup();
                const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
                this.recordJob(accountId, 'cleanup.weekly', 'success', durationSeconds);
                return;
            }

            if (name === 'scheduled.send') {
                await this.processOneTimeScheduled(job);
                const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
                this.recordJob(accountId, 'scheduler.send_pending', 'success', durationSeconds);
                return;
            }

            if (name === 'scheduled.recurring') {
                await this.processRecurring(job);
                const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
                this.recordJob(accountId, 'scheduler.send_recurring', 'success', durationSeconds);
                return;
            }

            logger.warn('Unknown job received', { category: 'jobs', name, accountId });
        } catch (error) {
            const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            this.recordJob(accountId, name, 'error', durationSeconds);
            throw error;
        }
    }

    async processOneTimeScheduled(job) {
        const { accountId, scheduledId } = job.data || {};
        if (!accountId || !scheduledId) return;

        const context = this.accountManager.getAccountContext(accountId);

        if (!vault.getAccountKey(accountId)) {
            throw new CryptoLockedError();
        }

        const msg = context.db.scheduled.getById.get(scheduledId);
        if (!msg) return;
        if (msg.is_sent) return;

        const maxRetries = config.SCHEDULER_MAX_RETRIES || 5;
        const baseDelayMs = config.SCHEDULER_RETRY_BASE_MS || 60000;

        if (!context.whatsapp || !context.whatsapp.isReady()) {
            throw new Error('WhatsApp not ready');
        }

        try {
            const resolvedMessage = context.scheduler.resolveScheduledMessage(msg);
            if (!resolvedMessage) {
                throw new Error('Resolved scheduled message is empty');
            }
            await context.whatsapp.sendMessage(msg.chat_id, resolvedMessage);
            context.db.scheduled.markSent.run(msg.id);
            context.db.logs.add.run('info', 'scheduler', 'Scheduled message sent', JSON.stringify({ id: msg.id, chatId: msg.chat_id }));
            return;
        } catch (error) {
            const nextRetryCount = (msg.retry_count || 0) + 1;
            if (nextRetryCount >= maxRetries) {
                context.db.logs.add.run('error', 'scheduler', 'Scheduled message failed permanently', JSON.stringify({ id: msg.id, error: error.message }));
                throw error;
            }

            const delayMs = baseDelayMs * Math.pow(2, Math.max(nextRetryCount - 1, 0));
            const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

            context.db.scheduled.recordFailure.run(nextRetryCount, nextAttemptAt, error.message, msg.id);
            context.db.logs.add.run('error', 'scheduler', 'Failed to send scheduled message', JSON.stringify({ id: msg.id, error: error.message, retryCount: nextRetryCount, nextAttemptAt }));

            throw error;
        }
    }

    async processRecurring(job) {
        const { accountId, scheduledId } = job.data || {};
        if (!accountId || !scheduledId) return;

        const context = this.accountManager.getAccountContext(accountId);

        if (!vault.getAccountKey(accountId)) {
            throw new CryptoLockedError();
        }

        if (!context.whatsapp || !context.whatsapp.isReady()) {
            throw new Error('WhatsApp not ready');
        }

        const row = context.db.scheduled.getById.get(scheduledId);
        if (!row) return;
        if (!row.is_recurring || !row.cron_expression) return;

        const resolvedMessage = context.scheduler.resolveScheduledMessage(row);
        if (!resolvedMessage) {
            throw new Error('Resolved recurring message is empty');
        }
        await context.whatsapp.sendMessage(row.chat_id, resolvedMessage);
        context.db.logs.add.run('info', 'scheduler', 'Recurring message sent', JSON.stringify({ id: scheduledId, chatId: row.chat_id, cron: row.cron_expression }));
    }
}

module.exports = { JobQueue };


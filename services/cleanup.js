/**
 * WhatsApp Web Panel - Cleanup Service
 */
const cron = require('node-cron');
const { logger } = require('./logger');

class CleanupService {
    constructor(db, config) {
        this.db = db;
        this.config = config;
        this.jobs = [];
        this.instanceId = config.INSTANCE_ID || String(process.pid);
        this.lockName = 'cleanup';
        this.lockTtlMs = config.CLEANUP_LOCK_TTL_MS || 15 * 60 * 1000;
    }

    tryAcquireLeaderLock() {
        if (!this.db?.locks?.acquire) {
            return true;
        }
        const now = Date.now();
        const expiresAt = now + this.lockTtlMs;
        try {
            const result = this.db.locks.acquire.run(this.lockName, this.instanceId, now, expiresAt);
            return result && result.changes > 0;
        } catch (error) {
            return false;
        }
    }

    start() {
        const dailyCron = this.config.CLEANUP_DAILY_CRON;
        const weeklyCron = this.config.CLEANUP_WEEKLY_CRON;

        if (cron.validate(dailyCron)) {
            this.jobs.push(cron.schedule(dailyCron, () => this.runDailyCleanup()));
        } else {
            this.db.logs.add.run('warn', 'cleanup', 'Invalid daily cleanup cron', JSON.stringify({ dailyCron }));
        }

        if (cron.validate(weeklyCron)) {
            this.jobs.push(cron.schedule(weeklyCron, () => this.runWeeklyCleanup()));
        } else {
            this.db.logs.add.run('warn', 'cleanup', 'Invalid weekly cleanup cron', JSON.stringify({ weeklyCron }));
        }

        this.runDailyCleanup();
        this.runWeeklyCleanup();

        logger.info('Cleanup service started', { category: 'cleanup' });
        this.db.logs.add.run('info', 'cleanup', 'Cleanup service started', null);
    }

    stop() {
        this.jobs.forEach(job => job.stop());
        this.jobs = [];
        logger.info('Cleanup service stopped', { category: 'cleanup' });
    }

    runDailyCleanup() {
        if (!this.tryAcquireLeaderLock()) {
            return;
        }
        try {
            const logRetention = `-${this.config.LOG_RETENTION_DAYS} days`;
            const scriptLogRetention = `-${this.config.SCRIPT_LOG_RETENTION_DAYS} days`;

            const logResult = this.db.logs.cleanup.run(logRetention);
            const scriptLogResult = this.db.scriptLogs.cleanup.run(scriptLogRetention);
            if (this.db?.locks?.cleanupExpired) {
                this.db.locks.cleanupExpired.run(Date.now());
            }

            this.recordSummary('daily', {
                logsDeleted: logResult.changes,
                scriptLogsDeleted: scriptLogResult.changes,
                logRetentionDays: this.config.LOG_RETENTION_DAYS,
                scriptLogRetentionDays: this.config.SCRIPT_LOG_RETENTION_DAYS
            });
        } catch (error) {
            this.recordError('daily', error);
        }
    }

    runWeeklyCleanup() {
        if (!this.tryAcquireLeaderLock()) {
            return;
        }
        try {
            const cutoff = Date.now() - this.config.MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
            const messageResult = this.db.maintenance.cleanupMessages.run(cutoff);

            this.recordSummary('weekly', {
                messagesDeleted: messageResult.changes,
                messageRetentionDays: this.config.MESSAGE_RETENTION_DAYS
            });
        } catch (error) {
            this.recordError('weekly', error);
        }
    }

    recordSummary(frequency, details) {
        this.db.logs.add.run(
            'info',
            'cleanup',
            `Cleanup ${frequency} job completed`,
            JSON.stringify(details)
        );
    }

    recordError(frequency, error) {
        this.db.logs.add.run(
            'error',
            'cleanup',
            `Cleanup ${frequency} job failed`,
            JSON.stringify({ error: error.message })
        );
    }
}

function createCleanupService(db, config) {
    return new CleanupService(db, config);
}

module.exports = { createCleanupService };

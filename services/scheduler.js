/**
 * WhatsApp Web Panel - Scheduler Service
 */
const cron = require('node-cron');

class SchedulerService {
    constructor(db, whatsapp, config) {
        this.db = db;
        this.whatsapp = whatsapp;
        this.config = config;
        this.checkInterval = null;
        this.cronJobs = new Map();
    }

    setWhatsApp(whatsapp) {
        this.whatsapp = whatsapp;
    }

    buildTemplateContext(message) {
        return {
            chatId: message.chat_id || '',
            chatName: message.chat_name || '',
            time: new Date().toLocaleTimeString(),
            date: new Date().toLocaleDateString()
        };
    }

    renderTemplate(content, context) {
        if (!content) return '';
        return content.replace(/{(\w+)}/g, (match, key) => {
            if (Object.prototype.hasOwnProperty.call(context, key)) {
                return String(context[key]);
            }
            return match;
        });
    }

    resolveScheduledMessage(msg) {
        let templateContent = msg.message;
        if (msg.template_id) {
            const template = this.db.messageTemplates.getById.get(msg.template_id);
            if (template) {
                templateContent = template.content;
            }
        }
        return this.renderTemplate(templateContent, this.buildTemplateContext(msg));
    }

    start() {
        // Check for pending messages every minute
        this.checkInterval = setInterval(() => {
            this.checkPendingMessages();
        }, this.config.SCHEDULER_CHECK_INTERVAL);

        // Initial check
        this.checkPendingMessages();

        console.log('Scheduler service started');
        this.db.logs.add.run('info', 'scheduler', 'Scheduler service started', null);
    }

    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        // Stop all cron jobs
        for (const [id, job] of this.cronJobs) {
            job.stop();
        }
        this.cronJobs.clear();

        console.log('Scheduler service stopped');
    }

    async checkPendingMessages() {
        if (!this.whatsapp || !this.whatsapp.isReady()) {
            return;
        }

        try {
            const maxRetries = this.config.SCHEDULER_MAX_RETRIES || 5;
            const baseDelayMs = this.config.SCHEDULER_RETRY_BASE_MS || 60000;
            const pending = this.db.scheduled.getPending.all(maxRetries);

            for (const msg of pending) {
                try {
                    const resolvedMessage = this.resolveScheduledMessage(msg);
                    if (!resolvedMessage) {
                        throw new Error('Resolved scheduled message is empty');
                    }
                    await this.whatsapp.sendMessage(msg.chat_id, resolvedMessage);
                    this.db.scheduled.markSent.run(msg.id);

                    this.db.logs.add.run('info', 'scheduler',
                        'Scheduled message sent',
                        JSON.stringify({ id: msg.id, chatId: msg.chat_id })
                    );

                    console.log('Scheduled message sent:', msg.id);
                } catch (error) {
                    const nextRetryCount = (msg.retry_count || 0) + 1;
                    const delayMs = baseDelayMs * Math.pow(2, Math.max(nextRetryCount - 1, 0));
                    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

                    this.db.scheduled.recordFailure.run(
                        nextRetryCount,
                        nextAttemptAt,
                        error.message,
                        msg.id
                    );

                    this.db.logs.add.run('error', 'scheduler',
                        'Failed to send scheduled message',
                        JSON.stringify({
                            id: msg.id,
                            error: error.message,
                            retryCount: nextRetryCount,
                            nextAttemptAt
                        })
                    );
                    console.error('Failed to send scheduled message:', msg.id, error.message);
                }
            }
        } catch (error) {
            console.error('Scheduler check error:', error.message);
        }
    }

    // Setup recurring cron job
    setupRecurring(id, cronExpression, chatId, message, templateId, chatName) {
        if (this.cronJobs.has(id)) {
            this.cronJobs.get(id).stop();
        }

        if (!cron.validate(cronExpression)) {
            console.error('Invalid cron expression:', cronExpression);
            return false;
        }

        const job = cron.schedule(cronExpression, async () => {
            if (this.whatsapp && this.whatsapp.isReady()) {
                try {
                    const resolvedMessage = this.resolveScheduledMessage({
                        chat_id: chatId,
                        chat_name: chatName || '',
                        message,
                        template_id: templateId
                    });
                    if (!resolvedMessage) {
                        throw new Error('Resolved recurring message is empty');
                    }
                    await this.whatsapp.sendMessage(chatId, resolvedMessage);
                    this.db.logs.add.run('info', 'scheduler',
                        'Recurring message sent',
                        JSON.stringify({ id, chatId, cron: cronExpression })
                    );
                } catch (error) {
                    this.db.logs.add.run('error', 'scheduler',
                        'Failed to send recurring message',
                        JSON.stringify({ id, error: error.message })
                    );
                }
            }
        });

        this.cronJobs.set(id, job);
        return true;
    }

    removeRecurring(id) {
        if (this.cronJobs.has(id)) {
            this.cronJobs.get(id).stop();
            this.cronJobs.delete(id);
        }
    }
}

function createSchedulerService(db, whatsapp, config) {
    return new SchedulerService(db, whatsapp, config);
}

module.exports = { createSchedulerService };

/**
 * WhatsApp Web Panel - Webhook Service
 */
const axios = require('axios');

class WebhookService {
    constructor(db, config) {
        this.db = db;
        this.config = config;
        this.queue = [];
        this.processing = false;
    }

    async trigger(event, data) {
        const webhooks = this.db.webhooks.getActive.all();

        for (const webhook of webhooks) {
            const events = webhook.events.split(',').map(e => e.trim());

            if (events.includes(event) || events.includes('all')) {
                this.queue.push({ webhook, event, data });
            }
        }

        this.processQueue();
    }

    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            const { webhook, event, data } = this.queue.shift();

            try {
                const maxRetries = this.config.WEBHOOK_MAX_RETRIES || 3;
                const baseDelayMs = this.config.WEBHOOK_RETRY_BASE_MS || 1000;
                const timeoutMs = this.config.WEBHOOK_TIMEOUT || 10000;
                const payload = {
                    event,
                    timestamp: Date.now(),
                    data
                };

                const attemptResult = await this.postWithRetry(
                    webhook.url,
                    payload,
                    {
                        timeout: timeoutMs,
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Webhook-Event': event
                        }
                    },
                    maxRetries,
                    baseDelayMs
                );

                this.db.webhooks.recordSuccess.run(
                    attemptResult.status,
                    attemptResult.durationMs,
                    webhook.id
                );

                this.db.logs.add.run('info', 'webhook',
                    'Webhook triggered successfully',
                    JSON.stringify({
                        webhookId: webhook.id,
                        event,
                        url: webhook.url,
                        status: attemptResult.status,
                        durationMs: attemptResult.durationMs,
                        attempts: attemptResult.attempts
                    })
                );

            } catch (error) {
                this.db.webhooks.recordFail.run(
                    error.message,
                    error.status || 0,
                    error.durationMs || 0,
                    webhook.id
                );

                this.db.logs.add.run('error', 'webhook',
                    'Webhook failed',
                    JSON.stringify({
                        webhookId: webhook.id,
                        event,
                        url: webhook.url,
                        error: error.message,
                        status: error.status || 0,
                        durationMs: error.durationMs || 0,
                        attempts: error.attempts || 1
                    })
                );

                console.error('Webhook failed:', webhook.url, error.message);
            }
        }

        this.processing = false;
    }

    async postWithRetry(url, payload, axiosConfig, maxRetries, baseDelayMs) {
        let attempt = 0;
        let lastError = null;

        while (attempt < maxRetries) {
            attempt += 1;
            const startTime = Date.now();

            try {
                const response = await axios.post(url, payload, axiosConfig);
                return {
                    status: response.status,
                    durationMs: Date.now() - startTime,
                    attempts: attempt
                };
            } catch (error) {
                lastError = error;
                const durationMs = Date.now() - startTime;
                const status = error.response?.status || 0;

                if (attempt >= maxRetries) {
                    const finalError = new Error(error.message);
                    finalError.status = status;
                    finalError.durationMs = durationMs;
                    finalError.attempts = attempt;
                    throw finalError;
                }

                const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        const fallbackError = new Error(lastError?.message || 'Webhook failed');
        fallbackError.status = lastError?.response?.status || 0;
        fallbackError.durationMs = 0;
        fallbackError.attempts = maxRetries;
        throw fallbackError;
    }

    // Test webhook
    async test(webhookId) {
        const webhook = this.db.webhooks.getById.get(webhookId);
        if (!webhook) {
            throw new Error('Webhook not found');
        }

        const payload = {
            event: 'test',
            timestamp: Date.now(),
            data: {
                message: 'This is a test webhook'
            }
        };

        const response = await axios.post(webhook.url, payload, {
            timeout: this.config.WEBHOOK_TIMEOUT,
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Event': 'test'
            }
        });

        return {
            status: response.status,
            statusText: response.statusText
        };
    }
}

function createWebhookService(db, config) {
    return new WebhookService(db, config);
}

module.exports = { createWebhookService };

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

            const payload = {
                event,
                timestamp: Date.now(),
                data
            };

            try {
                await this.deliverWebhook(webhook, event, payload);
            } catch (error) {
                // errors are already logged in deliverWebhook
            }
        }

        this.processing = false;
    }

    async deliverWebhook(webhook, event, payload) {
        const maxRetries = this.config.WEBHOOK_MAX_RETRIES || 3;
        const baseDelayMs = this.config.WEBHOOK_RETRY_BASE_MS || 1000;
        const timeoutMs = this.config.WEBHOOK_TIMEOUT || 10000;

        try {
            const attemptResult = await this.postWithRetry(
                webhook,
                event,
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

            return attemptResult;
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
            throw error;
        }
    }

    async postWithRetry(webhook, event, payload, axiosConfig, maxRetries, baseDelayMs) {
        let attempt = 0;
        let lastError = null;
        const payloadJson = JSON.stringify(payload);

        while (attempt < maxRetries) {
            attempt += 1;
            const startTime = Date.now();

            try {
                const response = await axios.post(webhook.url, payload, axiosConfig);
                const result = {
                    status: response.status,
                    durationMs: Date.now() - startTime,
                    attempts: attempt
                };
                this.db.webhookDeliveries.create.run(
                    webhook.id,
                    event,
                    result.status,
                    result.durationMs,
                    attempt,
                    null,
                    payloadJson
                );
                return result;
            } catch (error) {
                lastError = error;
                const durationMs = Date.now() - startTime;
                const status = error.response?.status || 0;
                const errorMessage = error.message || 'Webhook failed';

                this.db.webhookDeliveries.create.run(
                    webhook.id,
                    event,
                    status,
                    durationMs,
                    attempt,
                    errorMessage,
                    payloadJson
                );

                if (attempt >= maxRetries) {
                    const finalError = new Error(errorMessage);
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

    async replayDelivery(delivery) {
        const webhook = this.db.webhooks.getById.get(delivery.webhook_id);
        if (!webhook) {
            throw new Error('Webhook not found');
        }

        let payload;
        try {
            payload = delivery.payload ? JSON.parse(delivery.payload) : null;
        } catch (error) {
            throw new Error('Payload parse error');
        }

        if (!payload) {
            throw new Error('Payload not found');
        }

        return this.deliverWebhook(webhook, delivery.event, payload);
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

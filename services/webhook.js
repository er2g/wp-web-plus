/**
 * WhatsApp Web Panel - Webhook Service
 */
const axios = require('axios');
const { logger } = require('./logger');

class WebhookService {
    constructor(db, config, metrics = null, options = {}) {
        this.db = db;
        this.config = config;
        this.metrics = metrics || null;
        this.accountId = options?.accountId || null;
        this.queue = [];
        this.inFlight = 0;
        this.pumpScheduled = false;
        this.maxConcurrency = Math.max(1, Number(config.WEBHOOK_CONCURRENCY) || 2);
        this.queueLimit = Math.max(1, Number(config.WEBHOOK_QUEUE_LIMIT) || 2000);
        this.isShuttingDown = false;
        this.shutdownPromise = null;

        this.updateGauges();
    }

    setMetrics(metrics) {
        this.metrics = metrics || null;
        this.updateGauges();
    }

    accountIdLabel() {
        return typeof this.accountId === 'string' && this.accountId ? this.accountId : 'unknown';
    }

    updateGauges() {
        const labels = { accountId: this.accountIdLabel() };
        try {
            this.metrics?.webhookQueueSize?.set?.(labels, this.queue.length);
        } catch (error) {}

        try {
            this.metrics?.webhookInFlight?.set?.(labels, this.inFlight);
        } catch (error) {}
    }

    async trigger(event, data, meta = null) {
        if (this.isShuttingDown) {
            this.safeCountDelivery(event, 'dropped');
            logger.warn('Webhook service is shutting down; dropping trigger', { category: 'webhook', event });
            return;
        }

        const webhooks = this.db.webhooks.getActive.all();

        for (const webhook of webhooks) {
            const events = webhook.events.split(',').map(e => e.trim());

            if (events.includes(event) || events.includes('all')) {
                if (this.queue.length >= this.queueLimit) {
                    this.safeCountDelivery(event, 'dropped');
                    try {
                        this.db.logs.add.run('warn', 'webhook', 'Webhook queue is full; dropping delivery', JSON.stringify({
                            webhookId: webhook.id,
                            event,
                            queueLimit: this.queueLimit
                        }));
                    } catch (e) {}

                    logger.warn('Webhook queue is full; dropping delivery', {
                        category: 'webhook',
                        webhookId: webhook.id,
                        event,
                        queueLimit: this.queueLimit
                    });
                    continue;
                }

                this.queue.push({ webhook, event, data, meta });
                this.updateGauges();
            }
        }

        this.schedulePump();
    }

    async shutdown({ timeoutMs = 5000 } = {}) {
        if (this.shutdownPromise) return this.shutdownPromise;
        this.isShuttingDown = true;
        this.updateGauges();

        this.shutdownPromise = new Promise((resolve, reject) => {
            const start = Date.now();
            const tick = () => {
                if (this.queue.length === 0 && this.inFlight === 0) {
                    this.updateGauges();
                    return resolve();
                }
                if (Date.now() - start >= timeoutMs) {
                    return reject(new Error('Webhook shutdown timeout'));
                }
                setTimeout(tick, 25);
            };
            tick();
        });

        this.schedulePump();
        return this.shutdownPromise;
    }

    schedulePump() {
        if (this.pumpScheduled) return;
        this.pumpScheduled = true;
        const schedule = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
        schedule(() => {
            this.pumpScheduled = false;
            this.pump();
        });
    }

    pump() {
        while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
            const item = this.queue.shift();
            this.inFlight += 1;
            this.updateGauges();
            void this.processItem(item).finally(() => {
                this.inFlight -= 1;
                this.updateGauges();
                this.schedulePump();
            });
        }
    }

    async processItem({ webhook, event, data, meta }) {
        const payload = {
            event,
            timestamp: Date.now(),
            data
        };

        if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
            payload.meta = meta;
        }

        try {
            await this.deliverWebhook(webhook, event, payload);
        } catch (error) {
            // errors are already logged in deliverWebhook
        }
    }

    safeCountDelivery(event, outcome, durationSeconds = null) {
        const eventLabel = typeof event === 'string' && event ? event : 'unknown';
        const outcomeLabel = typeof outcome === 'string' && outcome ? outcome : 'unknown';
        const labels = { event: eventLabel, outcome: outcomeLabel };

        try {
            this.metrics?.webhookDeliveriesTotal?.inc?.(labels, 1);
        } catch (error) {
            // metrics should never break webhook delivery
        }

        if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
            try {
                this.metrics?.webhookDeliveryDurationSeconds?.observe?.(labels, durationSeconds);
            } catch (error) {
                // metrics should never break webhook delivery
            }
        }
    }

    async deliverWebhook(webhook, event, payload) {
        const maxRetries = this.config.WEBHOOK_MAX_RETRIES || 3;
        const baseDelayMs = this.config.WEBHOOK_RETRY_BASE_MS || 1000;
        const timeoutMs = this.config.WEBHOOK_TIMEOUT || 10000;
        const startNs = process.hrtime.bigint();

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

            const totalDurationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            this.safeCountDelivery(event, 'success', totalDurationSeconds);

            try {
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
                logger.warn('Webhook delivery recorded with errors', {
                    category: 'webhook',
                    webhookId: webhook.id,
                    event,
                    error: error?.message || String(error)
                });
            }

            return attemptResult;
        } catch (error) {
            const totalDurationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            this.safeCountDelivery(event, 'error', totalDurationSeconds);

            try {
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
            } catch (e) {}

            logger.error('Webhook failed', {
                category: 'webhook',
                url: webhook.url,
                error: error.message
            });
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

function createWebhookService(db, config, metrics = null, options = {}) {
    return new WebhookService(db, config, metrics, options);
}

module.exports = { createWebhookService };

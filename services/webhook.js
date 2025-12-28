/**
 * WhatsApp Web Panel - Webhook Service
 */
const axios = require('axios');
const db = require('../database');
const config = require('../config');

class WebhookService {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    async trigger(event, data) {
        const webhooks = db.webhooks.getActive.all();

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
                const payload = {
                    event,
                    timestamp: Date.now(),
                    data
                };

                await axios.post(webhook.url, payload, {
                    timeout: config.WEBHOOK_TIMEOUT,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Event': event
                    }
                });

                db.webhooks.recordSuccess.run(webhook.id);

                db.logs.add.run('info', 'webhook',
                    'Webhook triggered successfully',
                    JSON.stringify({ webhookId: webhook.id, event, url: webhook.url })
                );

            } catch (error) {
                db.webhooks.recordFail.run(webhook.id);

                db.logs.add.run('error', 'webhook',
                    'Webhook failed',
                    JSON.stringify({
                        webhookId: webhook.id,
                        event,
                        url: webhook.url,
                        error: error.message
                    })
                );

                console.error('Webhook failed:', webhook.url, error.message);
            }
        }

        this.processing = false;
    }

    // Test webhook
    async test(webhookId) {
        const webhook = db.webhooks.getById.get(webhookId);
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
            timeout: config.WEBHOOK_TIMEOUT,
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

module.exports = new WebhookService();

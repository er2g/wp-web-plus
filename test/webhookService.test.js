const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebhookService } = require('../services/webhook');

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() - start >= timeoutMs) return reject(new Error('timeout'));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

test('webhook service processes deliveries concurrently', async () => {
    const db = {
        webhooks: {
            getActive: {
                all: () => [{ id: 1, events: 'message', url: 'https://example.com' }]
            }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_CONCURRENCY: 2,
        WEBHOOK_QUEUE_LIMIT: 100,
        WEBHOOK_MAX_RETRIES: 1,
        WEBHOOK_RETRY_BASE_MS: 1,
        WEBHOOK_TIMEOUT: 1000
    });

    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    service.deliverWebhook = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        completed += 1;
    };

    const deliveries = 6;
    await Promise.all(
        Array.from({ length: deliveries }, () => service.trigger('message', { ok: true }))
    );

    await waitFor(() => completed === deliveries);
    assert.equal(maxInFlight, 2);
});

test('webhook service records success metrics', async () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        webhookDeliveriesTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        webhookDeliveryDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        webhooks: {
            recordSuccess: { run: () => {} },
            recordFail: { run: () => {} }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_MAX_RETRIES: 1,
        WEBHOOK_RETRY_BASE_MS: 1,
        WEBHOOK_TIMEOUT: 1000
    }, metrics);

    service.postWithRetry = async () => ({ status: 200, durationMs: 5, attempts: 1 });

    await service.deliverWebhook({ id: 1, url: 'https://example.com' }, 'message', { ok: true });

    assert.deepEqual(calls.inc, [{ labels: { event: 'message', outcome: 'success' }, value: 1 }]);
    assert.equal(calls.observe.length, 1);
    assert.deepEqual(calls.observe[0].labels, { event: 'message', outcome: 'success' });
    assert.equal(Number.isFinite(calls.observe[0].value), true);
    assert.equal(calls.observe[0].value >= 0, true);
});

test('webhook service records error metrics', async () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        webhookDeliveriesTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        webhookDeliveryDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        webhooks: {
            recordSuccess: { run: () => {} },
            recordFail: { run: () => {} }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_MAX_RETRIES: 1,
        WEBHOOK_RETRY_BASE_MS: 1,
        WEBHOOK_TIMEOUT: 1000
    }, metrics);

    service.postWithRetry = async () => {
        throw new Error('boom');
    };

    await assert.rejects(
        () => service.deliverWebhook({ id: 1, url: 'https://example.com' }, 'message', { ok: true }),
        /boom/
    );

    assert.deepEqual(calls.inc, [{ labels: { event: 'message', outcome: 'error' }, value: 1 }]);
    assert.equal(calls.observe.length, 1);
    assert.deepEqual(calls.observe[0].labels, { event: 'message', outcome: 'error' });
    assert.equal(Number.isFinite(calls.observe[0].value), true);
    assert.equal(calls.observe[0].value >= 0, true);
});

test('webhook service records dropped metrics when queue is full', async () => {
    const calls = { inc: [] };
    const metrics = {
        webhookDeliveriesTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        }
    };

    const db = {
        webhooks: {
            getActive: {
                all: () => [{ id: 1, events: 'message', url: 'https://example.com' }]
            }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_CONCURRENCY: 1,
        WEBHOOK_QUEUE_LIMIT: 1
    }, metrics);

    service.schedulePump = () => {};
    service.queue.push({ webhook: { id: 999, events: 'message', url: 'https://example.com' }, event: 'message', data: {}, meta: null });

    await service.trigger('message', { ok: true });

    assert.deepEqual(calls.inc, [{ labels: { event: 'message', outcome: 'dropped' }, value: 1 }]);
});

test('webhook service updates gauge metrics for queue and in-flight', async () => {
    const calls = { queue: [], inFlight: [] };
    const metrics = {
        webhookQueueSize: {
            set: (labels, value) => calls.queue.push({ labels, value })
        },
        webhookInFlight: {
            set: (labels, value) => calls.inFlight.push({ labels, value })
        }
    };

    const db = {
        webhooks: {
            getActive: {
                all: () => [{ id: 1, events: 'message', url: 'https://example.com' }]
            }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_CONCURRENCY: 1,
        WEBHOOK_QUEUE_LIMIT: 100
    }, metrics, { accountId: 'a1' });

    service.deliverWebhook = async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
    };

    await service.trigger('message', { ok: true });
    await waitFor(() => calls.queue.some(call => call.value >= 1));
    await waitFor(() => calls.inFlight.some(call => call.value === 1));

    await service.shutdown({ timeoutMs: 1000 });

    const lastQueue = calls.queue.at(-1);
    const lastInFlight = calls.inFlight.at(-1);

    assert.deepEqual(lastQueue.labels, { accountId: 'a1' });
    assert.equal(lastQueue.value, 0);
    assert.deepEqual(lastInFlight.labels, { accountId: 'a1' });
    assert.equal(lastInFlight.value, 0);
});

test('webhook service shutdown drains queued deliveries', async () => {
    const db = {
        webhooks: {
            getActive: {
                all: () => [{ id: 1, events: 'message', url: 'https://example.com' }]
            }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_CONCURRENCY: 1,
        WEBHOOK_QUEUE_LIMIT: 100
    });

    let completed = 0;
    service.deliverWebhook = async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        completed += 1;
    };

    await service.trigger('message', { ok: true });
    await service.trigger('message', { ok: true });

    await service.shutdown({ timeoutMs: 1000 });
    assert.equal(completed, 2);
});

test('webhook service drops triggers after shutdown begins', async () => {
    const calls = { inc: [] };
    const metrics = {
        webhookDeliveriesTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        }
    };

    const db = {
        webhooks: {
            getActive: {
                all: () => [{ id: 1, events: 'message', url: 'https://example.com' }]
            }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const service = createWebhookService(db, {
        WEBHOOK_CONCURRENCY: 1,
        WEBHOOK_QUEUE_LIMIT: 100
    }, metrics);

    let completed = 0;
    service.deliverWebhook = async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        completed += 1;
    };

    await service.trigger('message', { ok: true });

    const shutdownPromise = service.shutdown({ timeoutMs: 1000 });
    await service.trigger('message', { ok: true });
    await shutdownPromise;

    assert.equal(completed, 1);
    assert.deepEqual(calls.inc, [{ labels: { event: 'message', outcome: 'dropped' }, value: 1 }]);
});

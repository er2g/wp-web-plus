const test = require('node:test');
const assert = require('node:assert/strict');

const { createSchedulerService } = require('../services/scheduler');
const { createCleanupService } = require('../services/cleanup');

test('scheduler tick records background job metrics', async () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        backgroundJobRunsTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        backgroundJobDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        scheduled: {
            getRecurring: { all: () => [] },
            getPending: { all: () => [] }
        }
    };

    const whatsapp = { isReady: () => true };

    const scheduler = createSchedulerService(db, whatsapp, {}, metrics, { accountId: 'a1' });
    await scheduler.tick();

    assert.deepEqual(calls.inc, [
        { labels: { accountId: 'a1', job: 'scheduler.tick', outcome: 'success' }, value: 1 }
    ]);
    assert.equal(calls.observe.length, 1);
    assert.deepEqual(calls.observe[0].labels, { accountId: 'a1', job: 'scheduler.tick', outcome: 'success' });
    assert.equal(Number.isFinite(calls.observe[0].value), true);
    assert.equal(calls.observe[0].value >= 0, true);
});

test('scheduler tick records skipped outcome when lock not acquired', async () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        backgroundJobRunsTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        backgroundJobDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        locks: {
            acquire: { run: () => ({ changes: 0 }) }
        }
    };

    const whatsapp = { isReady: () => true };

    const scheduler = createSchedulerService(db, whatsapp, {}, metrics, { accountId: 'a1' });
    await scheduler.tick();

    assert.deepEqual(calls.inc, [
        { labels: { accountId: 'a1', job: 'scheduler.tick', outcome: 'skipped' }, value: 1 }
    ]);
    assert.equal(calls.observe.length, 0);
});

test('cleanup daily run records background job metrics', () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        backgroundJobRunsTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        backgroundJobDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        logs: {
            cleanup: { run: () => ({ changes: 1 }) },
            add: { run: () => {} }
        },
        scriptLogs: {
            cleanup: { run: () => ({ changes: 2 }) }
        }
    };

    const cleanup = createCleanupService(db, {
        LOG_RETENTION_DAYS: 7,
        SCRIPT_LOG_RETENTION_DAYS: 30
    }, metrics, { accountId: 'a1' });

    cleanup.runDailyCleanup();

    assert.deepEqual(calls.inc, [
        { labels: { accountId: 'a1', job: 'cleanup.daily', outcome: 'success' }, value: 1 }
    ]);
    assert.equal(calls.observe.length, 1);
    assert.deepEqual(calls.observe[0].labels, { accountId: 'a1', job: 'cleanup.daily', outcome: 'success' });
    assert.equal(Number.isFinite(calls.observe[0].value), true);
    assert.equal(calls.observe[0].value >= 0, true);
});

test('cleanup weekly run records skipped outcome when lock not acquired', () => {
    const calls = { inc: [], observe: [] };
    const metrics = {
        backgroundJobRunsTotal: {
            inc: (labels, value) => calls.inc.push({ labels, value })
        },
        backgroundJobDurationSeconds: {
            observe: (labels, value) => calls.observe.push({ labels, value })
        }
    };

    const db = {
        locks: {
            acquire: { run: () => ({ changes: 0 }) }
        },
        maintenance: {
            cleanupMessages: { run: () => ({ changes: 0 }) }
        },
        logs: {
            add: { run: () => {} }
        }
    };

    const cleanup = createCleanupService(db, { MESSAGE_RETENTION_DAYS: 7 }, metrics, { accountId: 'a1' });
    cleanup.runWeeklyCleanup();

    assert.deepEqual(calls.inc, [
        { labels: { accountId: 'a1', job: 'cleanup.weekly', outcome: 'skipped' }, value: 1 }
    ]);
    assert.equal(calls.observe.length, 0);
});


const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessagePipeline } = require('../services/messagePipeline');

test('message pipeline runs all tasks for incoming messages', async () => {
    const calls = [];
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => calls.push('autoReply') },
        webhook: { trigger: async (event) => calls.push(`webhook:${event}`) },
        scriptRunner: { processMessage: async () => calls.push('scriptRunner') },
        logger: { error: () => {} }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: false,
        accountId: 'a1'
    });

    assert.deepEqual(calls, ['autoReply', 'webhook:message', 'scriptRunner']);
});

test('message pipeline skips autoReply for outgoing messages', async () => {
    const calls = [];
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => calls.push('autoReply') },
        webhook: { trigger: async (event) => calls.push(`webhook:${event}`) },
        scriptRunner: { processMessage: async () => calls.push('scriptRunner') },
        logger: { error: () => {} }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: true,
        accountId: 'a1'
    });

    assert.deepEqual(calls, ['webhook:message', 'scriptRunner']);
});

test('message pipeline continues when a task fails', async () => {
    const calls = [];
    const errors = [];
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => calls.push('autoReply') },
        webhook: { trigger: async () => { throw new Error('fail'); } },
        scriptRunner: { processMessage: async () => calls.push('scriptRunner') },
        logger: { error: (msg, meta) => errors.push({ msg, meta }) }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: false,
        accountId: 'a1'
    });

    assert.deepEqual(calls, ['autoReply', 'scriptRunner']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].meta.task, 'webhook');
    assert.equal(errors[0].meta.messageId, 'm1');
});

test('message pipeline increments metrics when provided', async () => {
    const messages = [];
    const tasks = [];
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => {} },
        webhook: { trigger: async () => {} },
        scriptRunner: { processMessage: async () => {} },
        logger: { error: () => {} },
        metrics: {
            messagePipelineMessagesTotal: { inc: (labels) => messages.push(labels) },
            messagePipelineTaskTotal: { inc: (labels) => tasks.push(labels) }
        }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: false,
        accountId: 'a1'
    });

    assert.deepEqual(messages, [{ direction: 'incoming' }]);
    assert.deepEqual(tasks, [
        { task: 'autoReply', outcome: 'success' },
        { task: 'webhook', outcome: 'success' },
        { task: 'scriptRunner', outcome: 'success' }
    ]);
});

test('message pipeline observes duration metrics when provided', async () => {
    const pipelineDurations = [];
    const taskDurations = [];
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => {} },
        webhook: { trigger: async () => {} },
        scriptRunner: { processMessage: async () => {} },
        logger: { error: () => {} },
        metrics: {
            messagePipelineDurationSeconds: {
                observe: (labels, value) => pipelineDurations.push({ labels, value })
            },
            messagePipelineTaskDurationSeconds: {
                observe: (labels, value) => taskDurations.push({ labels, value })
            }
        }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: false,
        accountId: 'a1'
    });

    assert.equal(pipelineDurations.length, 1);
    assert.deepEqual(pipelineDurations[0].labels, { direction: 'incoming' });
    assert.equal(Number.isFinite(pipelineDurations[0].value), true);
    assert.equal(pipelineDurations[0].value >= 0, true);

    assert.equal(taskDurations.length, 3);
    assert.deepEqual(taskDurations.map(entry => entry.labels), [
        { task: 'autoReply', outcome: 'success' },
        { task: 'webhook', outcome: 'success' },
        { task: 'scriptRunner', outcome: 'success' }
    ]);
    assert.equal(taskDurations.every(entry => Number.isFinite(entry.value) && entry.value >= 0), true);
});

test('message pipeline passes traceId to webhook trigger', async () => {
    let receivedMeta = null;
    const pipeline = createMessagePipeline({
        autoReply: { processMessage: async () => {} },
        webhook: { trigger: async (event, data, meta) => { receivedMeta = meta; } },
        scriptRunner: { processMessage: async () => {} },
        logger: { error: () => {} }
    });

    await pipeline.process({
        msgData: { messageId: 'm1', chatId: 'c1' },
        fromMe: false,
        accountId: 'a1'
    });

    assert.ok(receivedMeta);
    assert.equal(receivedMeta.accountId, 'a1');
    assert.equal(typeof receivedMeta.traceId, 'string');
    assert.ok(receivedMeta.traceId.length > 0);
});

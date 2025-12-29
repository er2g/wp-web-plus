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

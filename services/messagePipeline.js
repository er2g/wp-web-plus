const { randomUUID, randomBytes } = require('crypto');
const { requestContext } = require('./logger');

function createMessagePipeline({ autoReply, webhook, scriptRunner, logger, metrics }) {
    const generateTraceId = () => (typeof randomUUID === 'function' ? randomUUID() : randomBytes(16).toString('hex'));

    function safeInc(counter, labels) {
        try {
            counter?.inc?.(labels, 1);
        } catch (error) {
            // metrics should never break message handling
        }
    }

    function safeObserve(histogram, labels, value) {
        try {
            histogram?.observe?.(labels, value);
        } catch (error) {
            // metrics should never break message handling
        }
    }

    function countMessage(direction) {
        safeInc(metrics?.messagePipelineMessagesTotal, { direction });
    }

    function countTask(task, outcome) {
        safeInc(metrics?.messagePipelineTaskTotal, { task, outcome });
    }

    async function runSafely(taskName, fn, meta) {
        if (typeof fn !== 'function') {
            countTask(taskName, 'skipped');
            return;
        }
        const startNs = process.hrtime.bigint();
        try {
            await fn();
            countTask(taskName, 'success');
            const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            safeObserve(metrics?.messagePipelineTaskDurationSeconds, { task: taskName, outcome: 'success' }, durationSeconds);
        } catch (error) {
            countTask(taskName, 'error');
            const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
            safeObserve(metrics?.messagePipelineTaskDurationSeconds, { task: taskName, outcome: 'error' }, durationSeconds);
            logger?.error?.('Message pipeline task failed', {
                ...meta,
                task: taskName,
                error: error?.message || String(error)
            });
        }
    }

    async function processMessage({ msgData, fromMe, accountId }) {
        if (!msgData) return;
        const traceId = generateTraceId();
        const direction = fromMe ? 'outgoing' : 'incoming';
        return requestContext.run({ requestId: traceId }, async () => {
            const pipelineStartNs = process.hrtime.bigint();
            countMessage(direction);
            const meta = {
                category: 'message_pipeline',
                traceId,
                accountId,
                messageId: msgData.messageId,
                chatId: msgData.chatId
            };

            try {
                if (!fromMe) {
                    await runSafely('autoReply', () => autoReply?.processMessage?.(msgData), meta);
                } else {
                    countTask('autoReply', 'skipped');
                }

                await runSafely('webhook', () => webhook?.trigger?.('message', msgData, { traceId, accountId }), meta);
                await runSafely('scriptRunner', () => scriptRunner?.processMessage?.(msgData), meta);
            } finally {
                const durationSeconds = Number(process.hrtime.bigint() - pipelineStartNs) / 1e9;
                safeObserve(metrics?.messagePipelineDurationSeconds, { direction }, durationSeconds);
            }
        });
    }

    function schedule(args) {
        const run = () => {
            void processMessage(args);
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }

    return { process: processMessage, schedule };
}

module.exports = { createMessagePipeline };

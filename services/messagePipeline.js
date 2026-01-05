const { randomUUID, randomBytes } = require('crypto');
const { requestContext } = require('./logger');

function createMessagePipeline({ autoReply, webhook, scriptRunner, logger, metrics, options } = {}) {
    const generateTraceId = () => (typeof randomUUID === 'function' ? randomUUID() : randomBytes(16).toString('hex'));
    options = options && typeof options === 'object' ? options : {};
    const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 4;
    const queueLimit = Number(options.queueLimit) > 0 ? Number(options.queueLimit) : 2000;
    const pending = [];
    let inFlight = 0;
    let drainScheduled = false;

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

    function scheduleDrain() {
        if (drainScheduled) return;
        drainScheduled = true;
        const run = () => {
            drainScheduled = false;
            while (inFlight < concurrency && pending.length) {
                const job = pending.shift();
                if (!job) continue;
                inFlight += 1;
                Promise.resolve()
                    .then(() => processMessage(job.args))
                    .then(() => job.onDone && job.onDone(null))
                    .catch((error) => job.onDone && job.onDone(error))
                    .finally(() => {
                        inFlight -= 1;
                        scheduleDrain();
                    });
            }
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }

    function enqueue(args, { onDone } = {}) {
        if (pending.length >= queueLimit) {
            try {
                logger?.warn?.('Message pipeline queue full; dropping message', {
                    category: 'message_pipeline',
                    queueLimit,
                    pending: pending.length,
                    messageId: args?.msgData?.messageId,
                    chatId: args?.msgData?.chatId
                });
            } catch (e) {}
            if (typeof onDone === 'function') {
                onDone(new Error('Message pipeline queue full'));
            }
            return false;
        }

        pending.push({ args, onDone: typeof onDone === 'function' ? onDone : null });
        scheduleDrain();
        return true;
    }

    function schedule(args) {
        enqueue(args);
    }

    return { process: processMessage, schedule, enqueue };
}

module.exports = { createMessagePipeline };

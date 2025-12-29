function createMessagePipeline({ autoReply, webhook, scriptRunner, logger, metrics }) {
    function safeInc(counter, labels) {
        try {
            counter?.inc?.(labels, 1);
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
        try {
            await fn();
            countTask(taskName, 'success');
        } catch (error) {
            countTask(taskName, 'error');
            logger?.error?.('Message pipeline task failed', {
                ...meta,
                task: taskName,
                error: error?.message || String(error)
            });
        }
    }

    async function process({ msgData, fromMe, accountId }) {
        if (!msgData) return;
        countMessage(fromMe ? 'outgoing' : 'incoming');
        const meta = {
            category: 'message_pipeline',
            accountId,
            messageId: msgData.messageId,
            chatId: msgData.chatId
        };

        if (!fromMe) {
            await runSafely('autoReply', () => autoReply?.processMessage?.(msgData), meta);
        } else {
            countTask('autoReply', 'skipped');
        }

        await runSafely('webhook', () => webhook?.trigger?.('message', msgData), meta);
        await runSafely('scriptRunner', () => scriptRunner?.processMessage?.(msgData), meta);
    }

    function schedule(args) {
        const run = () => {
            void process(args);
        };

        if (typeof setImmediate === 'function') {
            setImmediate(run);
        } else {
            setTimeout(run, 0);
        }
    }

    return { process, schedule };
}

module.exports = { createMessagePipeline };

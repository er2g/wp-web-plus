const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    const msgStats = req.account.db.messages.getStats.get() || { total: 0, sent: 0, received: 0, today: 0 };
    const autoReplies = req.account.db.autoReplies.getAll.all();
    const scheduled = req.account.db.scheduled.getAll.all();
    const webhooks = req.account.db.webhooks.getAll.all();
    const scripts = req.account.db.scripts.getAll.all();

    res.json({
        messages: msgStats,
        autoReplies: {
            total: autoReplies.length,
            active: autoReplies.filter(r => r.is_active).length,
            totalReplies: autoReplies.reduce((sum, r) => sum + r.reply_count, 0)
        },
        scheduled: {
            total: scheduled.length,
            pending: scheduled.filter(s => !s.is_sent).length
        },
        webhooks: {
            total: webhooks.length,
            active: webhooks.filter(w => w.is_active).length
        },
        scripts: {
            total: scripts.length,
            active: scripts.filter(s => s.is_active).length,
            totalRuns: scripts.reduce((sum, s) => sum + s.run_count, 0)
        }
    });
});

module.exports = router;


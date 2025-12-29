const express = require('express');
const router = express.Router();

const { parseDateRange } = require('../../lib/apiValidation');
const { sendError } = require('../../lib/httpResponses');

router.get('/overview', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return sendError(req, res, 400, 'Invalid date range');
    }
    const limit = Math.min(parseInt(req.query.limit) || 5, 25);

    const overview = req.account.db.reports.getOverview.get(range.start, range.end) || {
        total: 0,
        sent: 0,
        received: 0,
        active_chats: 0
    };
    const topChats = req.account.db.reports.getTopChats.all(range.start, range.end, limit);

    return res.json({
        range,
        overview,
        topChats
    });
});

router.get('/trends', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return sendError(req, res, 400, 'Invalid date range');
    }

    const interval = (req.query.interval || 'daily').toLowerCase();
    const points = interval === 'weekly'
        ? req.account.db.reports.getWeeklyTrend.all(range.start, range.end)
        : req.account.db.reports.getDailyTrend.all(range.start, range.end);

    return res.json({
        range,
        interval: interval === 'weekly' ? 'weekly' : 'daily',
        points
    });
});

router.get('/response-time', (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
        return sendError(req, res, 400, 'Invalid date range');
    }
    const limit = Math.min(parseInt(req.query.limit) || 5, 25);
    const interval = (req.query.interval || 'daily').toLowerCase();

    const summary = req.account.db.reports.getResponseTimeSummary.get(range.start, range.end) || {
        responses: 0,
        avg_ms: null,
        min_ms: null,
        max_ms: null
    };
    const byChat = req.account.db.reports.getResponseTimeByChat.all(range.start, range.end, limit);
    const trend = interval === 'weekly'
        ? req.account.db.reports.getResponseTimeTrendWeekly.all(range.start, range.end)
        : req.account.db.reports.getResponseTimeTrendDaily.all(range.start, range.end);

    return res.json({
        range,
        interval: interval === 'weekly' ? 'weekly' : 'daily',
        summary,
        byChat,
        trend
    });
});

module.exports = router;

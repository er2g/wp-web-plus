const express = require('express');
const router = express.Router();
const { z } = require('zod');

const { validate } = require('../middleware/validate');
const { optionalQueryInt, queryLimit, queryString } = require('../../lib/zodHelpers');

function computeRange({ start, end }) {
    const now = Date.now();
    const resolvedEnd = end ?? now;
    const resolvedStart = start ?? resolvedEnd - 7 * 24 * 60 * 60 * 1000;
    return {
        start: Math.floor(resolvedStart),
        end: Math.floor(resolvedEnd)
    };
}

const intervalQuerySchema = queryString({ defaultValue: 'daily', maxLength: 16, trim: true })
    .transform((value) => {
        const normalized = value.toLowerCase();
        return normalized === 'weekly' ? 'weekly' : 'daily';
    });

const overviewQuerySchema = z.object({
    start: optionalQueryInt(),
    end: optionalQueryInt(),
    limit: queryLimit({ defaultValue: 5, max: 25 })
})
    .transform(({ start, end, limit }) => ({ range: computeRange({ start, end }), limit }))
    .refine(({ range }) => range.start <= range.end, {
        message: 'Invalid date range',
        path: ['range', 'start']
    });

const trendsQuerySchema = z.object({
    start: optionalQueryInt(),
    end: optionalQueryInt(),
    interval: intervalQuerySchema
})
    .transform(({ start, end, interval }) => ({ range: computeRange({ start, end }), interval }))
    .refine(({ range }) => range.start <= range.end, {
        message: 'Invalid date range',
        path: ['range', 'start']
    });

const responseTimeQuerySchema = z.object({
    start: optionalQueryInt(),
    end: optionalQueryInt(),
    limit: queryLimit({ defaultValue: 5, max: 25 }),
    interval: intervalQuerySchema
})
    .transform(({ start, end, limit, interval }) => ({
        range: computeRange({ start, end }),
        limit,
        interval
    }))
    .refine(({ range }) => range.start <= range.end, {
        message: 'Invalid date range',
        path: ['range', 'start']
    });

router.get('/overview', validate({ query: overviewQuerySchema }), (req, res) => {
    const { range, limit } = req.validatedQuery;

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

router.get('/trends', validate({ query: trendsQuerySchema }), (req, res) => {
    const { range, interval } = req.validatedQuery;
    const points = interval === 'weekly'
        ? req.account.db.reports.getWeeklyTrend.all(range.start, range.end)
        : req.account.db.reports.getDailyTrend.all(range.start, range.end);

    return res.json({
        range,
        interval,
        points
    });
});

router.get('/response-time', validate({ query: responseTimeQuerySchema }), (req, res) => {
    const { range, limit, interval } = req.validatedQuery;

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
        interval,
        summary,
        byChat,
        trend
    });
});

module.exports = router;

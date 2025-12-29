const express = require('express');
const router = express.Router();

const { LIMITS } = require('../../lib/apiValidation');

router.get('/', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, LIMITS.PAGINATION.MESSAGES);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const messages = req.account.db.messages.getAll.all(limit, offset);
    const chatIds = Array.from(new Set(messages.map(message => message.chat_id).filter(Boolean)));
    if (!chatIds.length) {
        return res.json({ messages, tagsByChat: {}, notesByChat: {} });
    }

    const placeholders = chatIds.map(() => '?').join(',');
    const tagRows = req.account.db.db.prepare(`
        SELECT contact_tags.chat_id, tags.id, tags.name, tags.color
        FROM contact_tags
        JOIN tags ON tags.id = contact_tags.tag_id
        WHERE contact_tags.chat_id IN (${placeholders})
        ORDER BY tags.name ASC
    `).all(...chatIds);
    const noteRows = req.account.db.db.prepare(`
        SELECT id, chat_id, content, created_at, updated_at
        FROM notes
        WHERE chat_id IN (${placeholders})
        ORDER BY created_at DESC
    `).all(...chatIds);

    const tagsByChat = {};
    tagRows.forEach(row => {
        if (!tagsByChat[row.chat_id]) {
            tagsByChat[row.chat_id] = [];
        }
        tagsByChat[row.chat_id].push({ id: row.id, name: row.name, color: row.color });
    });

    const notesByChat = {};
    noteRows.forEach(note => {
        if (!notesByChat[note.chat_id]) {
            notesByChat[note.chat_id] = [];
        }
        notesByChat[note.chat_id].push(note);
    });

    return res.json({ messages, tagsByChat, notesByChat });
});

router.get('/search', (req, res) => {
    const query = (req.query.q || '').substring(0, LIMITS.QUERY_LENGTH);
    if (!query) return res.json([]);
    return res.json(req.account.db.messages.search.all('%' + query + '%'));
});

module.exports = router;


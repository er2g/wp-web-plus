const express = require('express');
const router = express.Router();

const aiService = require('../../services/aiService');
const { requireRole } = require('../middleware/auth');

router.post('/generate-script', requireRole(['admin']), async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }
        const script = await aiService.generateScript(prompt);
        return res.json({ success: true, script });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

module.exports = router;


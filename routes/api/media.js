const express = require('express');
const router = express.Router();

const fs = require('fs');
const path = require('path');

router.get('/:filename', (req, res) => {
    const filename = req.params.filename;

    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') ||
        filename.includes('\0') || filename.includes('%') || filename.includes(':')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }

    if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename characters' });
    }

    const filePath = path.join(req.account.config.MEDIA_DIR, filename);

    const resolvedPath = path.resolve(filePath);
    const resolvedMediaDir = path.resolve(req.account.config.MEDIA_DIR);
    if (!resolvedPath.startsWith(resolvedMediaDir + path.sep)) {
        return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    return res.sendFile(filePath);
});

module.exports = router;


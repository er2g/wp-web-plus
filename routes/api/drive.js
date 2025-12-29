const express = require('express');
const router = express.Router();

const fs = require('fs');

const { createAccountUpload } = require('../middleware/upload');
const { sendError } = require('../../lib/httpResponses');

const upload = createAccountUpload();

router.get('/status', (req, res) => {
    return res.json(req.account.drive.getStatus());
});

router.post('/migrate', async (req, res) => {
    try {
        const drive = req.account.drive;
        const initialized = await drive.initialize();

        if (!initialized) {
            return res.json({
                success: false,
                error: 'Drive not configured. Please upload OAuth credentials to ' + req.account.config.DATA_DIR
            });
        }

        const result = await drive.migrateExistingFiles(req.account.config.MEDIA_DIR, req.account.db.db);
        return res.json({
            success: true,
            migrated: result.migrated,
            failed: result.failed
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message,
            requestId: req.requestId || null
        });
    }
});

router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return sendError(req, res, 400, 'No file uploaded');
    }

    try {
        const drive = req.account.drive;
        const initialized = await drive.initialize();

        if (!initialized) {
            return sendError(req, res, 400, 'Drive not configured');
        }

        const result = await drive.uploadFile(req.file.path, req.file.mimetype);

        fs.unlinkSync(req.file.path);

        return res.json({
            success: true,
            fileId: result.id,
            downloadLink: result.downloadLink,
            viewLink: result.viewLink
        });
    } catch (error) {
        return sendError(req, res, 500, error.message);
    }
});

module.exports = router;

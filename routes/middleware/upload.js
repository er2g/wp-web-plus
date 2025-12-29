const fs = require('fs');
const multer = require('multer');

const { LIMITS } = require('../../lib/apiValidation');

function createAccountUpload({ fileSizeBytes = LIMITS.FILE_SIZE_BYTES } = {}) {
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const mediaDir = req.account?.config?.MEDIA_DIR;
            if (!mediaDir) {
                return cb(new Error('Account media directory not available'));
            }
            if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
            }
            cb(null, mediaDir);
        },
        filename: (req, file, cb) => {
            const original = typeof file.originalname === 'string' ? file.originalname : 'upload';
            const safeName = original.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            cb(null, Date.now() + '-' + safeName);
        }
    });

    return multer({ storage, limits: { fileSize: fileSizeBytes } });
}

module.exports = { createAccountUpload };


const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

const config = require('../config');

let s3Client = null;

function ensureS3Configured() {
    if (!config.S3?.BUCKET) {
        throw new Error('S3_BUCKET is required');
    }
    if (!config.S3?.REGION && !config.S3?.ENDPOINT) {
        throw new Error('S3_REGION is required (or use S3_ENDPOINT for S3-compatible storage)');
    }
    if (!config.S3?.ACCESS_KEY_ID || !config.S3?.SECRET_ACCESS_KEY) {
        throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required');
    }
}

function getS3Client() {
    if (s3Client) return s3Client;
    ensureS3Configured();

    const clientConfig = {
        region: config.S3.REGION || 'us-east-1',
        credentials: {
            accessKeyId: config.S3.ACCESS_KEY_ID,
            secretAccessKey: config.S3.SECRET_ACCESS_KEY
        },
        forcePathStyle: Boolean(config.S3.FORCE_PATH_STYLE)
    };

    if (config.S3.ENDPOINT) {
        clientConfig.endpoint = config.S3.ENDPOINT;
    }

    s3Client = new S3Client(clientConfig);
    return s3Client;
}

function resolveProvider({ settingsProvider } = {}) {
    const provider = String(config.MEDIA_STORAGE_PROVIDER || 'auto').toLowerCase();
    if (provider === 'auto') {
        const resolved = settingsProvider?.();
        return resolved || 'local';
    }
    return provider;
}

function safeBasename(filePath) {
    const base = path.basename(filePath || '');
    if (!base) return crypto.randomBytes(8).toString('hex');
    return base.replace(/[^\\p{L}\\p{N} _.-]/gu, '_').slice(0, 160) || crypto.randomBytes(8).toString('hex');
}

class MediaStorage {
    constructor({ accountId, drive, settingsProvider } = {}) {
        this.accountId = accountId || 'default';
        this.drive = drive || null;
        this.settingsProvider = settingsProvider || null;
    }

    async storeFromLocalPath(localPath, mimeType) {
        const provider = resolveProvider({ settingsProvider: this.settingsProvider });

        if (provider === 'local') {
            const filename = path.basename(localPath || '');
            return { mediaPath: localPath, mediaUrl: `api/media/${encodeURIComponent(filename)}` };
        }

        if (provider === 'drive') {
            if (!this.drive) throw new Error('Drive not available');
            const initialized = await this.drive.initialize();
            if (!initialized) throw new Error('Drive not configured');
            const result = await this.drive.uploadFile(localPath, mimeType);
            try { fs.unlinkSync(localPath); } catch (e) {}
            return { mediaPath: null, mediaUrl: result.proxyUrl || result.downloadLink };
        }

        if (provider === 's3') {
            const client = getS3Client();
            const key = `media/${this.accountId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBasename(localPath)}`;
            const body = fs.createReadStream(localPath);
            await client.send(new PutObjectCommand({
                Bucket: config.S3.BUCKET,
                Key: key,
                Body: body,
                ContentType: mimeType || 'application/octet-stream'
            }));
            try { fs.unlinkSync(localPath); } catch (e) {}
            return { mediaPath: null, mediaUrl: `api/media/s3/${encodeURIComponent(key)}` };
        }

        throw new Error('Unsupported media storage provider');
    }
}

async function getS3ObjectStream(key) {
    const decoded = decodeURIComponent(String(key || '').trim());
    if (!decoded) throw new Error('Missing S3 key');
    const client = getS3Client();
    const result = await client.send(new GetObjectCommand({ Bucket: config.S3.BUCKET, Key: decoded }));
    return {
        stream: result.Body,
        contentType: result.ContentType || 'application/octet-stream'
    };
}

module.exports = { MediaStorage, getS3ObjectStream };

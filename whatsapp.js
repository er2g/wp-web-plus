/**
 * WhatsApp Web Panel - WhatsApp Client Module v5 (Optimized)
 * Fast sync with batching, caching, and parallel processing
 */
const { Client, LocalAuth, MessageMedia, Message } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const mime = require('mime-types');

const CONSTANTS = {
    SYNC_DELAY_MS: 2000,
    DEFAULT_MAX_RETRIES: 5,
    DEFAULT_DOWNLOAD_TIMEOUT_MS: 300000,
    SYNC_DOWNLOAD_TIMEOUT_MS: 60000,
    SYNC_MAX_RETRIES: 3,
    BACKOFF_MULTIPLIER_MS: 1000,
    MEDIA_URL_PREFIX: 'api/media/',
    PARALLEL_CHATS: 1,
    PROGRESS_THROTTLE_MS: 500,
    SYNC_CHAT_MAX_RETRIES: 3,
    SYNC_CHAT_BACKOFF_BASE_MS: 1500,
    SYNC_CHAT_BACKOFF_MAX_MS: 15000,
    FULL_SYNC_LOCK_TTL_MS: 5 * 60 * 1000,
    FULL_SYNC_LOCK_RENEW_MS: 30 * 1000,
    FULL_SYNC_CHAT_CONCURRENCY: 1,
    FULL_SYNC_MEDIA_CONCURRENCY: 2,
    FULL_SYNC_PROFILE_CONCURRENCY: 2,
    FULL_SYNC_PAGE_LIMIT: 250,
    FULL_SYNC_MAX_MEDIA_ATTEMPTS: 5,
    FULL_SYNC_MAX_PROFILE_ATTEMPTS: 5
};

class WhatsAppClient {
    constructor(config, db, drive) {
        this.config = config;
        this.db = db;
        this.drive = drive;
        this.client = null;
        this.qrCode = null;
        this.status = 'disconnected';
        this.info = null;
        this.io = null;
        this.socketRoom = null;
        this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
        this.lastError = null;
        this.initPromise = null;
        this.settings = {
            downloadMedia: true,
            downloadProfilePictures: false,
            syncOnConnect: true,
            maxMessagesPerChat: 1000,
            uploadToDrive: true,
            downloadMediaOnSync: true,
            ghostMode: false
        };
        this.loadSettingsFromDb();
        this.contactCache = new Map();
        this.chatProfileCache = new Map();
        this.contactProfilePicCache = new Map(); // contactId -> { url, fetchedAt }
        this.lastProgressEmit = 0;
        this.fullSyncPromise = null;
        this.fullSyncRunId = null;
        this.fullSyncLockOwner = null;
        this.fullSyncLockTimer = null;

        this.mediaQueue = [];
        this.mediaQueueIds = new Set();
        this.mediaQueueRunning = false;

        this.profilePicQueue = [];
        this.profilePicQueueIds = new Set();
        this.profilePicQueueRunning = false;

        this.chatCatchupAttempts = new Map(); // chatId -> lastAttemptMs
    }

    getWhatsAppMediaKeyInfoString(type) {
        switch (type) {
            case 'image':
            case 'sticker':
                return 'WhatsApp Image Keys';
            case 'video':
                return 'WhatsApp Video Keys';
            case 'audio':
            case 'ptt':
                return 'WhatsApp Audio Keys';
            case 'document':
            default:
                return 'WhatsApp Document Keys';
        }
    }

    deriveWhatsAppMediaKeys(mediaKeyBase64, type) {
        const info = this.getWhatsAppMediaKeyInfoString(type);
        const mediaKey = Buffer.from(mediaKeyBase64, 'base64');
        const salt = Buffer.alloc(32, 0);
        const expandedRaw = crypto.hkdfSync('sha256', mediaKey, salt, Buffer.from(info, 'utf8'), 112);
        const expanded = Buffer.isBuffer(expandedRaw) ? expandedRaw : Buffer.from(expandedRaw);

        return {
            iv: expanded.subarray(0, 16),
            cipherKey: expanded.subarray(16, 48),
            macKey: expanded.subarray(48, 80)
        };
    }

    async downloadDecryptFromDirectPath({ directPath, mediaKey, type, timeoutMs }) {
        if (!directPath || !mediaKey) return null;
        const url = directPath.startsWith('http')
            ? directPath
            : `https://mmg.whatsapp.net${directPath}`;

        const keys = this.deriveWhatsAppMediaKeys(mediaKey, type);

        const tmpName = `tmp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.bin`;
        const tmpPath = path.join(this.config.MEDIA_DIR, tmpName);

        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(tmpPath);
            let finished = false;

            const cleanup = (err) => {
                if (finished) return;
                finished = true;
                try { out.destroy(); } catch (e) {}
                if (err) {
                    try { fs.unlinkSync(tmpPath); } catch (e) {}
                    reject(err);
                    return;
                }
                resolve();
            };

            out.on('error', (err) => cleanup(err));

            const hmac = crypto.createHmac('sha256', keys.macKey);
            hmac.update(keys.iv);
            const decipher = crypto.createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
            let tail = Buffer.alloc(0);

            const req = https.get(url, { timeout: Math.max(5000, Number(timeoutMs) || 300000) }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    cleanup(new Error(`DirectPath download failed: HTTP ${res.statusCode}`));
                    return;
                }

                res.on('data', (chunk) => {
                    const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
                    if (data.length <= 10) {
                        tail = Buffer.from(data);
                        return;
                    }

                    const processable = data.subarray(0, data.length - 10);
                    tail = data.subarray(data.length - 10);

                    hmac.update(processable);
                    out.write(decipher.update(processable));
                });

                res.on('end', () => {
                    try {
                        if (tail.length !== 10) {
                            throw new Error(`DirectPath download failed: invalid MAC length (${tail.length})`);
                        }
                        const expectedMac = hmac.digest().subarray(0, 10);
                        if (!crypto.timingSafeEqual(tail, expectedMac)) {
                            throw new Error('DirectPath download failed: HMAC verification failed');
                        }

                        out.end(decipher.final(), () => cleanup());
                    } catch (e) {
                        cleanup(e);
                    }
                });

                res.on('error', (err) => cleanup(err));
            });

            req.on('timeout', () => {
                req.destroy(new Error('DirectPath download timed out'));
            });
            req.on('error', (err) => cleanup(err));
        });

        return tmpPath;
    }

    async tryDownloadMediaViaDirectPath(msg, timeoutMs) {
        const msgId = msg?.id?._serialized;
        if (!msgId) return null;

        let meta = null;
        try {
            meta = await this.client.pupPage.evaluate(async (msgId) => {
                const m = globalThis.Store.Msg.get(msgId) || (await globalThis.Store.Msg.getMessagesById([msgId]))?.messages?.[0];
                if (!m) return null;
                return {
                    type: m.type,
                    mimetype: m.mimetype,
                    filename: m.filename,
                    directPath: m.directPath,
                    mediaKey: m.mediaKey
                };
            }, msgId);
        } catch (e) {
            meta = null;
        }

        if (!meta?.directPath || !meta?.mediaKey) return null;

        // We only enable this path for document-like types to avoid surprises,
        // and because WhatsApp Web downloadAndMaybeDecrypt currently fails for PDFs.
        if (meta.type !== 'document') return null;

        try {
            const tmpPath = await this.downloadDecryptFromDirectPath({
                directPath: meta.directPath,
                mediaKey: meta.mediaKey,
                type: meta.type,
                timeoutMs
            });
            if (!tmpPath) return null;

            return {
                tempFilePath: tmpPath,
                data: null,
                mimetype: meta.mimetype || msg.mimetype || 'application/octet-stream',
                filename: meta.filename
            };
        } catch (e) {
            this.log('warn', 'media_debug', `DirectPath fallback failed: ${e.message}`);
            return null;
        }
    }

    normalizeSettings(input) {
        if (!input || typeof input !== 'object') return {};
        const output = {};

        if (typeof input.downloadMedia === 'boolean') output.downloadMedia = input.downloadMedia;
        if (typeof input.downloadProfilePictures === 'boolean') output.downloadProfilePictures = input.downloadProfilePictures;
        if (typeof input.syncOnConnect === 'boolean') output.syncOnConnect = input.syncOnConnect;
        if (typeof input.uploadToDrive === 'boolean') output.uploadToDrive = input.uploadToDrive;
        if (typeof input.downloadMediaOnSync === 'boolean') output.downloadMediaOnSync = input.downloadMediaOnSync;
        if (typeof input.ghostMode === 'boolean') output.ghostMode = input.ghostMode;

        if (input.maxMessagesPerChat !== undefined) {
            const parsed = parseInt(String(input.maxMessagesPerChat), 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                output.maxMessagesPerChat = Math.min(parsed, 5000);
            }
        }

        return output;
    }

    loadSettingsFromDb() {
        try {
            const row = this.db?.whatsappSettings?.get?.get();
            if (!row || !row.settings) return;
            const parsed = JSON.parse(row.settings);
            const normalized = this.normalizeSettings(parsed);
            this.settings = { ...this.settings, ...normalized };
        } catch (e) {
            // Ignore settings load errors
        }
    }

    persistSettingsToDb() {
        try {
            this.db?.whatsappSettings?.upsert?.run(JSON.stringify(this.settings));
        } catch (e) {
            // Ignore persistence errors
        }
    }

    getSenderName(contact, msg) {
        const participantId = this.getParticipantId(msg);
        const fallbackId = participantId || msg?.author || msg?.from;
        const fallback = this.extractPhoneFromId(fallbackId);
        if (!contact) return fallback;

        const rawCandidates = [
            contact.name,
            contact.pushname,
            contact.shortName,
            contact.verifiedName,
            contact.number
        ];

        const candidates = rawCandidates
            .filter((value) => value !== undefined && value !== null)
            .map((value) => String(value).trim())
            .filter(Boolean);

        if (!candidates.length) return fallback;

        const isNumericLike = (value) => /^\d{7,18}$/.test(value);
        let chosen = candidates[0];

        if (chosen && chosen.toLowerCase() === 'unknown') {
            const better = candidates.find((v) => v && v.toLowerCase() !== 'unknown');
            if (better) chosen = better;
        }

        if (chosen && isNumericLike(chosen)) {
            const better = candidates.find((v) => v && !isNumericLike(v) && v.toLowerCase() !== 'unknown');
            if (better) chosen = better;
        }

        return chosen || fallback;
    }

    getSenderNumber(contact, msg) {
        if (contact && contact.number) {
            return contact.number;
        }
        const participantId = this.getParticipantId(msg);
        const fallbackId = participantId || msg?.author || msg?.from;
        if (typeof fallbackId === 'string') {
            const server = fallbackId.split('@')[1];
            if (server === 'g.us') {
                return participantId ? this.extractPhoneFromId(participantId) : 'Unknown';
            }
            if (server && server !== 'c.us') {
                return fallbackId;
            }
        }
        return this.extractPhoneFromId(fallbackId);
    }

    extractPhoneFromId(id) {
        if (!id) return 'Unknown';
        return id.split('@')[0] || 'Unknown';
    }

    isLocalMediaUrl(url) {
        return typeof url === 'string' && url.startsWith(CONSTANTS.MEDIA_URL_PREFIX);
    }

    getProfilePictureBaseName(chatId) {
        const hash = crypto.createHash('sha1').update(String(chatId || '')).digest('hex');
        return `profile_${hash}`;
    }

    downloadUrlToBuffer(url, { timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, redirectsLeft = 3 } = {}) {
        return new Promise((resolve, reject) => {
            let resolved = false;
            const cleanup = (err, data) => {
                if (resolved) return;
                resolved = true;
                if (err) return reject(err);
                return resolve(data);
            };

            let parsed;
            try {
                parsed = new URL(url);
            } catch (e) {
                return cleanup(new Error('Invalid URL'));
            }

            if (parsed.protocol !== 'https:') {
                return cleanup(new Error('Only https URLs are allowed'));
            }

            const req = https.get(parsed, (res) => {
                const status = res.statusCode || 0;
                const location = res.headers.location;

                if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
                    res.resume();
                    let nextUrl = location;
                    try {
                        nextUrl = new URL(location, parsed).toString();
                    } catch (e) {}
                    this.downloadUrlToBuffer(nextUrl, { timeoutMs, maxBytes, redirectsLeft: redirectsLeft - 1 })
                        .then((data) => cleanup(null, data))
                        .catch((err) => cleanup(err));
                    return;
                }

                if (status < 200 || status >= 300) {
                    res.resume();
                    return cleanup(new Error(`HTTP ${status}`));
                }

                const chunks = [];
                let total = 0;
                res.on('data', (chunk) => {
                    total += chunk.length;
                    if (total > maxBytes) {
                        req.destroy(new Error('Response too large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const contentTypeRaw = res.headers['content-type'];
                    const contentType = typeof contentTypeRaw === 'string' ? contentTypeRaw : '';
                    return cleanup(null, { buffer: Buffer.concat(chunks), contentType });
                });
                res.on('error', (err) => cleanup(err));
            });

            req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
            req.on('error', (err) => cleanup(err));
        });
    }

    async downloadAndSaveProfilePicture(chatId, url) {
        if (!url) return null;
        const parsed = new URL(url);
        const hostname = parsed.hostname || '';
        if (!hostname.endsWith('whatsapp.net') && !hostname.endsWith('whatsapp.com')) {
            throw new Error('Unexpected profile picture host');
        }

        const { buffer, contentType } = await this.downloadUrlToBuffer(url, {
            timeoutMs: 15000,
            maxBytes: 2 * 1024 * 1024,
            redirectsLeft: 3
        });

        if (!buffer || buffer.length === 0) {
            throw new Error('Empty response');
        }

        const baseName = this.getProfilePictureBaseName(chatId);
        const contentTypeClean = (contentType || '').split(';')[0].trim().toLowerCase();
        let ext = mime.extension(contentTypeClean) || 'jpg';
        if (ext === 'jpeg') ext = 'jpg';
        if (!/^[a-z0-9]+$/.test(ext)) ext = 'jpg';

        fs.mkdirSync(this.config.MEDIA_DIR, { recursive: true });

        const filename = `${baseName}.${ext}`;
        const filePath = path.join(this.config.MEDIA_DIR, filename);
        const tmpPath = filePath + '.tmp';

        // Clean up older versions with different extensions.
        ['jpg', 'png', 'webp'].forEach((candidate) => {
            const candidatePath = path.join(this.config.MEDIA_DIR, `${baseName}.${candidate}`);
            if (candidatePath !== filePath && fs.existsSync(candidatePath)) {
                try { fs.unlinkSync(candidatePath); } catch (e) {}
            }
        });

        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, filePath);

        return CONSTANTS.MEDIA_URL_PREFIX + filename;
    }

    getMessageBody(msg) {
        let body = msg.body || '';
        if (!body && msg.type === 'document') {
            body = msg.filename || msg._data?.filename || '';
        }
        return body;
    }

    async getChatProfilePic(chat) {
        if (!chat || !chat.id) return null;
        const chatId = chat.id._serialized;
        if (this.chatProfileCache.has(chatId)) {
            const cached = this.chatProfileCache.get(chatId);
            if (cached && this.settings.downloadProfilePictures && !this.isLocalMediaUrl(cached)) {
                try {
                    const localUrl = await this.downloadAndSaveProfilePicture(chatId, cached);
                    if (localUrl) {
                        this.chatProfileCache.set(chatId, localUrl);
                        return localUrl;
                    }
                } catch (e) {
                    // Keep cached URL if download fails
                }
            }
            return cached;
        }
        let url = null;
        try {
            if (typeof chat.getProfilePicUrl === 'function') {
                url = await Promise.race([
                    chat.getProfilePicUrl(),
                    new Promise((resolve) => setTimeout(resolve, 10000, null))
                ]);
            }
        } catch (e) {
            url = null;
        }
        if (!url) {
            try {
                url = await Promise.race([
                    this.client.getProfilePicUrl(chatId),
                    new Promise((resolve) => setTimeout(resolve, 10000, null))
                ]);
            } catch (e) {
                url = null;
            }
        }
        if (url && this.settings.downloadProfilePictures) {
            try {
                const localUrl = await Promise.race([
                    this.downloadAndSaveProfilePicture(chatId, url),
                    new Promise((resolve) => setTimeout(resolve, 20000, null))
                ]);
                if (localUrl) {
                    this.chatProfileCache.set(chatId, localUrl);
                    return localUrl;
                }
            } catch (e) {
                // Fall back to remote URL
            }
        }

        this.chatProfileCache.set(chatId, url || null);
        return url || null;
    }

    setSocketIO(io, room) {
        this.io = io;
        this.socketRoom = room || null;
    }

    emit(event, data) {
        if (!this.io) return;
        if (this.socketRoom) {
            this.io.to(this.socketRoom).emit(event, data);
            return;
        }
        this.io.emit(event, data);
    }

    emitStatus() {
        this.emit('status', this.getStatus());
    }

    emitProgress() {
        const now = Date.now();
        if (now - this.lastProgressEmit >= CONSTANTS.PROGRESS_THROTTLE_MS) {
            this.emit('sync_progress', this.syncProgress);
            this.lastProgressEmit = now;
        }
    }

    log(level, category, message, data = null) {
        try {
            this.db.logs.add.run(level, category, message, data ? JSON.stringify(data) : null);
        } catch (e) {}
        console.log('[' + level.toUpperCase() + '] [' + category + '] ' + message);
    }

    getFullSyncConfig() {
        return {
            chatConcurrency: Number(this.config.SYNC_CHAT_CONCURRENCY) || CONSTANTS.FULL_SYNC_CHAT_CONCURRENCY,
            mediaConcurrency: Number(this.config.SYNC_MEDIA_CONCURRENCY) || CONSTANTS.FULL_SYNC_MEDIA_CONCURRENCY,
            profileConcurrency: Number(this.config.SYNC_PROFILE_CONCURRENCY) || CONSTANTS.FULL_SYNC_PROFILE_CONCURRENCY,
            pageLimit: Math.max(50, Number(this.config.SYNC_PAGE_LIMIT) || CONSTANTS.FULL_SYNC_PAGE_LIMIT),
            lockTtlMs: Number(this.config.SYNC_LOCK_TTL_MS) || CONSTANTS.FULL_SYNC_LOCK_TTL_MS,
            lockRenewMs: Number(this.config.SYNC_LOCK_RENEW_MS) || CONSTANTS.FULL_SYNC_LOCK_RENEW_MS,
            maxMediaAttempts: Number(this.config.SYNC_MAX_MEDIA_ATTEMPTS) || CONSTANTS.FULL_SYNC_MAX_MEDIA_ATTEMPTS,
            maxProfileAttempts: Number(this.config.SYNC_MAX_PROFILE_ATTEMPTS) || CONSTANTS.FULL_SYNC_MAX_PROFILE_ATTEMPTS,
            cutoffDate: this.config.SYNC_CUTOFF_DATE || null
        };
    }

    parseCutoffMs(cutoffDate) {
        if (!cutoffDate) return null;
        const parsed = Date.parse(String(cutoffDate));
        return Number.isFinite(parsed) ? parsed : null;
    }

    acquireFullSyncLock() {
        const ownerId = `${this.config.INSTANCE_ID || process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        const now = Date.now();
        const expiresAt = now + this.getFullSyncConfig().lockTtlMs;
        const result = this.db.locks.acquire.run('whatsapp_full_sync', ownerId, now, expiresAt);
        if (result.changes > 0) {
            this.fullSyncLockOwner = ownerId;
            return true;
        }
        return false;
    }

    startFullSyncLockRenewal() {
        if (!this.fullSyncLockOwner) return;
        const { lockTtlMs, lockRenewMs } = this.getFullSyncConfig();
        if (this.fullSyncLockTimer) clearInterval(this.fullSyncLockTimer);
        this.fullSyncLockTimer = setInterval(() => {
            try {
                const now = Date.now();
                const expiresAt = now + lockTtlMs;
                this.db.locks.acquire.run('whatsapp_full_sync', this.fullSyncLockOwner, now, expiresAt);
            } catch (e) {
                this.log('warn', 'sync', 'Failed to renew full sync lock: ' + e.message);
            }
        }, lockRenewMs);
    }

    releaseFullSyncLock() {
        if (this.fullSyncLockTimer) {
            clearInterval(this.fullSyncLockTimer);
            this.fullSyncLockTimer = null;
        }
        if (!this.fullSyncLockOwner) return;
        try {
            this.db.locks.release.run('whatsapp_full_sync', this.fullSyncLockOwner);
        } catch (e) {}
        this.fullSyncLockOwner = null;
    }

    enqueueMediaDownload(messageId) {
        const id = typeof messageId === 'string' ? messageId.trim() : '';
        if (!id) return false;
        if (this.mediaQueueIds.has(id)) return false;

        const maxQueue = 10000;
        if (this.mediaQueue.length >= maxQueue) {
            this.log('warn', 'media', 'Media queue is full; dropping task for ' + id);
            return false;
        }

        this.mediaQueueIds.add(id);
        this.mediaQueue.push({ messageId: id, attempts: 0 });

        // Avoid competing with heavy sync fetches; start processing after sync finishes.
        if (!this.syncProgress.syncing) {
            this.processMediaQueue();
        }
        return true;
    }

    processMediaQueue() {
        if (this.mediaQueueRunning) return;
        if (!this.mediaQueue.length) return;

        this.mediaQueueRunning = true;

        const getMessageRow = this.db.db.prepare('SELECT chat_id, media_url, timestamp FROM messages WHERE message_id = ?');
        const updateMessage = this.db.db.prepare(
            'UPDATE messages SET media_path = ?, media_url = ?, media_mimetype = ? WHERE message_id = ?'
        );

        const run = async () => {
            const warmCache = { chatId: null, fetchedAt: 0, limit: 0, messages: [] };
            const warmupFindMessage = async (chatId, messageId, limit) => {
                if (!chatId) return null;
                const now = Date.now();
                if (
                    warmCache.chatId !== chatId ||
                    !Array.isArray(warmCache.messages) ||
                    !warmCache.messages.length ||
                    (now - warmCache.fetchedAt) > 60000 ||
                    (Number(limit) || 0) > (Number(warmCache.limit) || 0)
                ) {
                    const chat = await Promise.race([
                        this.client.getChatById(chatId),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Chat fetch timeout')), 10000))
                    ]);

                    const msgs = await Promise.race([
                        chat.fetchMessages({ limit }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('fetchMessages timeout')), 30000))
                    ]);

                    warmCache.chatId = chatId;
                    warmCache.fetchedAt = now;
                    warmCache.limit = limit;
                    warmCache.messages = Array.isArray(msgs) ? msgs : [];
                }

                return warmCache.messages.find(m => m?.id?._serialized === messageId) || null;
            };

            while (this.mediaQueue.length) {
                const task = this.mediaQueue.shift();
                if (!task || !task.messageId) continue;

                const { messageId } = task;

                try {
                    if (!this.isReady()) {
                        throw new Error('WhatsApp not connected');
                    }

                    const row = getMessageRow.get(messageId);
                    if (!row) {
                        this.mediaQueueIds.delete(messageId);
                        continue;
                    }

                    if (row.media_url) {
                        this.mediaQueueIds.delete(messageId);
                        continue;
                    }

                    let msg = null;
                    try {
                        msg = await Promise.race([
                            this.client.getMessageById(messageId),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Message fetch timeout')), 10000))
                        ]);
                    } catch (e) {
                        msg = null;
                    }

                    if (!msg) {
                        try {
                            const maxWanted = Math.min(
                                Math.max(50, Number(this.settings.maxMessagesPerChat) || 1000),
                                5000
                            );
                            const warmupLimit = task.attempts >= 2
                                ? maxWanted
                                : (task.attempts >= 1 ? Math.min(1000, maxWanted) : Math.min(200, maxWanted));

                            msg = await warmupFindMessage(row.chat_id, messageId, warmupLimit);
                        } catch (e) {
                            msg = null;
                        }
                    }

                    if (!msg) {
                        throw new Error('Message not available for media download');
                    }

                    if (!msg.hasMedia) {
                        this.mediaQueueIds.delete(messageId);
                        continue;
                    }

                    const media = await this.downloadMediaWithRetry(msg, 3, CONSTANTS.DEFAULT_DOWNLOAD_TIMEOUT_MS);
                    if (!media) {
                        throw new Error('Media download returned null');
                    }

                    const ts = Number(row.timestamp) || (msg.timestamp ? msg.timestamp * 1000 : Date.now());
                    const mediaResult = await this.saveMedia(media, messageId, ts);

                    updateMessage.run(mediaResult.mediaPath, mediaResult.mediaUrl, media.mimetype, messageId);

                    this.emit('media_downloaded', {
                        messageId,
                        mediaUrl: mediaResult.mediaUrl,
                        mediaMimetype: media.mimetype
                    });

                    this.log('info', 'media', 'Media downloaded for ' + messageId);
                    this.mediaQueueIds.delete(messageId);
                } catch (err) {
                    task.attempts = (task.attempts || 0) + 1;
                    if (task.attempts <= 3) {
                        const delayMs = 2000 * task.attempts;
                        setTimeout(() => {
                            this.mediaQueue.push(task);
                            if (!this.syncProgress.syncing) {
                                this.processMediaQueue();
                            }
                        }, delayMs);
                    } else {
                        this.log('warn', 'media', 'Queued media download failed for ' + messageId + ': ' + err.message);
                        this.mediaQueueIds.delete(messageId);
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 300));
            }
        };

        run()
            .catch((err) => {
                this.log('error', 'media', 'Media queue crashed: ' + err.message);
            })
            .finally(() => {
                this.mediaQueueRunning = false;
                if (!this.syncProgress.syncing && this.mediaQueue.length) {
                    this.processMediaQueue();
                }
            });
    }

    enqueueProfilePicRefresh(chatId) {
        const id = typeof chatId === 'string' ? chatId.trim() : '';
        if (!id) return;
        if (this.profilePicQueueIds.has(id)) return;

        const maxQueue = 5000;
        if (this.profilePicQueue.length >= maxQueue) {
            return;
        }

        this.profilePicQueueIds.add(id);
        this.profilePicQueue.push({ chatId: id, attempts: 0 });
        if (!this.syncProgress.syncing) {
            this.processProfilePicQueue();
        }
    }

    processProfilePicQueue() {
        if (this.syncProgress.syncing) return;
        if (this.profilePicQueueRunning) return;
        if (!this.profilePicQueue.length) return;

        this.profilePicQueueRunning = true;

        const getChatRow = this.db.db.prepare('SELECT profile_pic FROM chats WHERE chat_id = ?');
        const updateChatPic = this.db.db.prepare(
            'UPDATE chats SET profile_pic = COALESCE(?, profile_pic), updated_at = datetime(\'now\') WHERE chat_id = ?'
        );

        const run = async () => {
            while (this.profilePicQueue.length) {
                const task = this.profilePicQueue.shift();
                if (!task || !task.chatId) continue;
                const { chatId } = task;

                try {
                    if (!this.isReady()) {
                        throw new Error('WhatsApp not connected');
                    }

                    const row = getChatRow.get(chatId);
                    if (row && row.profile_pic) {
                        this.profilePicQueueIds.delete(chatId);
                        continue;
                    }

                    let url = await Promise.race([
                        this.client.getProfilePicUrl(chatId),
                        new Promise((resolve) => setTimeout(resolve, 10000, null))
                    ]);

                    if (!url) {
                        throw new Error('No profile picture URL');
                    }

                    let resolvedUrl = url;
                    if (this.settings.downloadProfilePictures) {
                        resolvedUrl = await Promise.race([
                            this.downloadAndSaveProfilePicture(chatId, url),
                            new Promise((resolve) => setTimeout(resolve, 20000, null))
                        ]) || url;
                    }

                    updateChatPic.run(resolvedUrl, chatId);
                    this.chatProfileCache.set(chatId, resolvedUrl);

                    this.emit('chat_updated', { chatId, profilePic: resolvedUrl });
                    this.profilePicQueueIds.delete(chatId);
                } catch (err) {
                    task.attempts = (task.attempts || 0) + 1;
                    if (task.attempts <= 3) {
                        const delayMs = 2500 * task.attempts;
                        setTimeout(() => {
                            this.profilePicQueue.push(task);
                            this.processProfilePicQueue();
                        }, delayMs);
                    } else {
                        this.profilePicQueueIds.delete(chatId);
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 250));
            }
        };

        run()
            .catch((err) => {
                this.log('error', 'profile_pic', 'Profile pic queue crashed: ' + err.message);
            })
            .finally(() => {
                this.profilePicQueueRunning = false;
                if (this.profilePicQueue.length) {
                    this.processProfilePicQueue();
                }
            });
    }

    async initialize() {
        if (this.status === 'ready' || this.status === 'authenticated' || this.status === 'qr' || this.status === 'initializing') {
            return this.initPromise || undefined;
        }

        if (this.initPromise) {
            return this.initPromise;
        }

        this.lastError = null;
        this.status = 'initializing';
        this.emitStatus();

        const timeoutMs = Math.max(5000, Number(this.config.WHATSAPP_INIT_TIMEOUT_MS) || 60000);

        this.initPromise = (async () => {
            if (this.client) {
                await this.destroy();
            }

            this.client = new Client({
                authStrategy: new LocalAuth({ dataPath: this.config.SESSION_DIR }),
                puppeteer: { headless: true, args: this.config.PUPPETEER_ARGS }
            });
            this.setupEventHandlers();
            this.log('info', 'whatsapp', 'Initializing WhatsApp client...');

            await Promise.race([
                this.client.initialize(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`WhatsApp init timed out after ${timeoutMs}ms`)), timeoutMs))
            ]);
        })()
            .catch(async (error) => {
                const message = error?.message || String(error);
                try {
                    await this.destroy({ preserveError: true });
                } catch (e) {}
                this.status = 'error';
                this.lastError = message;
                this.emitStatus();
                this.emit('whatsapp_error', { message });
                this.log('error', 'whatsapp', 'Initialization failed: ' + message);
                throw error;
            })
            .finally(() => {
                this.initPromise = null;
            });

        return this.initPromise;
    }

    setupEventHandlers() {
        this.client.on('qr', async (qr) => {
            this.status = 'qr';
            this.qrCode = await qrcode.toDataURL(qr);
            this.emit('qr', this.qrCode);
            this.emitStatus();
        });

        this.client.on('ready', async () => {
            this.status = 'ready';
            this.info = this.client.info;
            this.qrCode = null;
            this.lastError = null;
            this.emit('ready', { pushname: this.info.pushname, wid: this.info.wid.user });
            this.emitStatus();
            this.log('info', 'whatsapp', 'Connected as ' + this.info.pushname);

            if (this.drive) this.drive.initialize().catch(() => {});

            if (this.settings.syncOnConnect) {
                setTimeout(() => this.fullSync(), CONSTANTS.SYNC_DELAY_MS);
            }
        });

        this.client.on('authenticated', () => {
            this.status = 'authenticated';
            this.emit('authenticated');
            this.emitStatus();
            this.log('info', 'whatsapp', 'Authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            this.status = 'auth_failure';
            this.lastError = msg ? String(msg) : 'auth_failure';
            this.emit('auth_failure', msg);
            this.emitStatus();
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            this.info = null;
            this.emit('disconnected', reason);
            this.emitStatus();
        });

        this.client.on('message', async (msg) => {
            await this.handleMessage(msg, false);
        });

        this.client.on('message_create', async (msg) => {
            if (msg.fromMe) await this.handleMessage(msg, true);
        });

        this.client.on('message_ack', async (msg, ack) => {
            try {
                this.db.messages.updateAck.run(ack, msg.id._serialized);
                this.emit('message_ack', { messageId: msg.id._serialized, ack });
            } catch (e) {
                // Ignore errors if message not found
            }
        });

        this.client.on('message_revoke_everyone', async (msg, revokedMsg) => {
            try {
                await this.handleMessageRevokeEveryone(msg, revokedMsg);
            } catch (error) {
                this.log('warn', 'message', 'Failed to handle message revoke: ' + error.message, {
                    messageId: msg?.id?._serialized || null
                });
            }
        });
    }

    async downloadMediaWithRetry(msg, maxRetries = CONSTANTS.DEFAULT_MAX_RETRIES, timeoutMs = CONSTANTS.DEFAULT_DOWNLOAD_TIMEOUT_MS) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const startTime = Date.now();
            this.log('info', 'media_debug', `Start download attempt ${attempt}/${maxRetries} for msg ${msg.id._serialized}`);
            
            try {
                // Try standard way first
                const media = await Promise.race([
                    msg.downloadMedia(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs))
                ]);

                if (media && media.data) {
                    this.log('info', 'media_debug', `Standard method SUCCESS!`);
                    return media;
                }
            } catch (e) {
                this.log('warn', 'media_debug', `Standard method failed (${e.message}). Starting NATIVE BROWSER CAPTURE...`);

                // First try: DirectPath download + Node-side decrypt (bypasses WA Web downloadAndMaybeDecrypt PDF bug)
                const directPathMedia = await this.tryDownloadMediaViaDirectPath(msg, timeoutMs);
                if (directPathMedia) {
                    this.log('info', 'media_debug', 'DirectPath fallback SUCCESS!');
                    return directPathMedia;
                }
                
                try {
                    const page = await this.client.pupPage;
                    if (page) {
                        // Use CDP to intercept download
                        const client = await page.target().createCDPSession();
                        await client.send('Browser.setDownloadBehavior', {
                            behavior: 'allow',
                            downloadPath: this.config.MEDIA_DIR,
                            eventsEnabled: true
                        });

                        // Trigger download by clicking the UI button
                        await page.evaluate((msgId) => {
                            const el = globalThis.document.querySelector(`[data-id*="${msgId}"]`);
                            if (el) {
                                const btn = el.querySelector('span[data-icon="download"]')
                                    || el.querySelector('div[role="button"]');
                                if (btn) btn.click();
                            }
                        }, msg.id._serialized);

                        this.log('info', 'media_debug', 'Native download triggered. Polling file system...');

                        // Poll for file
                        await new Promise(r => setTimeout(r, 5000)); // Wait for download start

                        // Poll loop for up to 5 minutes for large files
                        let matchedFile = null;
                        const pollStartTime = Date.now();
                        
                        while ((Date.now() - pollStartTime) < 300000) {
                            const files = fs.readdirSync(this.config.MEDIA_DIR)
                                .map(name => {
                                    const stat = fs.statSync(path.join(this.config.MEDIA_DIR, name));
                                    return { name, time: stat.mtime.getTime(), size: stat.size };
                                })
                                .sort((a, b) => b.time - a.time); // Newest first

                            // Find a file that matches criteria
                            for (const file of files) {
                                // Only consider files modified AFTER we clicked download
                                if (file.time < (startTime - 5000)) continue; // Allow some clock drift buffer
                                
                                // Ignore partial downloads (crdownload, tmp, etc)
                                if (file.name.endsWith('.crdownload') || file.name.endsWith('.tmp')) continue;

                                // 1. Extension Check
                                const ext = path.extname(file.name).toLowerCase();
                                const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
                                const isVideo = ['.mp4', '.mov'].includes(ext);
                                const isAudio = ['.mp3', '.ogg', '.wav'].includes(ext);
                                
                                if (msg.type === 'image' && !isImage && ext !== '.bin') continue;
                                if (msg.type === 'video' && !isVideo && ext !== '.bin') continue;
                                if (msg.type === 'audio' && !isAudio && ext !== '.bin') continue;
                                // Documents can be anything, but usually not .webp unless it's a sticker sent as doc
                                
                                // 2. Size Check (Critical)
                                // If msg has size info, match it with 10% tolerance or at least ensure it's not tiny
                                if (msg.size || (msg._data && msg._data.size)) {
                                    const expectedSize = msg.size || msg._data.size;
                                    const diff = Math.abs(file.size - expectedSize);
                                    if (diff > 5000000) continue; // Allow 5MB variance? Maybe too loose.
                                    // Better: if file is tiny (<10KB) and expected is huge (>1MB), ignore
                                    if (expectedSize > 1000000 && file.size < 100000) continue;
                                }

                                matchedFile = file;
                                break;
                            }

                            if (matchedFile) break;
                            await new Promise(r => setTimeout(r, 2000));
                        }

                        if (matchedFile) {
                            this.log('info', 'media_debug', 'NATIVE DOWNLOAD SUCCESS! Matched File: ' + matchedFile.name + ' Size: ' + matchedFile.size);
                            const filePath = path.join(this.config.MEDIA_DIR, matchedFile.name);
                            
                            // Detect actual mimetype from the downloaded file
                            const detectedMime = mime.lookup(matchedFile.name) || msg.mimetype || 'application/octet-stream';
                            
                            return {
                                tempFilePath: filePath,
                                data: null, 
                                mimetype: detectedMime,
                                filename: matchedFile.name
                            };
                        } else {
                             this.log('warn', 'media_debug', 'Native download timed out or no matching file found.');
                        }
                    }
                } catch (fallbackErr) {
                    this.log('error', 'media_debug', `Native fallback failed: ${fallbackErr.message}`);
                }

                if (attempt === maxRetries) {
                    this.log('error', 'media', `All methods failed for ${msg.id._serialized}`);
                }
                
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        return null;
    }

    async saveMedia(media, msgId, timestamp) {
        if (!media || (!media.data && !media.tempFilePath)) return { mediaPath: null, mediaUrl: null };
        try {
            let ext = (media.mimetype.split('/')[1] || 'bin').split(';')[0];
            
            // If extension is generic, try to get a better one from the provided filename
            if ((ext === 'bin' || ext === 'octet-stream' || ext === 'plain') && media.filename) {
                const fileExt = path.extname(media.filename).replace('.', '').toLowerCase();
                if (fileExt && fileExt.length < 10) ext = fileExt;
            }

            // Clean and shorten the ID for a prettier filename
            const cleanId = msgId.split('_').pop().replace(/[^a-zA-Z0-9]/g, '').substring(0, 12);
            const fallbackFilename = timestamp + '_' + cleanId + '.' + ext;

            const sanitizeIncomingFilename = (value) => {
                if (!value) return '';
                const raw = String(value).replace(/\\/g, '/').split('/').pop();
                if (!raw) return '';
                let normalized = raw;
                try {
                    normalized = normalized.normalize('NFKC');
                } catch (e) {}

                normalized = normalized
                    .replace(/\p{Cc}+/gu, '')
                    .trim()
                    .replace(/\s+/g, ' ')
                    .replace(/\.+/g, '.')
                    .replace(/\.{2,}/g, '.');

                normalized = normalized.replace(/[^\p{L}\p{N} _.\-()]/gu, '');
                normalized = normalized.trim();

                if (!normalized || normalized === '.' || normalized === '..') return '';

                const extFromName = path.extname(normalized);
                const baseFromName = extFromName ? normalized.slice(0, -extFromName.length) : normalized;

                let resolvedExt = extFromName;
                if (!resolvedExt) {
                    resolvedExt = '.' + String(ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 10);
                }

                if (!resolvedExt || resolvedExt === '.') {
                    resolvedExt = '.bin';
                }

                const extClean = resolvedExt.replace('.', '');
                if (!/^[a-z0-9]{1,10}$/i.test(extClean)) {
                    resolvedExt = '.' + String(ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 10) || '.bin';
                }

                let base = baseFromName.trim();
                if (!base) base = 'dosya';
                // Avoid unsafe traversal marker patterns for the /api/media route.
                base = base.replace(/\.{2,}/g, '.');

                const maxLen = 160;
                const availableBaseLen = Math.max(24, maxLen - resolvedExt.length);
                if (base.length > availableBaseLen) {
                    base = base.slice(0, availableBaseLen).trim();
                }

                const candidate = (base + resolvedExt).trim();
                if (!candidate || candidate === '.' || candidate === '..') return '';
                return candidate;
            };

            const ensureUniqueFilename = (filename) => {
                const dir = this.config.MEDIA_DIR;
                const baseExt = path.extname(filename);
                const baseName = baseExt ? filename.slice(0, -baseExt.length) : filename;
                const extName = baseExt || '';
                const basePath = path.join(dir, filename);
                if (!fs.existsSync(basePath)) return filename;

                for (let i = 2; i <= 9999; i++) {
                    const suffix = ` (${i})`;
                    const maxLen = 160;
                    const availableBaseLen = Math.max(24, maxLen - extName.length - suffix.length);
                    const trimmedBase = baseName.length > availableBaseLen ? baseName.slice(0, availableBaseLen).trim() : baseName;
                    const candidate = `${trimmedBase}${suffix}${extName}`;
                    const candidatePath = path.join(dir, candidate);
                    if (!fs.existsSync(candidatePath)) return candidate;
                }

                return fallbackFilename;
            };

            const preferredOriginal = sanitizeIncomingFilename(media.filename);
            const filename = ensureUniqueFilename(preferredOriginal || fallbackFilename);
            const localPath = path.join(this.config.MEDIA_DIR, filename);

            if (media.tempFilePath) {
                // Optimized path: Move existing file
                if (fs.existsSync(media.tempFilePath)) {
                    // Rename (move)
                    fs.renameSync(media.tempFilePath, localPath);
                } else {
                    return { mediaPath: null, mediaUrl: null };
                }
            } else {
                // Standard path: Write from base64 buffer
                fs.writeFileSync(localPath, Buffer.from(media.data, 'base64'));
            }

            if (this.settings.uploadToDrive && this.drive) {
                try {
                    if (await this.drive.initialize()) {
                        const result = await this.drive.uploadFile(localPath, media.mimetype);
                        if (result) {
                            fs.unlinkSync(localPath);
                            return { mediaPath: null, mediaUrl: result.downloadLink };
                        }
                    }
                } catch (e) {}
            }
            return { mediaPath: localPath, mediaUrl: CONSTANTS.MEDIA_URL_PREFIX + encodeURIComponent(filename) };
        } catch (e) {
            this.log('error', 'media', 'Save media failed: ' + e.message);
            return { mediaPath: null, mediaUrl: null };
        }
    }

    getParticipantId(msg) {
        if (!msg) return null;
        if (msg.author) return msg.author;
        if (msg.id && msg.id.participant) return msg.id.participant;
        return null;
    }

    async getContactCached(msg) {
        const participantId = this.getParticipantId(msg);
        const id = participantId || msg?.from;
        if (!id) return null;
        try {
            return await this.getContactByIdCached(id);
        } catch (e) {
            return null;
        }
    }

    async getContactModelFallback(contactId) {
        if (!this.isReady()) return null;
        const id = typeof contactId === 'string' ? contactId.trim() : '';
        if (!id) return null;
        if (!this.client?.pupPage) return null;

        try {
            return await Promise.race([
                this.client.pupPage.evaluate(async (contactId) => {
                    try {
                        const createWid = window.Store?.WidFactory?.createWid;
                        if (!createWid) return null;

                        const unwrapContact = (value) => {
                            if (!value || typeof value !== 'object') return null;
                            if (typeof value.serialize === 'function') return value;
                            if (value.contact && typeof value.contact.serialize === 'function') return value.contact;
                            return null;
                        };

                        const primaryWid = createWid(contactId);
                        if (!primaryWid) return null;

                        const candidateIds = [];
                        const seen = new Set();
                        const pushId = (value) => {
                            if (!value) return;
                            const serialized = typeof value === 'string' ? value : (value._serialized || null);
                            if (!serialized || seen.has(serialized)) return;
                            seen.add(serialized);
                            candidateIds.push(serialized);
                        };

                        pushId(contactId);

                        try {
                            if (window.WWebJS?.enforceLidAndPnRetrieval) {
                                const resolved = await window.WWebJS.enforceLidAndPnRetrieval(contactId);
                                pushId(resolved?.phone);
                                pushId(resolved?.lid);
                            } else if (window.Store?.LidUtils) {
                                if (primaryWid.server === 'lid') {
                                    pushId(window.Store.LidUtils.getPhoneNumber(primaryWid));
                                } else {
                                    pushId(window.Store.LidUtils.getCurrentLid(primaryWid));
                                }
                            }
                        } catch (e) {}

                        const stores = [];
                        if (window.Store?.Contact) stores.push(window.Store.Contact);
                        if (window.Store?.ContactCollection) stores.push(window.Store.ContactCollection);

                        let contact = null;
                        for (const store of stores) {
                            for (const id of candidateIds) {
                                try {
                                    contact = unwrapContact(store.get?.(id));
                                } catch (e) {
                                    contact = null;
                                }
                                if (contact) break;

                                try {
                                    contact = unwrapContact(store.get?.(createWid(id)));
                                } catch (e) {
                                    contact = null;
                                }
                                if (contact) break;

                                try {
                                    contact = unwrapContact(await store.find?.(id));
                                } catch (e) {
                                    contact = null;
                                }
                                if (contact) break;
                            }
                            if (contact) break;
                        }

                        if (!contact) {
                            const wanted = new Set([contactId]);
                            candidateIds.forEach((cid) => wanted.add(cid));

                            for (const store of stores) {
                                try {
                                    const models = store.getModelsArray?.() || [];
                                    contact = unwrapContact(models.find((c) => {
                                        const model = unwrapContact(c);
                                        if (!model) return false;
                                        if (model?.id?._serialized && wanted.has(model.id._serialized)) return true;
                                        if (model?.phoneNumber?._serialized && wanted.has(model.phoneNumber._serialized)) return true;
                                        if (model?.wid?._serialized && wanted.has(model.wid._serialized)) return true;
                                        try {
                                            const entries = Object.entries(model);
                                            for (let i = 0; i < entries.length && i < 25; i++) {
                                                const [, value] = entries[i];
                                                if (value && typeof value === 'object' && typeof value._serialized === 'string' && wanted.has(value._serialized)) {
                                                    return true;
                                                }
                                            }
                                        } catch (e) {}
                                        return false;
                                    }) || null);
                                } catch (e) {
                                    contact = null;
                                }
                                if (contact) break;
                            }
                        }

                        if (!contact) return null;

                        try {
                            if (contact.id?._serialized?.endsWith('@lid') && contact.phoneNumber) {
                                contact.id = contact.phoneNumber;
                            }
                        } catch (e) {}

                        const safeContactModel = (contact) => {
                            const model = {};
                            try {
                                const serialized = contact && typeof contact.serialize === 'function' ? contact.serialize() : null;
                                if (serialized && typeof serialized === 'object') {
                                    Object.assign(model, serialized);
                                }
                            } catch (e) {}

                            const idObj = contact && typeof contact.id === 'object' ? contact.id : null;
                            const serializedId = idObj?._serialized
                                || (model.id && typeof model.id === 'object' ? model.id._serialized : null)
                                || (typeof model.id === 'string' ? model.id : null)
                                || null;
                            const userid = model.userid
                                || model.user
                                || (model.id && typeof model.id === 'object' ? model.id.user : null)
                                || idObj?.user
                                || null;

                            if (!model.id && serializedId) {
                                model.id = { _serialized: serializedId, user: idObj?.user || null, server: idObj?.server || null };
                            }

                            if (!model.userid && userid) {
                                model.userid = userid;
                            }

                            if (model.isBusiness === undefined) {
                                model.isBusiness = contact?.isBusiness === undefined ? false : Boolean(contact.isBusiness);
                            }
                            if (model.isWAContact === undefined) {
                                model.isWAContact = contact?.isWAContact === undefined ? false : Boolean(contact.isWAContact);
                            }
                            if (model.isMyContact === undefined) {
                                model.isMyContact = contact?.isMyContact === undefined ? false : Boolean(contact.isMyContact);
                            }

                            if (model.verifiedName === undefined) model.verifiedName = contact?.verifiedName || null;
                            if (model.name === undefined) model.name = contact?.name || null;
                            if (model.shortName === undefined) model.shortName = contact?.shortName || null;
                            if (model.pushname === undefined) model.pushname = contact?.pushname || null;

                            return model;
                        };

                        return safeContactModel(contact);
                    } catch (e) {
                        return null;
                    }
                }, id),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getContactModelFallback timeout')), 15000))
            ]);
        } catch (e) {
            return null;
        }
    }

    async getContactByIdCached(id) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const chatId = typeof id === 'string' ? id.trim() : '';
        if (!chatId) return null;
        if (this.contactCache.has(chatId)) return this.contactCache.get(chatId);
        try {
            const contact = await this.client.getContactById(chatId);
            this.contactCache.set(chatId, contact);
            return contact;
        } catch (e) {
            const model = await this.getContactModelFallback(chatId);
            if (model) {
                const serializedId = typeof model.id === 'string'
                    ? model.id
                    : (model.id && typeof model.id._serialized === 'string' ? model.id._serialized : chatId);
                const userid = model.userid !== undefined && model.userid !== null ? String(model.userid) : '';
                const number = userid ? userid.replace(/[^\d]/g, '') : null;
                const contact = {
                    id: { _serialized: serializedId },
                    name: model.name || null,
                    shortName: model.shortName || null,
                    pushname: model.pushname || null,
                    verifiedName: model.verifiedName || null,
                    number: number || null,
                    isMyContact: Boolean(model.isMyContact),
                    isWAContact: Boolean(model.isWAContact)
                };
                this.contactCache.set(chatId, contact);
                return contact;
            }
            return null;
        }
    }

    async handleMessage(msg, fromMe) {
        try {
            const chat = await msg.getChat();
            const contact = await this.getContactCached(msg);

            const body = this.getMessageBody(msg);
            let quotedMessageId = null;
            let quotedBody = null;
            let quotedFromName = null;
            if (msg.hasQuotedMsg) {
                try {
                    const quotedMsg = await msg.getQuotedMessage();
                    if (quotedMsg) {
                        quotedMessageId = quotedMsg.id?._serialized || null;
                        quotedBody = this.getMessageBody(quotedMsg);
                        if (quotedBody) {
                            quotedBody = String(quotedBody).slice(0, 1000);
                        }
                        let quotedContact = null;
                        if (!quotedMsg.fromMe) {
                            quotedContact = await this.getContactCached(quotedMsg);
                        }
                        quotedFromName = quotedMsg.fromMe
                            ? (this.info ? this.info.pushname : 'Me')
                            : this.getSenderName(quotedContact, quotedMsg);
                    }
                } catch (e) {
                    // Ignore quote errors, keep message flowing
                }
            }
            const msgData = {
                messageId: msg.id._serialized,
                chatId: chat.id._serialized,
                from: msg.from,
                to: msg.to,
                fromName: fromMe ? (this.info ? this.info.pushname : 'Me') : this.getSenderName(contact, msg),
                fromNumber: fromMe ? (this.info?.wid?.user || this.extractPhoneFromId(msg.from)) : this.getSenderNumber(contact, msg),
                body,
                type: msg.type,
                timestamp: msg.timestamp * 1000,
                isGroup: chat.isGroup,
                isFromMe: fromMe,
                quotedMessageId,
                quotedBody,
                quotedFromName,
                mediaMimetype: msg.mimetype || msg._data?.mimetype,
                mediaPath: null,
                mediaUrl: null
            };

            // 1. Save and Emit IMMEDIATELY (Fire and forget)
            this.db.messages.save.run(
                msgData.messageId,
                msgData.chatId,
                msgData.fromNumber,
                msgData.to,
                msgData.fromName,
                msgData.body,
                msgData.type,
                null, // No media yet
                null, // No url yet
                msgData.mediaMimetype,
                msgData.quotedMessageId,
                msgData.quotedBody,
                msgData.quotedFromName,
                msgData.isGroup ? 1 : 0,
                msgData.isFromMe ? 1 : 0,
                msg.ack || 0,
                msgData.timestamp
            );

            const lastPreview = msgData.body || (msg.hasMedia ? (msg.type === 'document' ? '[Dosya]' : '[Medya]') : '');
            const profilePic = await this.getChatProfilePic(chat);
            
            this.db.chats.upsert.run(
                chat.id._serialized,
                chat.name || this.extractPhoneFromId(chat.id.user),
                chat.isGroup ? 1 : 0,
                profilePic,
                lastPreview.substring(0, 100),
                msgData.timestamp,
                chat.unreadCount || 0
            );
            if (chat.archived) {
                try {
                    this.db.chats.setArchived.run(1, chat.id._serialized);
                } catch (e) {}
            }

            this.emit('message', msgData);

            // 2. Download Media in Background
            if (msg.hasMedia && this.settings.downloadMedia) {
                // Do not await this
                (async () => {
                    try {
                        const media = await this.downloadMediaWithRetry(msg);
                        if (media) {
                            const mediaResult = await this.saveMedia(media, msg.id._serialized, msg.timestamp * 1000);
                            
                            // Update DB
                            this.db.db.prepare('UPDATE messages SET media_path = ?, media_url = ?, media_mimetype = ? WHERE message_id = ?')
                                .run(mediaResult.mediaPath, mediaResult.mediaUrl, media.mimetype, msgData.messageId);

                            // Emit update event
                            this.emit('media_downloaded', {
                                messageId: msgData.messageId,
                                mediaUrl: mediaResult.mediaUrl,
                                mediaMimetype: media.mimetype
                            });
                            
                            this.log('info', 'media', 'Media downloaded for ' + msgData.messageId);
                        } else {
                            this.log('warn', 'media', 'Media download failed (background)', {
                                chatId: chat.id?._serialized,
                                messageId: msg.id?._serialized
                            });
                        }
                    } catch (err) {
                        this.log('error', 'media', 'Background media download error: ' + err.message);
                    }
                })();
            }

            return { msgData, chat, msg, contact };
        } catch (e) {
            this.log('error', 'message', 'Failed to process message: ' + e.message);
            return null;
        }
    }

    async storeMessageSnapshot(msg, options = {}) {
        const messageId = msg?.id?._serialized;
        if (!messageId) return { stored: false };

        try {
            const existing = this.db.db.prepare('SELECT message_id FROM messages WHERE message_id = ?').get(messageId);
            if (existing) {
                return { stored: false, existed: true, messageId };
            }
        } catch (e) {}

        const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);

        let chat = null;
        try {
            chat = await Promise.race([
                msg.getChat(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getChat timeout')), timeoutMs))
            ]);
        } catch (e) {
            chat = null;
        }

        const chatId = chat?.id?._serialized || (msg.fromMe ? msg.to : msg.from) || null;
        if (!chatId) return { stored: false };

        let contact = null;
        if (!msg.fromMe) {
            try {
                contact = await this.getContactCached(msg);
            } catch (e) {
                contact = null;
            }
        }

        const body = this.getMessageBody(msg);
        const fromName = msg.fromMe
            ? (this.info ? this.info.pushname : 'Me')
            : this.getSenderName(contact, msg);
        const fromNumber = msg.fromMe
            ? (this.info?.wid?.user || this.extractPhoneFromId(msg.from))
            : this.getSenderNumber(contact, msg);
        const isGroup = chat ? Boolean(chat.isGroup) : String(chatId).endsWith('@g.us');

        const timestampMs = msg.timestamp ? (msg.timestamp * 1000) : Date.now();
        const messageType = msg.type || 'chat';
        const mediaMimetype = msg.mimetype || msg._data?.mimetype || null;

        try {
            this.db.messages.save.run(
                messageId,
                chatId,
                fromNumber || null,
                msg.to || null,
                fromName || null,
                body || null,
                messageType,
                null,
                null,
                mediaMimetype,
                null,
                null,
                null,
                isGroup ? 1 : 0,
                msg.fromMe ? 1 : 0,
                msg.ack || 0,
                timestampMs
            );

            if (messageType === 'revoked') {
                try {
                    this.db.messages.markDeletedForEveryone.run(timestampMs, messageId);
                } catch (e) {}
            }
        } catch (e) {}

        return { stored: true, messageId, chatId };
    }

    async handleMessageRevokeEveryone(msg, revokedMsg) {
        const messageId = msg?.id?._serialized || revokedMsg?.id?._serialized || null;
        if (!messageId) return { success: false, reason: 'missing_message_id' };

        let chatId = null;
        try {
            const chat = await Promise.race([
                msg.getChat(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getChat timeout')), 15000))
            ]);
            chatId = chat?.id?._serialized || null;
        } catch (e) {
            chatId = null;
        }

        if (!chatId && revokedMsg) {
            try {
                const chat = await Promise.race([
                    revokedMsg.getChat(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getChat timeout')), 15000))
                ]);
                chatId = chat?.id?._serialized || null;
            } catch (e) {
                chatId = null;
            }
        }

        if (!chatId) {
            chatId = msg?.fromMe ? msg?.to : msg?.from;
        }

        if (revokedMsg) {
            try {
                await this.storeMessageSnapshot(revokedMsg, { timeoutMs: 15000 });
            } catch (e) {}
        }

        const deletedAt = Date.now();
        try {
            this.db.messages.markDeletedForEveryone.run(deletedAt, messageId);
        } catch (e) {}

        this.emit('message_revoked', { messageId, chatId: chatId || null, deletedAt, scope: 'everyone' });
        return { success: true, messageId, chatId: chatId || null, deletedAt };
    }

    async revokeMessageForEveryone(messageId, options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const id = typeof messageId === 'string' ? messageId.trim() : '';
        if (!id) throw new Error('Invalid message id');

        const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 30000);

        const msg = await Promise.race([
            this.client.getMessageById(id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('getMessageById timeout')), timeoutMs))
        ]);
        if (!msg) throw new Error('Message not found');

        const canRevoke = await Promise.race([
            this.client.pupPage.evaluate(async (msgId) => {
                const msg = window.Store.Msg.get(msgId) || (await window.Store.Msg.getMessagesById([msgId]))?.messages?.[0];
                if (!msg) return false;
                return Boolean(window.Store.MsgActionChecks.canSenderRevokeMsg(msg) || window.Store.MsgActionChecks.canAdminRevokeMsg(msg));
            }, id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('revoke permission check timeout')), 15000))
        ]);
        if (!canRevoke) throw new Error('Bu mesaj herkesten silinemiyor');

        let chatId = null;
        try {
            const chat = await Promise.race([
                msg.getChat(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getChat timeout')), 15000))
            ]);
            chatId = chat?.id?._serialized || null;
        } catch (e) {
            chatId = null;
        }

        if (!chatId) {
            chatId = msg.fromMe ? msg.to : msg.from;
        }

        try {
            await this.storeMessageSnapshot(msg, { timeoutMs: 15000 });
        } catch (e) {}

        await Promise.race([
            msg.delete(true, false),
            new Promise((_, reject) => setTimeout(() => reject(new Error('delete timeout')), timeoutMs))
        ]);

        const deletedAt = Date.now();
        try {
            this.db.messages.markDeletedForEveryone.run(deletedAt, id);
        } catch (e) {}

        this.emit('message_revoked', { messageId: id, chatId: chatId || null, deletedAt, scope: 'everyone' });
        return { success: true, messageId: id, chatId: chatId || null, deletedAt };
    }

    indexChat(chat) {
        const chatId = chat?.id?._serialized;
        if (!chatId) return false;

        const chatName = chat.name || chat.id.user;
        const existingChat = this.db.chats.getById.get(chatId);
        const cachedPic = this.chatProfileCache.get(chatId) || null;
        const profilePic = existingChat?.profile_pic || cachedPic || null;

        const lastMsg = chat.lastMessage || null;
        const lastPreview = lastMsg
            ? (this.getMessageBody(lastMsg) || (lastMsg.hasMedia ? (lastMsg.type === 'document' ? '[Dosya]' : '[Medya]') : ''))
            : (existingChat?.last_message || '');

        const lastAt = lastMsg?.timestamp
            ? lastMsg.timestamp * 1000
            : (Number(existingChat?.last_message_at) || 0);

        this.db.chats.upsert.run(
            chatId,
            chatName,
            chat.isGroup ? 1 : 0,
            profilePic,
            String(lastPreview || '').substring(0, 100),
            lastAt,
            chat.unreadCount || 0
        );
        if (chat.archived) {
            try {
                this.db.chats.setArchived.run(1, chatId);
            } catch (e) {}
        }

        if (!profilePic) {
            this.enqueueProfilePicRefresh(chatId);
        }

        return true;
    }

    async fullSync() {
        return this.startFullSyncAll();
    }

    async getChatsWithRetry() {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        let lastError = null;
        for (let attempt = 1; attempt <= CONSTANTS.SYNC_CHAT_MAX_RETRIES; attempt++) {
            try {
                const chats = await Promise.race([
                    this.client.getChats(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getChats timeout')), 120000))
                ]);
                if (Array.isArray(chats) && chats.length) {
                    return chats;
                }
                if (Array.isArray(chats)) {
                    lastError = new Error('getChats returned empty');
                }
            } catch (e) {
                lastError = e;
            }

            const baseDelay = Math.min(
                CONSTANTS.SYNC_CHAT_BACKOFF_BASE_MS * (2 ** (attempt - 1)),
                CONSTANTS.SYNC_CHAT_BACKOFF_MAX_MS
            );
            const jitter = 0.7 + Math.random() * 0.6;
            const delay = Math.round(baseDelay * jitter);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        throw lastError || new Error('getChats failed');
    }

    async startFullSyncAll() {
        if (this.fullSyncPromise) {
            return { success: true, runId: this.fullSyncRunId, running: true };
        }

        const existingRun = this.db.syncRuns.getRunning.get();
        if (!this.acquireFullSyncLock()) {
            return { success: true, runId: existingRun?.id || null, running: true };
        }

        this.startFullSyncLockRenewal();
        let runId = existingRun?.id || null;
        if (!runId) {
            const totals = JSON.stringify({ chatsTotal: 0, chatsIndexed: 0, chatsBackfilled: 0 });
            runId = this.db.syncRuns.create.run('running', 'init', null, totals).lastInsertRowid;
        }

        this.fullSyncRunId = runId;
        this.fullSyncPromise = this.executeFullSyncRun(runId)
            .catch((error) => {
                this.log('error', 'sync', 'Full sync failed: ' + error.message);
            })
            .finally(() => {
                this.releaseFullSyncLock();
                this.fullSyncPromise = null;
                this.fullSyncRunId = null;
            });

        return { success: true, runId, running: true };
    }

    async executeFullSyncRun(runId) {
        try {
            if (!this.isReady()) {
                throw new Error('WhatsApp not connected');
            }

            const config = this.getFullSyncConfig();
            const cutoffMs = this.parseCutoffMs(config.cutoffDate);

            this.db.syncRuns.updatePhase.run('loading_chats', runId);
            const chats = await this.getChatsWithRetry();
            const lastMsCache = new Map();
            const getChatLastMs = (chat) => {
                const chatId = chat?.id?._serialized || '';
                if (!chatId) return 0;
                if (lastMsCache.has(chatId)) return lastMsCache.get(chatId);

                const existing = this.db.chats.getById.get(chatId);
                const existingLast = Number(existing?.last_message_at) || 0;
                const lastMsgTs = chat?.lastMessage?.timestamp ? chat.lastMessage.timestamp * 1000 : 0;
                const chatTs = chat?.timestamp ? chat.timestamp * 1000 : 0;

                const value = lastMsgTs || chatTs || existingLast || 0;
                lastMsCache.set(chatId, value);
                return value;
            };
            chats.sort((a, b) => {
                const diff = getChatLastMs(b) - getChatLastMs(a);
                if (diff !== 0) return diff;
                const aId = a?.id?._serialized || '';
                const bId = b?.id?._serialized || '';
                return aId.localeCompare(bId);
            });

            const totals = { chatsTotal: chats.length, chatsIndexed: 0, chatsBackfilled: 0 };
            this.db.syncRuns.update.run('running', 'indexing', null, JSON.stringify(totals), runId);

            for (const chat of chats) {
                const chatId = chat?.id?._serialized;
                if (!chatId) continue;
                const existingState = this.db.chatSyncState.getByChatIdAny.get(chatId);
                if (!existingState || existingState.run_id !== runId) {
                    this.db.chatSyncState.upsert.run(
                        chatId,
                        runId,
                        'pending',
                        null,
                        null,
                        null,
                        null,
                        0,
                        null
                    );
                }

                this.indexChat(chat);
                totals.chatsIndexed += 1;
                this.db.syncRuns.updateTotals.run(JSON.stringify(totals), runId);
                await new Promise(resolve => setImmediate(resolve));
            }

            this.emit('sync_chats_indexed', { chats: chats.length });

            this.db.syncRuns.updatePhase.run('backfill', runId);

            const chatConcurrency = Math.max(1, config.chatConcurrency);
            const queue = chats.slice();
            const workers = Array.from({ length: chatConcurrency }, () => (async () => {
                while (queue.length) {
                    const chat = queue.shift();
                    if (!chat) return;
                    const chatId = chat?.id?._serialized;
                    if (!chatId) continue;

                    const existing = this.db.chatSyncState.getByChatId.get(chatId, runId);
                    if (existing?.done_history) {
                        totals.chatsBackfilled += 1;
                        this.db.syncRuns.updateTotals.run(JSON.stringify(totals), runId);
                        continue;
                    }

                    try {
                        await this.backfillChatHistory(chat, runId, config, cutoffMs);
                        totals.chatsBackfilled += 1;
                        this.db.syncRuns.updateTotals.run(JSON.stringify(totals), runId);
                    } catch (e) {
                        this.db.chatSyncState.upsert.run(
                            chatId,
                            runId,
                            'failed',
                            existing?.cursor_type || null,
                            existing?.cursor_value || null,
                            existing?.oldest_msg_id || null,
                            existing?.newest_msg_id || null,
                            existing?.done_history ? 1 : 0,
                            e.message
                        );
                        this.log('warn', 'sync', `Chat backfill failed for ${chatId}: ${e.message}`);
                    }
                }
            })());

            await Promise.all(workers);

            this.db.syncRuns.updatePhase.run('media', runId);
            await this.processMediaTasks(config);

            this.db.syncRuns.updatePhase.run('profile_pics', runId);
            await this.processProfilePicTasks(config);

            this.db.syncRuns.update.run('done', 'done', null, JSON.stringify(totals), runId);
            this.log('info', 'sync', `Full sync complete (run ${runId})`);
        } catch (error) {
            this.db.syncRuns.markError.run('error', error.message, runId);
            throw error;
        }
    }

    async backfillChatHistory(chat, runId, config, cutoffMs) {
        const chatId = chat?.id?._serialized;
        if (!chatId) return;

        let state = this.db.chatSyncState.getByChatId.get(chatId, runId);
        if (!state) {
            this.db.chatSyncState.upsert.run(chatId, runId, 'pending', null, null, null, null, 0, null);
            state = this.db.chatSyncState.getByChatId.get(chatId, runId);
        }

        if (state.done_history) return;

        this.db.chatSyncState.upsert.run(
            chatId,
            runId,
            'running',
            state.cursor_type || null,
            state.cursor_value || null,
            state.oldest_msg_id || null,
            state.newest_msg_id || null,
            0,
            null
        );

        let cursor = state.cursor_value || null;
        let newestMsgId = state.newest_msg_id || null;
        let oldestMsgId = state.oldest_msg_id || null;
        const safePageLimit = Math.max(25, Number(config.pageLimit) || CONSTANTS.FULL_SYNC_PAGE_LIMIT);
        const maxMessagesPerChat = Math.min(5000, Math.max(1, Number(this.settings.maxMessagesPerChat) || 1000));
        const countMessagesByChatId = this.db.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
        let storedCount = 0;
        try {
            storedCount = countMessagesByChatId.get(chatId)?.count || 0;
        } catch (e) {
            storedCount = 0;
        }

        const upsertChatMeta = () => {
            const lastMsg = chat.lastMessage || null;
            const lastPreview = lastMsg
                ? (this.getMessageBody(lastMsg) || (lastMsg.hasMedia ? (lastMsg.type === 'document' ? '[Dosya]' : '[Medya]') : ''))
                : '';
            const lastAt = lastMsg?.timestamp
                ? lastMsg.timestamp * 1000
                : (chat.timestamp ? chat.timestamp * 1000 : Date.now());
            const existingChat = this.db.chats.getById.get(chatId);
            const profilePic = existingChat?.profile_pic || this.chatProfileCache.get(chatId) || null;
            this.db.chats.upsert.run(
                chatId,
                chat.name || this.extractPhoneFromId(chat.id.user),
                chat.isGroup ? 1 : 0,
                profilePic,
                String(lastPreview || '').substring(0, 100),
                lastAt,
                chat.unreadCount || 0
            );
            if (chat.archived) {
                try {
                    this.db.chats.setArchived.run(1, chatId);
                } catch (e) {}
            }
        };

        const saveMessages = async (messages) => {
            if (!Array.isArray(messages) || messages.length === 0) return;

            const filtered = cutoffMs
                ? messages.filter(msg => (msg.timestamp * 1000) >= cutoffMs)
                : messages;

            if (!filtered.length) return;

            const msgRows = [];
            for (const msg of filtered) {
                let contact = null;
                if (!msg.fromMe) {
                    contact = await this.getContactCached(msg);
                }

                const body = this.getMessageBody(msg);
                msgRows.push({
                    messageId: msg.id?._serialized,
                    chatId,
                    fromNumber: msg.fromMe
                        ? (this.info?.wid?.user || this.extractPhoneFromId(msg.from))
                        : this.getSenderNumber(contact, msg),
                    toNumber: msg.to,
                    fromName: msg.fromMe
                        ? (this.info ? this.info.pushname : 'Me')
                        : this.getSenderName(contact, msg),
                    body,
                    type: msg.type,
                    mediaMimetype: msg.mimetype || msg._data?.mimetype,
                    isGroup: chat.isGroup,
                    isFromMe: msg.fromMe,
                    ack: msg.ack || 0,
                    timestamp: msg.timestamp * 1000,
                    hasMedia: msg.hasMedia
                });
            }

            const syncTx = this.db.db.transaction(() => {
                for (const row of msgRows) {
                    if (!row.messageId) continue;
                    this.db.messages.save.run(
                        row.messageId,
                        row.chatId,
                        row.fromNumber,
                        row.toNumber,
                        row.fromName,
                        row.body,
                        row.type,
                        null,
                        null,
                        row.mediaMimetype,
                        null,
                        null,
                        null,
                        row.isGroup ? 1 : 0,
                        row.isFromMe ? 1 : 0,
                        row.ack,
                        row.timestamp
                    );

                    if (row.type === 'revoked') {
                        try {
                            this.db.messages.markDeletedForEveryone.run(row.timestamp, row.messageId);
                        } catch (e) {}
                    }
                }

                upsertChatMeta();
            });

            syncTx();
            try {
                storedCount = countMessagesByChatId.get(chatId)?.count || storedCount;
            } catch (e) {}

            for (const row of msgRows) {
                if (!row.messageId) continue;
                if (row.hasMedia || row.mediaMimetype || ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(row.type)) {
                    this.db.mediaTasks.upsert.run(row.messageId, chatId);
                }
            }
            this.db.profilePicTasks.upsert.run(chatId);

            const oldest = filtered.reduce((acc, msg) => {
                if (!msg?.id?._serialized) return acc;
                if (!acc) return msg;
                return msg.timestamp < acc.timestamp ? msg : acc;
            }, null);
            const newest = filtered.reduce((acc, msg) => {
                if (!msg?.id?._serialized) return acc;
                if (!acc) return msg;
                return msg.timestamp > acc.timestamp ? msg : acc;
            }, null);

            if (!newestMsgId && newest?.id?._serialized) {
                newestMsgId = newest.id._serialized;
            }
            if (oldest?.id?._serialized) {
                oldestMsgId = oldest.id._serialized;
                cursor = oldestMsgId;
            }
        };

        // Seed with the most recent messages (also ensures chat message store is initialized)
        const initial = await this.fetchMessagesWithRetry(chat, safePageLimit);
        await saveMessages(initial);
        let stopReason = 'load_earlier';
        if (storedCount >= maxMessagesPerChat) {
            stopReason = 'max_messages';
        }

        // Now page backwards using WhatsApp Web's loadEarlierMsgs (whatsapp-web.js Chat.fetchMessages has no `before` cursor)
        let reachedEnd = false;
        let safetyLoops = 0;
        let stagnantLoops = 0;
        let lastOldestId = oldestMsgId || null;

        while (!reachedEnd) {
            if (storedCount >= maxMessagesPerChat) {
                stopReason = 'max_messages';
                break;
            }
            safetyLoops += 1;
            if (safetyLoops > 20000) {
                throw new Error('Chat backfill exceeded max iterations');
            }

            const batch = await this.loadEarlierMessagesWithRetry(chatId, safePageLimit);
            if (!batch.loaded) {
                break;
            }

            const msgs = Array.isArray(batch.models)
                ? batch.models.map((model) => new Message(this.client, model))
                : [];

            await saveMessages(msgs);
            if (storedCount >= maxMessagesPerChat) {
                stopReason = 'max_messages';
                break;
            }

            if (cutoffMs && msgs.some(msg => (msg.timestamp * 1000) < cutoffMs)) {
                reachedEnd = true;
            }

            const hadMessages = msgs.length > 0;
            if (hadMessages && oldestMsgId && oldestMsgId === lastOldestId) {
                stagnantLoops += 1;
            } else if (hadMessages) {
                stagnantLoops = 0;
                lastOldestId = oldestMsgId || null;
            }

            this.db.chatSyncState.upsert.run(
                chatId,
                runId,
                'running',
                stopReason,
                oldestMsgId || cursor || null,
                oldestMsgId,
                newestMsgId,
                0,
                null
            );

            if (stagnantLoops >= 50 && !cutoffMs) {
                // No progress for a while despite loadEarlier returning data; avoid infinite loops.
                throw new Error('Chat backfill made no progress (stuck cursor)');
            }

            await new Promise(resolve => setImmediate(resolve));
        }

        this.db.chatSyncState.upsert.run(
            chatId,
            runId,
            'done',
            stopReason,
            oldestMsgId || cursor,
            oldestMsgId,
            newestMsgId,
            1,
            null
        );
    }

    async syncChat(chat, options = {}) {
        const chatId = chat?.id?._serialized;
        if (!chatId) return { count: 0, lastMessageTs: null };

        const chatName = chat.name || chat.id?.user || chatId;
        const limitRaw = options.limit !== undefined ? options.limit : this.settings.maxMessagesPerChat;
        const limit = Math.min(5000, Math.max(1, Number(limitRaw) || 250));
        const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 30000);

        let fetchedMessages = [];
        try {
            let lastError = null;
            for (let attempt = 1; attempt <= CONSTANTS.SYNC_CHAT_MAX_RETRIES; attempt++) {
                try {
                    fetchedMessages = await Promise.race([
                        chat.fetchMessages({ limit }),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('fetchMessages timeout')), timeoutMs))
                    ]);
                    lastError = null;
                    break;
                } catch (e) {
                    lastError = e;
                    const baseDelay = Math.min(
                        CONSTANTS.SYNC_CHAT_BACKOFF_BASE_MS * (2 ** (attempt - 1)),
                        CONSTANTS.SYNC_CHAT_BACKOFF_MAX_MS
                    );
                    const jitter = 0.7 + Math.random() * 0.6;
                    const delay = Math.round(baseDelay * jitter);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

            if (lastError) {
                throw lastError;
            }
        } catch (e) {
            this.log('warn', 'sync', `Chat fetchMessages failed for ${chatName}: ${e.message}`);
            fetchedMessages = [];
        }

        const messages = fetchedMessages.length
            ? fetchedMessages
            : (chat.lastMessage ? [chat.lastMessage] : []);

        try {
            const msgRows = [];
            for (const msg of messages) {
                const contact = await this.getContactCached(msg);
                const body = this.getMessageBody(msg);
                msgRows.push({
                    messageId: msg.id?._serialized,
                    chatId: chatId,
                    from: msg.from,
                    to: msg.to,
                    fromName: msg.fromMe ? (this.info ? this.info.pushname : 'Me') : this.getSenderName(contact, msg),
                    fromNumber: msg.fromMe ? (this.info?.wid?.user || this.extractPhoneFromId(msg.from)) : this.getSenderNumber(contact, msg),
                    body,
                    type: msg.type,
                    timestamp: msg.timestamp * 1000,
                    isGroup: chat.isGroup,
                    isFromMe: msg.fromMe,
                    mediaMimetype: msg.mimetype || msg._data?.mimetype,
                    mediaPath: null,
                    mediaUrl: null,
                    ack: msg.ack || 0,
                    hasMedia: msg.hasMedia
                });
            }

            const existingChat = this.db.chats.getById.get(chatId);
            const cachedPic = this.chatProfileCache.get(chatId) || null;
            const profilePic = existingChat?.profile_pic || cachedPic || null;
            if (!profilePic) {
                this.enqueueProfilePicRefresh(chatId);
            }

            const lastMsg = fetchedMessages.length
                ? fetchedMessages[fetchedMessages.length - 1]
                : (chat.lastMessage || null);

            const lastPreview = lastMsg
                ? (this.getMessageBody(lastMsg) || (lastMsg.hasMedia ? (lastMsg.type === 'document' ? '[Dosya]' : '[Medya]') : ''))
                : (existingChat?.last_message || '');

            const lastAt = lastMsg?.timestamp
                ? lastMsg.timestamp * 1000
                : (Number(existingChat?.last_message_at) || 0);

            const syncTx = this.db.db.transaction(() => {
                for (const row of msgRows) {
                    if (!row.messageId) continue;
                    this.db.messages.save.run(
                        row.messageId,
                        row.chatId,
                        row.fromNumber,
                        row.to,
                        row.fromName,
                        row.body,
                        row.type,
                        row.mediaPath,
                        row.mediaUrl,
                        row.mediaMimetype,
                        null,
                        null,
                        null,
                        row.isGroup ? 1 : 0,
                        row.isFromMe ? 1 : 0,
                        row.ack,
                        row.timestamp
                    );

                    if (row.type === 'revoked') {
                        try {
                            this.db.messages.markDeletedForEveryone.run(row.timestamp, row.messageId);
                        } catch (e) {}
                    }
                }

                this.db.chats.upsert.run(
                    chatId,
                    chat.name || this.extractPhoneFromId(chat.id?.user),
                    chat.isGroup ? 1 : 0,
                    profilePic,
                    String(lastPreview || '').substring(0, 100),
                    lastAt,
                    chat.unreadCount || 0
                );
                if (chat.archived) {
                    try {
                        this.db.chats.setArchived.run(1, chatId);
                    } catch (e) {}
                }
            });

            syncTx();

            for (const row of msgRows) {
                if (!row.messageId) continue;
                if (row.hasMedia && this.settings.downloadMedia && this.settings.downloadMediaOnSync) {
                    this.enqueueMediaDownload(row.messageId);
                }
            }

            return { count: msgRows.length, lastMessageTs: lastAt };
        } catch (e) {
            this.log('warn', 'sync', `Chat sync error for ${chatName}: ${e.message}`);
            return { count: 0, lastMessageTs: null };
        }
    }

    async syncChatById(chatId, options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const id = typeof chatId === 'string' ? chatId.trim() : '';
        if (!id) throw new Error('Invalid chat id');

        const timeoutMs = Math.max(5000, Number(options.chatTimeoutMs) || 30000);
        const chat = await Promise.race([
            this.client.getChatById(id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById timeout')), timeoutMs))
        ]);
        if (!chat) throw new Error('Chat not found');
        return await this.syncChat(chat, options);
    }

    async ensureChatCaughtUp(chatId, options = {}) {
        const id = typeof chatId === 'string' ? chatId.trim() : '';
        if (!id) return { refreshed: false, reason: 'invalid_chat_id' };
        if (!this.isReady()) return { refreshed: false, reason: 'not_ready' };

        const now = Date.now();
        const cooldownMs = Math.max(1000, Number(options.cooldownMs) || 30000);
        const lastAttempt = this.chatCatchupAttempts.get(id) || 0;
        if (lastAttempt && (now - lastAttempt) < cooldownMs) {
            return { refreshed: false, reason: 'cooldown' };
        }
        this.chatCatchupAttempts.set(id, now);

        let chatLastAt = 0;
        try {
            const chatRow = this.db.chats.getById.get(id);
            chatLastAt = Number(chatRow?.last_message_at) || 0;
        } catch (e) {
            chatLastAt = 0;
        }

        let maxMsgTs = 0;
        try {
            const row = this.db.db.prepare('SELECT MAX(timestamp) as maxTs FROM messages WHERE chat_id = ?').get(id);
            maxMsgTs = Number(row?.maxTs) || 0;
        } catch (e) {
            maxMsgTs = 0;
        }

        const thresholdMs = Math.max(0, Number(options.thresholdMs) || (2 * 60 * 1000));
        const looksStale = chatLastAt > 0 && (maxMsgTs + thresholdMs) < chatLastAt;
        if (!looksStale) {
            return { refreshed: false, reason: 'up_to_date', chatLastAt, maxMsgTs };
        }

        const limit = Math.min(
            1000,
            Math.max(50, Number(options.limit) || 250, Number(this.settings.maxMessagesPerChat) || 250)
        );

        try {
            const result = await this.syncChatById(id, { limit, timeoutMs: options.timeoutMs || 30000 });
            return { refreshed: true, reason: 'synced', result };
        } catch (e) {
            return { refreshed: false, reason: 'sync_failed', error: e.message, chatLastAt, maxMsgTs };
        }
    }

    async fetchMessagesWithRetry(chat, limit) {
        let lastError = null;
        for (let attempt = 1; attempt <= CONSTANTS.SYNC_CHAT_MAX_RETRIES; attempt++) {
            try {
                const options = { limit };
                return await Promise.race([
                    chat.fetchMessages(options),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('fetchMessages timeout')), 120000))
                ]);
            } catch (e) {
                lastError = e;
                const baseDelay = Math.min(
                    CONSTANTS.SYNC_CHAT_BACKOFF_BASE_MS * (2 ** (attempt - 1)),
                    CONSTANTS.SYNC_CHAT_BACKOFF_MAX_MS
                );
                const jitter = 0.7 + Math.random() * 0.6;
                const delay = Math.round(baseDelay * jitter);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError || new Error('fetchMessages failed');
    }

    async loadEarlierMessagesWithRetry(chatId, targetCount) {
        let lastError = null;
        for (let attempt = 1; attempt <= CONSTANTS.SYNC_CHAT_MAX_RETRIES; attempt++) {
            try {
                return await Promise.race([
                    this.client.pupPage.evaluate(async (chatId, targetCount) => {
                        const msgFilter = (m) => !m.isNotification;
                        const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
                        const maxTarget = Math.max(1, Number(targetCount) || 250);

                        let loaded = 0;
                        let models = [];
                        let loops = 0;
                        const maxLoops = 50;

                        while (models.length < maxTarget && loops < maxLoops) {
                            loops += 1;
                            const batch = await window.Store.ConversationMsgs.loadEarlierMsgs(chat);
                            if (!batch || !batch.length) break;
                            loaded += batch.length;
                            for (const m of batch) {
                                if (msgFilter(m)) models.push(m);
                            }
                        }

                        models.sort((a, b) => (a.t > b.t ? 1 : -1));
                        return {
                            loaded,
                            models: models.map(m => window.WWebJS.getMessageModel(m))
                        };
                    }, chatId, targetCount),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('loadEarlierMsgs timeout')), 120000))
                ]);
            } catch (e) {
                lastError = e;
                const baseDelay = Math.min(
                    CONSTANTS.SYNC_CHAT_BACKOFF_BASE_MS * (2 ** (attempt - 1)),
                    CONSTANTS.SYNC_CHAT_BACKOFF_MAX_MS
                );
                const jitter = 0.7 + Math.random() * 0.6;
                const delay = Math.round(baseDelay * jitter);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError || new Error('loadEarlierMsgs failed');
    }

    async processMediaTasks(config) {
        const concurrency = Math.max(1, config.mediaConcurrency);
        const maxAttempts = Math.max(1, config.maxMediaAttempts);

        for (;;) {
            const tasks = this.db.mediaTasks.getRunnable.all(concurrency);
            if (!tasks.length) break;

            await Promise.all(tasks.map(async (task) => {
                this.db.mediaTasks.markRunning.run(task.message_id);
                try {
                    const msg = await Promise.race([
                        this.client.getMessageById(task.message_id),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Message fetch timeout')), 20000))
                    ]);
                    if (!msg || !msg.hasMedia) {
                        throw new Error('Message has no media');
                    }
                    const media = await this.downloadMediaWithRetry(msg, 3, CONSTANTS.DEFAULT_DOWNLOAD_TIMEOUT_MS);
                    if (!media) {
                        throw new Error('Media download returned null');
                    }
                    const timestamp = msg.timestamp ? msg.timestamp * 1000 : Date.now();
                    const mediaResult = await this.saveMedia(media, task.message_id, timestamp);
                    this.db.db.prepare('UPDATE messages SET media_path = ?, media_url = ?, media_mimetype = ? WHERE message_id = ?')
                        .run(mediaResult.mediaPath, mediaResult.mediaUrl, media.mimetype, task.message_id);
                    this.db.mediaTasks.markDone.run(task.attempts + 1, task.message_id);
                } catch (e) {
                    const attempts = (task.attempts || 0) + 1;
                    if (attempts >= maxAttempts) {
                        this.db.mediaTasks.markFailed.run(attempts, e.message, task.message_id);
                    } else {
                        const delay = Math.min(CONSTANTS.BACKOFF_MULTIPLIER_MS * (2 ** (attempts - 1)), 300000);
                        const jitter = 0.7 + Math.random() * 0.6;
                        const nextAttemptAt = new Date(Date.now() + Math.round(delay * jitter)).toISOString();
                        this.db.mediaTasks.reschedule.run(attempts, nextAttemptAt, e.message, task.message_id);
                    }
                }
            }));
        }
    }

    async processProfilePicTasks(config) {
        const concurrency = Math.max(1, config.profileConcurrency);
        const maxAttempts = Math.max(1, config.maxProfileAttempts);

        for (;;) {
            const tasks = this.db.profilePicTasks.getRunnable.all(concurrency);
            if (!tasks.length) break;

            await Promise.all(tasks.map(async (task) => {
                this.db.profilePicTasks.markRunning.run(task.chat_id);
                try {
                    const url = await Promise.race([
                        this.client.getProfilePicUrl(task.chat_id),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Profile picture fetch timeout')), 15000))
                    ]);
                    if (!url) {
                        throw new Error('No profile picture URL');
                    }

                    let resolvedUrl = url;
                    if (this.settings.downloadProfilePictures) {
                        resolvedUrl = await this.downloadAndSaveProfilePicture(task.chat_id, url);
                    }

                    this.db.db.prepare('UPDATE chats SET profile_pic = ?, updated_at = datetime(\'now\') WHERE chat_id = ?')
                        .run(resolvedUrl, task.chat_id);

                    this.profilePicQueueIds.delete(task.chat_id);
                    this.db.profilePicTasks.markDone.run(task.attempts + 1, task.chat_id);
                } catch (e) {
                    const attempts = (task.attempts || 0) + 1;
                    if (attempts >= maxAttempts) {
                        this.db.profilePicTasks.markFailed.run(attempts, e.message, task.chat_id);
                    } else {
                        const delay = Math.min(CONSTANTS.BACKOFF_MULTIPLIER_MS * (2 ** (attempts - 1)), 300000);
                        const jitter = 0.7 + Math.random() * 0.6;
                        const nextAttemptAt = new Date(Date.now() + Math.round(delay * jitter)).toISOString();
                        this.db.profilePicTasks.reschedule.run(attempts, nextAttemptAt, e.message, task.chat_id);
                    }
                }
            }));
        }
    }

    getFullSyncProgress() {
        const run = this.db.syncRuns.getRunning.get() || this.db.syncRuns.getLatest.get();
        if (!run) {
            return { status: 'idle' };
        }

        let totals = {};
        try {
            totals = run.totals_json ? JSON.parse(run.totals_json) : {};
        } catch (e) {
            totals = {};
        }

        const chatsTotal = totals.chatsTotal || this.db.chatSyncState.countByRun.get(run.id).total;
        const chatsIndexed = totals.chatsIndexed || 0;
        const chatsBackfilled = totals.chatsBackfilled || this.db.chatSyncState.countDoneHistory.get(run.id).total;

        const mediaCounts = this.db.mediaTasks.countByStatus.all();
        const profileCounts = this.db.profilePicTasks.countByStatus.all();

        const formatCounts = (rows) => rows.reduce((acc, row) => {
            acc[row.status] = row.total;
            return acc;
        }, {});

        return {
            runId: run.id,
            status: run.status,
            phase: run.phase,
            startedAt: run.started_at,
            updatedAt: run.updated_at,
            error: run.error,
            chats: {
                total: chatsTotal,
                indexed: chatsIndexed,
                backfilled: chatsBackfilled
            },
            media: formatCounts(mediaCounts),
            profilePics: formatCounts(profileCounts)
        };
    }

    updateSettings(newSettings) {
        const normalized = this.normalizeSettings(newSettings);
        this.settings = { ...this.settings, ...normalized };
        this.persistSettingsToDb();
        return this.settings;
    }

    getSettings() { return this.settings; }
    getSyncProgress() { return this.syncProgress; }

    async sendMessage(chatId, message, options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        let result;
        const sendOptions = {};
        if (options.quotedMessageId) {
            sendOptions.quotedMessageId = options.quotedMessageId;
        }
        if (options.mediaPath) {
            const media = MessageMedia.fromFilePath(options.mediaPath);
            if (options.sendAsSticker) {
                sendOptions.sendMediaAsSticker = true;
            } else if (message) {
                sendOptions.caption = message;
            }
            result = await this.client.sendMessage(chatId, media, sendOptions);
        } else {
            result = await this.client.sendMessage(chatId, message, sendOptions);
        }
        this.log('info', 'message', 'Message sent to ' + chatId);
        return result;
    }

    async markAsRead(chatId) {
        if (this.settings.ghostMode) {
            return { success: false, reason: 'Ghost Mode is enabled' };
        }
        if (!this.isReady()) throw new Error('WhatsApp not connected');

        const chat = await this.client.getChatById(chatId);
        await chat.sendSeen();
        return { success: true };
    }

    async archiveChat(chatId) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const id = typeof chatId === 'string' ? chatId.trim() : '';
        if (!id) throw new Error('Invalid chatId');

        const chat = await Promise.race([
            this.client.getChatById(id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat fetch timeout')), 10000))
        ]);

        await Promise.race([
            chat.archive(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat archive timeout')), 10000))
        ]);

        try {
            this.db.chats.setArchived.run(1, id);
        } catch (e) {}

        return { success: true };
    }

    async unarchiveChat(chatId) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const id = typeof chatId === 'string' ? chatId.trim() : '';
        if (!id) throw new Error('Invalid chatId');

        const chat = await Promise.race([
            this.client.getChatById(id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat fetch timeout')), 10000))
        ]);

        await Promise.race([
            chat.unarchive(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat unarchive timeout')), 10000))
        ]);

        try {
            this.db.chats.setArchived.run(0, id);
        } catch (e) {}

        return { success: true };
    }

    isReady() { return this.status === 'ready' && this.client; }

    getStatus() {
        return {
            status: this.status,
            qrCode: this.qrCode,
            info: this.info ? { pushname: this.info.pushname, wid: this.info.wid.user, platform: this.info.platform } : null,
            syncProgress: this.syncProgress,
            settings: this.settings,
            lastError: this.lastError
        };
    }

    async getProfilePictureUrl(id, options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        const chatId = typeof id === 'string' ? id.trim() : '';
        if (!chatId) return null;

        const now = Date.now();
        const cached = this.contactProfilePicCache.get(chatId);
        if (cached && !options.bypassCache) {
            const ttlMs = cached.url ? (6 * 60 * 60 * 1000) : (5 * 60 * 1000);
            if ((now - (cached.fetchedAt || 0)) < ttlMs) {
                return cached.url || null;
            }
        }

        let url = null;
        try {
            const timeout = Symbol('profile_pic_timeout');
            const result = await Promise.race([
                this.client.getProfilePicUrl(chatId),
                new Promise((resolve) => setTimeout(resolve, 20000, timeout))
            ]);
            url = result === timeout ? null : result;
        } catch (e) {
            url = null;
        }

        let resolvedUrl = url || null;
        const shouldDownload = options.download === true || this.settings.downloadProfilePictures;
        if (resolvedUrl && shouldDownload && !this.isLocalMediaUrl(resolvedUrl)) {
            try {
                const timeout = Symbol('profile_pic_download_timeout');
                const downloaded = await Promise.race([
                    this.downloadAndSaveProfilePicture(chatId, resolvedUrl),
                    new Promise((resolve) => setTimeout(resolve, 30000, timeout))
                ]);
                if (downloaded && downloaded !== timeout) {
                    resolvedUrl = downloaded;
                }
            } catch (e) {}
        }

        this.contactProfilePicCache.set(chatId, { url: resolvedUrl || null, fetchedAt: now });
        return resolvedUrl || null;
    }

    async refreshChatPicture(chatId) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        
        try {
            // Use client-level method which is more reliable
            // Add a timeout race to prevent hanging
            const fetchPic = async (id) => {
                return Promise.race([
                    this.client.getProfilePicUrl(id),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Profile picture fetch timeout')), 10000))
                ]);
            };

            let url = null;
            try {
                url = await fetchPic(chatId);
            } catch (e) {
                this.log('warn', 'profile_pic', 'Timeout fetching pic for ' + chatId);
            }
            
            // If it's a group and url is null, sometimes we need to wait or retry
            if (!url && chatId.endsWith('@g.us')) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                    url = await fetchPic(chatId);
                } catch (e) {}
            }

            let resolvedUrl = url || null;
            if (resolvedUrl && this.settings.downloadProfilePictures) {
                try {
                    resolvedUrl = await this.downloadAndSaveProfilePicture(chatId, resolvedUrl);
                } catch (e) {
                    // Keep remote URL if download fails
                }
            }

            // Update cache
            this.chatProfileCache.set(chatId, resolvedUrl || null);

            // Update Database with specific UPDATE to avoid overwriting other fields if row exists
            // We only want to update the profile picture and updated_at
            this.db.db.prepare('UPDATE chats SET profile_pic = ?, updated_at = datetime(\'now\') WHERE chat_id = ?').run(resolvedUrl, chatId);

            return { success: true, url: resolvedUrl };
        } catch (e) {
            this.log('error', 'profile_pic', 'Failed to refresh picture for ' + chatId + ': ' + e.message);
            return { success: false, error: e.message };
        }
    }

    async forceDownloadChatMedia(chatId) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');

        try {
            // Find messages with missing media
            // We look for messages that have a media mimetype OR are of media type, but media_url is null
            const missing = this.db.db.prepare(`
                SELECT message_id, timestamp 
                FROM messages 
                WHERE chat_id = ? 
                  AND (type IN ('image', 'video', 'audio', 'ptt', 'document', 'sticker') OR media_mimetype IS NOT NULL)
                  AND media_url IS NULL
                ORDER BY timestamp DESC
                LIMIT 20
            `).all(chatId);

            this.log('info', 'media_recovery', `Found ${missing.length} messages with missing media in ${chatId}`);

            let successCount = 0;

            for (const row of missing) {
                try {
                    this.log('info', 'media_recovery', `Attempting to recover media for ${row.message_id}...`);
                    
                    // 1. Warm up the chat context
                    try {
                        const chat = await this.client.getChatById(chatId);
                        await Promise.race([
                            chat.fetchMessages({ limit: 5 }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Chat warmup timeout')), 10000))
                        ]);
                        await new Promise(r => setTimeout(r, 500));
                    } catch (e) {
                        this.log('warn', 'media_recovery', 'Failed to warm up chat: ' + e.message);
                    }

                    // 2. Fetch the actual message object with a retry/timeout
                    const msg = await Promise.race([
                        this.client.getMessageById(row.message_id),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Message fetch timeout')), 10000))
                    ]);

                    if (!msg || !msg.hasMedia) {
                        this.log('warn', 'media_recovery', `Message ${row.message_id} not found or has no media`);
                        continue;
                    }

                    // 3. Force download with higher retry count and huge timeout
                    const media = await this.downloadMediaWithRetry(msg, 3, 900000); // 3 attempts, 15 min timeout
                    
                    if (media) {
                        const mediaResult = await this.saveMedia(media, row.message_id, row.timestamp); // Timestamp is already stored as ms in DB? No, in saveMedia it expects ms. row.timestamp in DB is ms.
                        
                        // Update DB
                        this.db.db.prepare('UPDATE messages SET media_path = ?, media_url = ?, media_mimetype = ? WHERE message_id = ?')
                            .run(mediaResult.mediaPath, mediaResult.mediaUrl, media.mimetype, row.message_id);

                        // Emit update event
                        this.emit('media_downloaded', {
                            messageId: row.message_id,
                            mediaUrl: mediaResult.mediaUrl,
                            mediaMimetype: media.mimetype
                        });
                        
                        successCount++;
                        this.log('info', 'media_recovery', `Successfully recovered media for ${row.message_id}`);
                    } else {
                        this.log('error', 'media_recovery', `Failed to download media for ${row.message_id}`);
                    }
                    
                    // Wait a bit between files to let GC run and avoid rate limits
                    await new Promise(r => setTimeout(r, 2000));

                } catch (innerErr) {
                    this.log('error', 'media_recovery', `Error processing message ${row.message_id}: ${innerErr.message}`);
                }
            }

            return { success: true, recovered: successCount, total: missing.length };

        } catch (e) {
            this.log('error', 'media_recovery', 'Fatal error in recovery: ' + e.message);
            return { success: false, error: e.message };
        }
    }

    async enqueueMissingMediaAll(options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');

        const requestedLimit = options && options.limit !== undefined ? parseInt(String(options.limit), 10) : NaN;
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, 50000)
            : 10000;

        const rows = this.db.db.prepare(`
            SELECT message_id
            FROM messages
            WHERE (type IN ('image', 'video', 'audio', 'ptt', 'document', 'sticker') OR media_mimetype IS NOT NULL)
              AND media_url IS NULL
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(limit);

        let enqueued = 0;
        for (const row of rows) {
            if (row && row.message_id && this.enqueueMediaDownload(row.message_id)) {
                enqueued++;
            }
        }

        return {
            success: true,
            found: rows.length,
            enqueued,
            queueLength: this.mediaQueue.length
        };
    }

    async logout() {
        if (this.client) {
            try { await this.client.logout(); } catch (e) {}
        }
        this.lastError = null;
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
        this.emitStatus();
    }

    async destroy(options = {}) {
        const preserveError = options && options.preserveError === true;
        if (this.client) {
            try { await this.client.destroy(); } catch (e) {}
            this.client = null;
        }
        if (!preserveError) {
            this.lastError = null;
        }
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
        this.emitStatus();
    }
}

function createWhatsAppClient(config, db, drive) {
    return new WhatsAppClient(config, db, drive);
}

module.exports = { createWhatsAppClient };

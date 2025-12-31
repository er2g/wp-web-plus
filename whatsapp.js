/**
 * WhatsApp Web Panel - WhatsApp Client Module v5 (Optimized)
 * Fast sync with batching, caching, and parallel processing
 */
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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
    PROGRESS_THROTTLE_MS: 500
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
        this.lastProgressEmit = 0;
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
        if (contact) {
            return contact.pushname || contact.name || contact.number || this.extractPhoneFromId(msg.from);
        }
        return this.extractPhoneFromId(msg.author || msg.from);
    }

    getSenderNumber(contact, msg) {
        if (contact && contact.number) {
            return contact.number;
        }
        return this.extractPhoneFromId(msg.author || msg.from);
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
                url = await chat.getProfilePicUrl();
            }
        } catch (e) {
            url = null;
        }
        if (url && this.settings.downloadProfilePictures) {
            try {
                const localUrl = await this.downloadAndSaveProfilePicture(chatId, url);
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
            const filename = timestamp + '_' + cleanId + '.' + ext;
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
            return { mediaPath: localPath, mediaUrl: CONSTANTS.MEDIA_URL_PREFIX + filename };
        } catch (e) {
            this.log('error', 'media', 'Save media failed: ' + e.message);
            return { mediaPath: null, mediaUrl: null };
        }
    }

    async getContactCached(msg) {
        const id = msg.from || msg.author;
        if (!id) return null;
        if (this.contactCache.has(id)) return this.contactCache.get(id);
        try {
            const contact = await msg.getContact();
            this.contactCache.set(id, contact);
            return contact;
        } catch (e) {
            return null;
        }
    }

    async handleMessage(msg, fromMe) {
        try {
            const chat = await msg.getChat();
            const contact = await this.getContactCached(msg);

            const body = this.getMessageBody(msg);
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

    async syncChat(chat) {
        try {
            const chatName = chat.name || chat.id.user;
            const messages = await chat.fetchMessages({ limit: this.settings.maxMessagesPerChat });

            for (const msg of messages) {
                const contact = await this.getContactCached(msg);

                const body = this.getMessageBody(msg);
                const msgData = {
                    messageId: msg.id._serialized,
                    chatId: chat.id._serialized,
                    from: msg.from,
                    to: msg.to,
                    fromName: msg.fromMe ? (this.info ? this.info.pushname : 'Me') : this.getSenderName(contact, msg),
                    fromNumber: msg.fromMe ? (this.info?.wid?.user || this.extractPhoneFromId(msg.from)) : this.getSenderNumber(contact, msg),
                    body,
                    type: msg.type,
                    timestamp: msg.timestamp * 1000,
                    isGroup: chat.isGroup,
                    isFromMe: msg.fromMe,
                    mediaMimetype: msg.mimetype || msg._data?.mimetype
                };

                if (msg.hasMedia && (this.settings.downloadMediaOnSync || this.settings.downloadMedia)) {
                    const media = await this.downloadMediaWithRetry(msg, CONSTANTS.SYNC_MAX_RETRIES, CONSTANTS.SYNC_DOWNLOAD_TIMEOUT_MS);
                    if (media) {
                        const mediaResult = await this.saveMedia(media, msg.id._serialized, msg.timestamp * 1000);
                        msgData.mediaPath = mediaResult.mediaPath;
                        msgData.mediaUrl = mediaResult.mediaUrl;
                        msgData.mediaMimetype = media.mimetype;
                    } else {
                        this.log('warn', 'media', 'Media download failed (sync)', {
                            chatId: chat.id?._serialized,
                            messageId: msg.id?._serialized,
                            type: msg.type
                        });
                    }
                }

                this.db.messages.save.run(
                    msgData.messageId,
                    msgData.chatId,
                    msgData.fromNumber,
                    msgData.to,
                    msgData.fromName,
                    msgData.body,
                    msgData.type,
                    msgData.mediaPath,
                    msgData.mediaUrl,
                    msgData.mediaMimetype,
                    msgData.isGroup ? 1 : 0,
                    msgData.isFromMe ? 1 : 0,
                    msg.ack || 0,
                    msgData.timestamp
                );
            }

            if (messages.length > 0) {
                // Try to get profile pic from cache first
                let profilePic = await this.getChatProfilePic(chat);
                
                // If not in cache or null, try aggressive fetch with timeout
                if (!profilePic) {
                    try {
                         const fetchPic = async (id) => {
                            return Promise.race([
                                this.client.getProfilePicUrl(id),
                                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
                            ]);
                        };
                        profilePic = await fetchPic(chat.id._serialized);
                        if (profilePic) {
                            this.chatProfileCache.set(chat.id._serialized, profilePic);
                        }
                    } catch(e) {}
                }

                const lastMsg = messages[messages.length - 1];
                const lastPreview = this.getMessageBody(lastMsg) || (lastMsg.hasMedia ? (lastMsg.type === 'document' ? '[Dosya]' : '[Medya]') : '');
                
                this.db.chats.upsert.run(
                    chat.id._serialized,
                    chatName,
                    chat.isGroup ? 1 : 0,
                    profilePic,
                    lastPreview.substring(0, 100),
                    lastMsg.timestamp * 1000,
                    chat.unreadCount || 0
                );
            }

            return messages.length;
        } catch (e) {
            this.log('warn', 'sync', 'Chat sync error: ' + (chat.name || chat.id.user));
            return 0;
        }
    }

    async fullSync() {
        if (this.syncProgress.syncing) {
            return { success: false, error: 'Sync already in progress' };
        }

        try {
            this.contactCache.clear();
            this.syncProgress = { syncing: true, current: 0, total: 0, chat: 'Loading chats...' };
            this.emit('sync_progress', this.syncProgress);
            this.log('info', 'sync', 'Starting optimized sync...');

            const chats = await this.client.getChats();
            this.syncProgress.total = chats.length;
            this.emitProgress();

            let totalMessages = 0;
            let processed = 0;

            const processChunk = async (chunk) => {
                const results = await Promise.all(chunk.map(chat => this.syncChat(chat)));
                return results.reduce((a, b) => a + b, 0);
            };

            for (let i = 0; i < chats.length; i += CONSTANTS.PARALLEL_CHATS) {
                const chunk = chats.slice(i, i + CONSTANTS.PARALLEL_CHATS);
                const chunkMessages = await processChunk(chunk);
                totalMessages += chunkMessages;
                processed += chunk.length;

                this.syncProgress.current = processed;
                this.syncProgress.chat = chunk.map(c => c.name || c.id.user).join(', ');
                this.emitProgress();

                // Yield to event loop to prevent blocking
                await new Promise(resolve => setImmediate(resolve));
            }

            this.contactCache.clear();
            this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
            this.emit('sync_progress', this.syncProgress);
            this.emit('sync_complete', { chats: chats.length, messages: totalMessages });
            this.log('info', 'sync', 'Sync complete: ' + chats.length + ' chats, ' + totalMessages + ' messages');

            return { success: true, chats: chats.length, messages: totalMessages };
        } catch (e) {
            this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
            this.emit('sync_progress', this.syncProgress);
            this.log('error', 'sync', 'Sync failed: ' + e.message);
            return { success: false, error: e.message };
        }
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
        if (options.mediaPath) {
            const media = MessageMedia.fromFilePath(options.mediaPath);
            result = await this.client.sendMessage(chatId, media, { caption: message });
        } else {
            result = await this.client.sendMessage(chatId, message);
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
                        // Briefly 'touch' the chat to make it active in browser memory
                        await chat.sendSeen(); 
                        await new Promise(r => setTimeout(r, 1000));
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

/**
 * WhatsApp Web Panel - WhatsApp Client Module v5 (Optimized)
 * Fast sync with batching, caching, and parallel processing
 */
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const config = require('./config');
const db = require('./database');
const fs = require('fs');
const path = require('path');

const CONSTANTS = {
    SYNC_DELAY_MS: 2000,
    DEFAULT_MAX_RETRIES: 3,
    DEFAULT_DOWNLOAD_TIMEOUT_MS: 60000,
    SYNC_DOWNLOAD_TIMEOUT_MS: 15000,
    SYNC_MAX_RETRIES: 1,
    BACKOFF_MULTIPLIER_MS: 1000,
    MEDIA_URL_PREFIX: 'api/media/',
    PARALLEL_CHATS: 5,
    PROGRESS_THROTTLE_MS: 500
};

let driveService = null;
function getDrive() {
    if (!driveService) {
        try { driveService = require('./drive'); } catch (e) {}
    }
    return driveService;
}

class WhatsAppClient {
    constructor() {
        this.client = null;
        this.qrCode = null;
        this.status = 'disconnected';
        this.info = null;
        this.io = null;
        this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
        this.settings = {
            downloadMedia: true,
            syncOnConnect: true,
            maxMessagesPerChat: 50,
            uploadToDrive: true,
            downloadMediaOnSync: false
        };
        this.contactCache = new Map();
        this.lastProgressEmit = 0;
    }

    getSenderName(contact, msg) {
        if (contact) {
            return contact.pushname || contact.name || contact.number || this.extractPhoneFromId(msg.from);
        }
        return this.extractPhoneFromId(msg.from);
    }

    extractPhoneFromId(id) {
        if (!id) return 'Unknown';
        return id.split('@')[0] || 'Unknown';
    }

    setSocketIO(io) { this.io = io; }

    emit(event, data) { if (this.io) this.io.emit(event, data); }

    emitProgress() {
        const now = Date.now();
        if (now - this.lastProgressEmit >= CONSTANTS.PROGRESS_THROTTLE_MS) {
            this.emit('sync_progress', this.syncProgress);
            this.lastProgressEmit = now;
        }
    }

    log(level, category, message, data = null) {
        try {
            db.logs.add.run(level, category, message, data ? JSON.stringify(data) : null);
        } catch (e) {}
        console.log('[' + level.toUpperCase() + '] [' + category + '] ' + message);
    }

    async initialize() {
        if (this.client) await this.destroy();
        this.client = new Client({
            authStrategy: new LocalAuth({ dataPath: config.SESSION_DIR }),
            puppeteer: { headless: true, args: config.PUPPETEER_ARGS }
        });
        this.setupEventHandlers();
        this.log('info', 'whatsapp', 'Initializing WhatsApp client...');
        await this.client.initialize();
    }

    setupEventHandlers() {
        this.client.on('qr', async (qr) => {
            this.status = 'qr';
            this.qrCode = await qrcode.toDataURL(qr);
            this.emit('qr', this.qrCode);
        });

        this.client.on('ready', async () => {
            this.status = 'ready';
            this.info = this.client.info;
            this.qrCode = null;
            this.emit('ready', { pushname: this.info.pushname, wid: this.info.wid.user });
            this.log('info', 'whatsapp', 'Connected as ' + this.info.pushname);

            const drive = getDrive();
            if (drive) drive.initialize().catch(() => {});

            if (this.settings.syncOnConnect) {
                setTimeout(() => this.fullSync(), CONSTANTS.SYNC_DELAY_MS);
            }
        });

        this.client.on('authenticated', () => {
            this.status = 'authenticated';
            this.emit('authenticated');
            this.log('info', 'whatsapp', 'Authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            this.status = 'auth_failure';
            this.emit('auth_failure', msg);
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            this.info = null;
            this.emit('disconnected', reason);
        });

        this.client.on('message', async (msg) => {
            await this.handleMessage(msg, false);
        });

        this.client.on('message_create', async (msg) => {
            if (msg.fromMe) await this.handleMessage(msg, true);
        });
    }

    async downloadMediaWithRetry(msg, maxRetries = CONSTANTS.DEFAULT_MAX_RETRIES, timeoutMs = CONSTANTS.DEFAULT_DOWNLOAD_TIMEOUT_MS) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const media = await Promise.race([
                    msg.downloadMedia(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
                ]);
                if (media && media.data) return media;
            } catch (e) {
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, CONSTANTS.BACKOFF_MULTIPLIER_MS * attempt));
                }
            }
        }
        return null;
    }

    async saveMedia(media, msgId, timestamp) {
        if (!media || !media.data) return { mediaPath: null, mediaUrl: null };
        try {
            const ext = (media.mimetype.split('/')[1] || 'bin').split(';')[0];
            const filename = timestamp + '_' + msgId.replace(/[^a-zA-Z0-9]/g, '_') + '.' + ext;
            const localPath = path.join(config.MEDIA_DIR, filename);
            fs.writeFileSync(localPath, Buffer.from(media.data, 'base64'));

            const drive = getDrive();
            if (this.settings.uploadToDrive && drive) {
                try {
                    if (await drive.initialize()) {
                        const result = await drive.uploadFile(localPath, media.mimetype);
                        if (result) {
                            fs.unlinkSync(localPath);
                            return { mediaPath: null, mediaUrl: result.downloadLink };
                        }
                    }
                } catch (e) {}
            }
            return { mediaPath: localPath, mediaUrl: CONSTANTS.MEDIA_URL_PREFIX + filename };
        } catch (e) {
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
            let mediaPath = null, mediaUrl = null;

            if (this.settings.downloadMedia && msg.hasMedia) {
                const media = await this.downloadMediaWithRetry(msg);
                if (media) {
                    const saved = await this.saveMedia(media, msg.id._serialized, Date.now());
                    mediaPath = saved.mediaPath;
                    mediaUrl = saved.mediaUrl;
                }
            }

            const fromName = this.getSenderName(contact, msg);

            db.messages.save.run(
                msg.id._serialized, chat.id._serialized, msg.from, msg.to,
                fromName, msg.body || '', msg.type, mediaPath, mediaUrl,
                null, chat.isGroup ? 1 : 0, fromMe ? 1 : 0, msg.timestamp * 1000
            );

            db.chats.upsert.run(
                chat.id._serialized,
                chat.name || (contact ? contact.pushname : null) || chat.id.user,
                chat.isGroup ? 1 : 0, null, (msg.body || '').substring(0, 100),
                msg.timestamp * 1000, 0
            );

            const msgData = {
                id: msg.id._serialized, chatId: chat.id._serialized,
                from: msg.from, to: msg.to, fromName, body: msg.body || '',
                type: msg.type, mediaUrl, isGroup: chat.isGroup,
                isFromMe: fromMe, timestamp: msg.timestamp * 1000
            };

            this.emit('message', msgData);
            return { msg, chat, contact, msgData };
        } catch (e) {
            return null;
        }
    }

    async syncChat(chat) {
        try {
            const contact = !chat.isGroup ? await chat.getContact().catch(() => null) : null;
            const chatName = chat.name || (contact ? contact.pushname : null) || chat.id.user;

            db.chats.upsert.run(
                chat.id._serialized, chatName, chat.isGroup ? 1 : 0,
                null, '', Date.now(), chat.unreadCount || 0
            );

            const messages = await chat.fetchMessages({ limit: this.settings.maxMessagesPerChat });

            for (const msg of messages) {
                try {
                    let mediaPath = null, mediaUrl = null;

                    if (this.settings.downloadMediaOnSync && msg.hasMedia) {
                        const media = await this.downloadMediaWithRetry(msg, CONSTANTS.SYNC_MAX_RETRIES, CONSTANTS.SYNC_DOWNLOAD_TIMEOUT_MS);
                        if (media) {
                            const saved = await this.saveMedia(media, msg.id._serialized, msg.timestamp);
                            mediaPath = saved.mediaPath;
                            mediaUrl = saved.mediaUrl;
                        }
                    }

                    let senderName;
                    const senderId = msg.from || msg.author;
                    if (this.contactCache.has(senderId)) {
                        senderName = this.getSenderName(this.contactCache.get(senderId), msg);
                    } else {
                        senderName = this.extractPhoneFromId(msg.from);
                    }

                    db.messages.save.run(
                        msg.id._serialized, chat.id._serialized, msg.from || '', msg.to || '',
                        senderName, msg.body || '', msg.type || 'chat', mediaPath, mediaUrl,
                        null, chat.isGroup ? 1 : 0, msg.fromMe ? 1 : 0, msg.timestamp * 1000
                    );
                } catch (e) {}
            }

            if (messages.length > 0) {
                const lastMsg = messages[messages.length - 1];
                db.chats.upsert.run(
                    chat.id._serialized, chatName, chat.isGroup ? 1 : 0, null,
                    (lastMsg.body || '').substring(0, 100), lastMsg.timestamp * 1000,
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
        this.settings = { ...this.settings, ...newSettings };
        return this.settings;
    }

    getSettings() { return this.settings; }
    getSyncProgress() { return this.syncProgress; }

    async sendMessage(chatId, message, options = {}) {
        if (!this.isReady()) throw new Error('WhatsApp not connected');
        try {
            let result;
            if (options.mediaPath) {
                const media = MessageMedia.fromFilePath(options.mediaPath);
                result = await this.client.sendMessage(chatId, media, { caption: message });
            } else {
                result = await this.client.sendMessage(chatId, message);
            }
            this.log('info', 'message', 'Message sent to ' + chatId);
            return result;
        } catch (e) {
            throw e;
        }
    }

    isReady() { return this.status === 'ready' && this.client; }

    getStatus() {
        return {
            status: this.status, qrCode: this.qrCode,
            info: this.info ? { pushname: this.info.pushname, wid: this.info.wid.user, platform: this.info.platform } : null,
            syncProgress: this.syncProgress, settings: this.settings
        };
    }

    async logout() {
        if (this.client) {
            try { await this.client.logout(); } catch (e) {}
        }
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
    }

    async destroy() {
        if (this.client) {
            try { await this.client.destroy(); } catch (e) {}
            this.client = null;
        }
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
    }
}

module.exports = new WhatsAppClient();

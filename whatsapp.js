/**
 * WhatsApp Web Panel - WhatsApp Client Module v5 (Optimized)
 * Fast sync with batching, caching, and parallel processing
 */
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const CONSTANTS = {
    SYNC_DELAY_MS: 2000,
    DEFAULT_MAX_RETRIES: 5,
    DEFAULT_DOWNLOAD_TIMEOUT_MS: 120000,
    SYNC_DOWNLOAD_TIMEOUT_MS: 45000,
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

    normalizeSettings(input) {
        if (!input || typeof input !== 'object') return {};
        const output = {};

        if (typeof input.downloadMedia === 'boolean') output.downloadMedia = input.downloadMedia;
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
            return this.chatProfileCache.get(chatId);
        }
        let url = null;
        try {
            if (typeof chat.getProfilePicUrl === 'function') {
                url = await chat.getProfilePicUrl();
            }
        } catch (e) {
            url = null;
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
            try {
                const media = await Promise.race([
                    msg.downloadMedia(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
                ]);
                if (media && media.data) return media;
            } catch (e) {
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, CONSTANTS.BACKOFF_MULTIPLIER_MS * attempt));
                    continue;
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
            const localPath = path.join(this.config.MEDIA_DIR, filename);
            fs.writeFileSync(localPath, Buffer.from(media.data, 'base64'));

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
                mediaMimetype: msg.mimetype || msg._data?.mimetype
            };

            if (msg.hasMedia && this.settings.downloadMedia) {
                const media = await this.downloadMediaWithRetry(msg);
                if (media) {
                    const mediaResult = await this.saveMedia(media, msg.id._serialized, msg.timestamp * 1000);
                    msgData.mediaPath = mediaResult.mediaPath;
                    msgData.mediaUrl = mediaResult.mediaUrl;
                    msgData.mediaMimetype = media.mimetype;
                } else {
                    this.log('warn', 'media', 'Media download failed', {
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
                const profilePic = await this.getChatProfilePic(chat);
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

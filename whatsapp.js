/**
 * WhatsApp Web Panel - WhatsApp Client Module v4
 * Full message sync with media download retry and Drive integration
 */
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const config = require('./config');
const db = require('./database');
const fs = require('fs');
const path = require('path');

// Constants
const CONSTANTS = {
    SYNC_DELAY_MS: 2000,
    SYNC_THROTTLE_MS: 100,
    DEFAULT_MAX_RETRIES: 3,
    DEFAULT_DOWNLOAD_TIMEOUT_MS: 60000,
    SYNC_DOWNLOAD_TIMEOUT_MS: 30000,
    SYNC_MAX_RETRIES: 2,
    BACKOFF_MULTIPLIER_MS: 2000,
    MEDIA_URL_PREFIX: 'api/media/'
};

// Drive servisi (lazy load)
let driveService = null;
function getDrive() {
    if (!driveService) {
        try {
            driveService = require('./drive');
        } catch (e) {
            // Drive module not available - this is expected in some environments
        }
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
            maxMessagesPerChat: 100,
            uploadToDrive: true  // Medyalari Drive'a yukle
        };
    }

    /**
     * Safely extract sender name from contact or message
     * @param {Object|null} contact - Contact object
     * @param {Object} msg - Message object
     * @returns {string} Sender name
     */
    getSenderName(contact, msg) {
        if (contact) {
            return contact.pushname || contact.name || contact.number || this.extractPhoneFromId(msg.from);
        }
        return this.extractPhoneFromId(msg.from);
    }

    /**
     * Extract phone number from WhatsApp ID
     * @param {string} id - WhatsApp ID (e.g., "905551234567@c.us")
     * @returns {string} Phone number or "Unknown"
     */
    extractPhoneFromId(id) {
        if (!id) return 'Unknown';
        return id.split('@')[0] || 'Unknown';
    }

    setSocketIO(io) {
        this.io = io;
    }

    emit(event, data) {
        if (this.io) this.io.emit(event, data);
    }

    log(level, category, message, data = null) {
        const logData = data ? JSON.stringify(data) : null;
        try {
            db.logs.add.run(level, category, message, logData);
        } catch (e) {
            // Database logging failed - still output to console
            console.error('[LOG_ERROR] Failed to write log to database:', e.message);
        }
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
            this.log('info', 'whatsapp', 'QR code generated');
        });

        this.client.on('ready', async () => {
            this.status = 'ready';
            this.info = this.client.info;
            this.qrCode = null;
            this.emit('ready', { pushname: this.info.pushname, wid: this.info.wid.user });
            this.log('info', 'whatsapp', 'Connected as ' + this.info.pushname);

            // Drive'i baslat
            const drive = getDrive();
            if (drive) {
                drive.initialize().catch(e => this.log('warn', 'drive', 'Drive init failed: ' + e.message));
            }

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
            this.log('error', 'whatsapp', 'Authentication failed', { error: msg });
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            this.info = null;
            this.emit('disconnected', reason);
            this.log('warn', 'whatsapp', 'Disconnected', { reason });
        });

        this.client.on('message', async (msg) => {
            await this.handleMessage(msg, false);
        });

        this.client.on('message_create', async (msg) => {
            if (msg.fromMe) await this.handleMessage(msg, true);
        });
    }

    /**
     * Medya indirme - retry mekanizmasi ile
     */
    async downloadMediaWithRetry(msg, maxRetries = CONSTANTS.DEFAULT_MAX_RETRIES, timeoutMs = CONSTANTS.DEFAULT_DOWNLOAD_TIMEOUT_MS) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Timeout ile download
                const media = await Promise.race([
                    msg.downloadMedia(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Download timeout')), timeoutMs)
                    )
                ]);

                if (media && media.data) {
                    this.log('info', 'media', `Downloaded media on attempt ${attempt}`);
                    return media;
                }
            } catch (e) {
                this.log('warn', 'media', `Download attempt ${attempt}/${maxRetries} failed: ${e.message}`);

                if (attempt < maxRetries) {
                    // Exponential backoff
                    const waitTime = CONSTANTS.BACKOFF_MULTIPLIER_MS * attempt;
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }
        }

        this.log('error', 'media', `Failed to download media after ${maxRetries} attempts`);
        return null;
    }

    /**
     * Medyayi kaydet (lokal veya Drive)
     */
    async saveMedia(media, msgId, timestamp) {
        if (!media || !media.data) return { mediaPath: null, mediaUrl: null };

        try {
            const ext = (media.mimetype.split('/')[1] || 'bin').split(';')[0];
            const filename = timestamp + '_' + msgId.replace(/[^a-zA-Z0-9]/g, '_') + '.' + ext;
            const localPath = path.join(config.MEDIA_DIR, filename);

            // Dosyayi lokal olarak kaydet
            const buffer = Buffer.from(media.data, 'base64');
            fs.writeFileSync(localPath, buffer);

            // Drive yukleme aktifse
            const drive = getDrive();
            if (this.settings.uploadToDrive && drive) {
                try {
                    const initialized = await drive.initialize();
                    if (initialized) {
                        const result = await drive.uploadFile(localPath, media.mimetype);
                        if (result) {
                            // Lokal dosyayi sil
                            fs.unlinkSync(localPath);
                            return {
                                mediaPath: null,
                                mediaUrl: result.downloadLink
                            };
                        }
                    }
                } catch (driveError) {
                    this.log('warn', 'drive', 'Drive upload failed, keeping local: ' + driveError.message);
                }
            }

            // Drive basarisiz veya devre disi ise lokal path dondur
            return {
                mediaPath: localPath,
                mediaUrl: CONSTANTS.MEDIA_URL_PREFIX + filename
            };
        } catch (error) {
            this.log('error', 'media', 'Save media failed: ' + error.message);
            return { mediaPath: null, mediaUrl: null };
        }
    }

    async handleMessage(msg, fromMe) {
        try {
            const chat = await msg.getChat();
            const contact = await msg.getContact();
            let mediaPath = null;
            let mediaUrl = null;

            // Medya indir
            if (this.settings.downloadMedia && msg.hasMedia) {
                const media = await this.downloadMediaWithRetry(msg);
                if (media) {
                    const saved = await this.saveMedia(media, msg.id._serialized, Date.now());
                    mediaPath = saved.mediaPath;
                    mediaUrl = saved.mediaUrl;
                }
            }

            // Gonderici ismini al (null-safe)
            const fromName = this.getSenderName(contact, msg);

            db.messages.save.run(
                msg.id._serialized,
                chat.id._serialized,
                msg.from,
                msg.to,
                fromName,
                msg.body || '',
                msg.type,
                mediaPath,
                mediaUrl,
                null, // media_mimetype
                chat.isGroup ? 1 : 0,
                fromMe ? 1 : 0,
                msg.timestamp * 1000
            );

            db.chats.upsert.run(
                chat.id._serialized,
                chat.name || contact.pushname || contact.number || chat.id.user,
                chat.isGroup ? 1 : 0,
                null,
                (msg.body || '').substring(0, 100),
                msg.timestamp * 1000,
                0
            );

            const msgData = {
                id: msg.id._serialized,
                chatId: chat.id._serialized,
                from: msg.from,
                to: msg.to,
                fromName: fromName,
                body: msg.body || '',
                type: msg.type,
                mediaUrl: mediaUrl,
                isGroup: chat.isGroup,
                isFromMe: fromMe,
                timestamp: msg.timestamp * 1000
            };

            this.emit('message', msgData);
            return { msg, chat, contact, msgData };
        } catch (error) {
            this.log('error', 'message', 'Error handling message', { error: error.message });
            return null;
        }
    }

    async fullSync() {
        if (this.syncProgress.syncing) {
            return { success: false, error: 'Sync already in progress' };
        }

        try {
            this.syncProgress = { syncing: true, current: 0, total: 0, chat: 'Starting...' };
            this.emit('sync_progress', this.syncProgress);
            this.log('info', 'sync', 'Starting full sync...');

            const chats = await this.client.getChats();
            this.syncProgress.total = chats.length;
            this.emit('sync_progress', this.syncProgress);

            let totalMessages = 0;

            for (let i = 0; i < chats.length; i++) {
                const chat = chats[i];
                this.syncProgress.current = i + 1;
                this.syncProgress.chat = chat.name || chat.id.user;
                this.emit('sync_progress', this.syncProgress);

                try {
                    const contact = !chat.isGroup ? await chat.getContact().catch(() => null) : null;
                    db.chats.upsert.run(
                        chat.id._serialized,
                        chat.name || (contact ? contact.pushname : null) || chat.id.user,
                        chat.isGroup ? 1 : 0,
                        null,
                        '',
                        Date.now(),
                        chat.unreadCount || 0
                    );

                    const messages = await chat.fetchMessages({ limit: this.settings.maxMessagesPerChat });

                    for (const msg of messages) {
                        try {
                            let mediaPath = null;
                            let mediaUrl = null;

                            if (this.settings.downloadMedia && msg.hasMedia) {
                                const media = await this.downloadMediaWithRetry(msg, CONSTANTS.SYNC_MAX_RETRIES, CONSTANTS.SYNC_DOWNLOAD_TIMEOUT_MS);
                                if (media) {
                                    const saved = await this.saveMedia(media, msg.id._serialized, msg.timestamp);
                                    mediaPath = saved.mediaPath;
                                    mediaUrl = saved.mediaUrl;
                                }
                            }

                            const msgContact = await msg.getContact().catch(() => null);
                            const senderName = this.getSenderName(msgContact, msg);

                            db.messages.save.run(
                                msg.id._serialized,
                                chat.id._serialized,
                                msg.from || '',
                                msg.to || '',
                                senderName,
                                msg.body || '',
                                msg.type || 'chat',
                                mediaPath,
                                mediaUrl,
                                null, // media_mimetype
                                chat.isGroup ? 1 : 0,
                                msg.fromMe ? 1 : 0,
                                msg.timestamp * 1000
                            );
                            totalMessages++;
                        } catch (e) {
                            // Log message processing error but continue with other messages
                            this.log('debug', 'sync', 'Message processing error: ' + e.message);
                        }
                    }

                    if (messages.length > 0) {
                        const lastMsg = messages[messages.length - 1];
                        db.chats.upsert.run(
                            chat.id._serialized,
                            chat.name || (contact ? contact.pushname : null) || chat.id.user,
                            chat.isGroup ? 1 : 0,
                            null,
                            (lastMsg.body || '').substring(0, 100),
                            lastMsg.timestamp * 1000,
                            chat.unreadCount || 0
                        );
                    }

                } catch (error) {
                    this.log('warn', 'sync', 'Error syncing chat ' + chat.name, { error: error.message });
                }

                await new Promise(r => setTimeout(r, CONSTANTS.SYNC_THROTTLE_MS));
            }

            this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
            this.emit('sync_progress', this.syncProgress);
            this.emit('sync_complete', { chats: chats.length, messages: totalMessages });
            this.log('info', 'sync', 'Sync complete: ' + chats.length + ' chats, ' + totalMessages + ' messages');

            return { success: true, chats: chats.length, messages: totalMessages };
        } catch (error) {
            this.syncProgress = { syncing: false, current: 0, total: 0, chat: '' };
            this.emit('sync_progress', this.syncProgress);
            this.log('error', 'sync', 'Sync failed', { error: error.message });
            return { success: false, error: error.message };
        }
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.log('info', 'settings', 'Settings updated', this.settings);
        return this.settings;
    }

    getSettings() {
        return this.settings;
    }

    getSyncProgress() {
        return this.syncProgress;
    }

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
        } catch (error) {
            this.log('error', 'message', 'Error sending message', { error: error.message });
            throw error;
        }
    }

    isReady() {
        return this.status === 'ready' && this.client;
    }

    getStatus() {
        return {
            status: this.status,
            qrCode: this.qrCode,
            info: this.info ? {
                pushname: this.info.pushname,
                wid: this.info.wid.user,
                platform: this.info.platform
            } : null,
            syncProgress: this.syncProgress,
            settings: this.settings
        };
    }

    async logout() {
        if (this.client) {
            try {
                await this.client.logout();
                this.log('info', 'whatsapp', 'Logged out');
            } catch (error) {
                this.log('warn', 'whatsapp', 'Logout error: ' + error.message);
            }
        }
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
    }

    async destroy() {
        if (this.client) {
            try {
                await this.client.destroy();
            } catch (e) {
                this.log('warn', 'whatsapp', 'Destroy error: ' + e.message);
            }
            this.client = null;
        }
        this.status = 'disconnected';
        this.info = null;
        this.qrCode = null;
    }
}

module.exports = new WhatsAppClient();

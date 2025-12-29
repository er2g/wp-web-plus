const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createDatabase } = require('../database');
const { createWhatsAppClient } = require('../whatsapp');
const { createDriveService } = require('../drive');
const { createAutoReplyService } = require('./autoReply');
const { createCleanupService } = require('./cleanup');
const { createSchedulerService } = require('./scheduler');
const { createWebhookService } = require('./webhook');
const { createScriptRunner } = require('./scriptRunner');
const { logger } = require('./logger');

const ACCOUNTS_FILE = path.join(config.DATA_DIR, 'accounts.json');
const ACCOUNTS_DIR = path.join(config.DATA_DIR, 'accounts');
const DEFAULT_ACCOUNT_ID = 'default';

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function readAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
            if (Array.isArray(data.accounts)) {
                return data.accounts;
            }
        }
    } catch (error) {
        logger.error('Failed to read accounts', { category: 'accounts', error: error.message });
    }
    return [];
}

function writeAccounts(accounts) {
    ensureDir(config.DATA_DIR);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts }, null, 2));
}

function createAccountId(name) {
    const slug = (name || 'account')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 24);
    const suffix = Math.random().toString(36).slice(2, 6);
    return `${slug || 'account'}-${suffix}`;
}

function isValidAccountId(accountId) {
    return typeof accountId === 'string' && /^[a-z0-9-]{1,40}$/.test(accountId);
}

function getAccountConfig(accountId) {
    const accountDataDir = path.join(ACCOUNTS_DIR, accountId);
    return {
        ...config,
        DATA_DIR: accountDataDir,
        SESSION_DIR: path.join(accountDataDir, 'session'),
        DB_PATH: path.join(accountDataDir, 'whatsapp.db'),
        LOGS_DIR: path.join(accountDataDir, 'logs'),
        MEDIA_DIR: path.join(accountDataDir, 'media')
    };
}

function migrateLegacyData(accountConfig) {
    const legacyEntries = [
        { from: config.DB_PATH, to: accountConfig.DB_PATH },
        { from: config.MEDIA_DIR, to: accountConfig.MEDIA_DIR },
        { from: config.SESSION_DIR, to: accountConfig.SESSION_DIR },
        { from: path.join(config.DATA_DIR, 'drive-token.json'), to: path.join(accountConfig.DATA_DIR, 'drive-token.json') },
        { from: path.join(config.DATA_DIR, 'drive-oauth-credentials.json'), to: path.join(accountConfig.DATA_DIR, 'drive-oauth-credentials.json') }
    ];

    legacyEntries.forEach(({ from, to }) => {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
            ensureDir(path.dirname(to));
            try {
                fs.renameSync(from, to);
            } catch (error) {
                logger.warn('Legacy data move failed', {
                    category: 'accounts',
                    from,
                    error: error.message
                });
            }
        }
    });
}

class AccountManager {
    constructor() {
        ensureDir(config.DATA_DIR);
        ensureDir(ACCOUNTS_DIR);

        this.accounts = readAccounts();
        if (this.accounts.length === 0) {
            this.accounts = [
                { id: DEFAULT_ACCOUNT_ID, name: 'Varsayilan Hesap', createdAt: Date.now() }
            ];
            writeAccounts(this.accounts);
        }

        this.contexts = new Map();
        this.io = null;

        const defaultConfig = getAccountConfig(DEFAULT_ACCOUNT_ID);
        migrateLegacyData(defaultConfig);
    }

    getDefaultAccountId() {
        return this.accounts[0]?.id || DEFAULT_ACCOUNT_ID;
    }

    listAccounts() {
        return this.accounts.map(account => ({ ...account }));
    }

    findAccount(accountId) {
        return this.accounts.find(account => account.id === accountId) || null;
    }

    createAccount(name) {
        const accountName = (name || 'Yeni Hesap').trim().slice(0, 60) || 'Yeni Hesap';
        let accountId = createAccountId(accountName);
        while (this.findAccount(accountId)) {
            accountId = createAccountId(accountName);
        }

        const account = { id: accountId, name: accountName, createdAt: Date.now() };
        this.accounts.push(account);
        writeAccounts(this.accounts);
        return account;
    }

    getAccountContext(accountId) {
        const resolvedId = this.findAccount(accountId) ? accountId : this.getDefaultAccountId();
        if (this.contexts.has(resolvedId)) {
            return this.contexts.get(resolvedId);
        }

        const account = this.findAccount(resolvedId) || { id: resolvedId, name: 'Varsayilan Hesap' };
        const accountConfig = getAccountConfig(resolvedId);
        ensureDir(accountConfig.DATA_DIR);
        ensureDir(accountConfig.MEDIA_DIR);
        ensureDir(accountConfig.SESSION_DIR);
        ensureDir(accountConfig.LOGS_DIR);

        const db = createDatabase(accountConfig);
        const drive = createDriveService(accountConfig);
        const whatsapp = createWhatsAppClient(accountConfig, db, drive);
        const autoReply = createAutoReplyService(db, whatsapp);
        const cleanup = createCleanupService(db, config);
        const scheduler = createSchedulerService(db, whatsapp, config);
        const webhook = createWebhookService(db, config);
        const scriptRunner = createScriptRunner(db, whatsapp);

        const context = {
            account,
            config: accountConfig,
            db,
            drive,
            whatsapp,
            autoReply,
            cleanup,
            scheduler,
            webhook,
            scriptRunner
        };

        const originalHandleMessage = whatsapp.handleMessage.bind(whatsapp);
        whatsapp.handleMessage = async (msg, fromMe) => {
            const result = await originalHandleMessage(msg, fromMe);

            if (result) {
                if (!fromMe) {
                    await autoReply.processMessage(result.msgData);
                }

                await webhook.trigger('message', result.msgData);
                await scriptRunner.processMessage(result.msgData);
            }

            return result;
        };

        if (this.io) {
            whatsapp.setSocketIO(this.io, resolvedId);
        }

        scheduler.start();
        cleanup.start();

        this.contexts.set(resolvedId, context);
        return context;
    }

    setSocketIO(io) {
        this.io = io;
        for (const [accountId, context] of this.contexts.entries()) {
            context.whatsapp.setSocketIO(io, accountId);
        }
    }

    attachAccount(req, res, next) {
        const headerAccountId = req.headers['x-account-id'];
        const queryAccountId = req.query.accountId;
        const sessionAccountId = req.session?.accountId;
        const accountId = headerAccountId || queryAccountId || sessionAccountId || this.getDefaultAccountId();

        if (!isValidAccountId(accountId)) {
            return res.status(400).json({ error: 'Invalid account id' });
        }

        const account = this.findAccount(accountId);
        if (!account) {
            const fallbackId = this.getDefaultAccountId();
            const fallbackAccount = this.findAccount(fallbackId);
            if (fallbackAccount) {
                req.session.accountId = fallbackId;
                req.account = this.getAccountContext(fallbackId);
                return next();
            }
            return res.status(404).json({ error: 'Account not found' });
        }

        req.session.accountId = accountId;
        req.account = this.getAccountContext(accountId);
        return next();
    }

    async shutdown() {
        for (const context of this.contexts.values()) {
            context.cleanup.stop();
            context.scheduler.stop();
            await context.whatsapp.destroy();
        }
    }
}

module.exports = new AccountManager();

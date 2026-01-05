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
const { createMessagePipeline } = require('./messagePipeline');
const { logger } = require('./logger');
const { sendError } = require('../lib/httpResponses');
const { CryptoLockedError, unwrapDataKey, wrapDataKey, keyringAad, vault } = require('./encryption');

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
        ACCOUNT_ID: accountId,
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
        this.metrics = null;
        this.jobQueue = null;

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
        const cleanup = createCleanupService(db, config, this.metrics, { accountId: resolvedId });
        const scheduler = createSchedulerService(db, whatsapp, config, this.metrics, { accountId: resolvedId });
        const webhook = createWebhookService(db, config, this.metrics, { accountId: resolvedId });
        const scriptRunner = createScriptRunner(db, whatsapp);
        const messagePipeline = createMessagePipeline({
            autoReply,
            webhook,
            scriptRunner,
            logger,
            metrics: this.metrics,
            options: {
                concurrency: config.MESSAGE_PIPELINE?.CONCURRENCY,
                queueLimit: config.MESSAGE_PIPELINE?.QUEUE_LIMIT
            }
        });

        const useJobQueue = Boolean(this.jobQueue?.isEnabled?.());
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
            scriptRunner,
            messagePipeline,
            jobQueue: this.jobQueue || null,
            jobQueueEnabled: useJobQueue
        };

        const originalHandleMessage = whatsapp.handleMessage.bind(whatsapp);
        whatsapp.handleMessage = async (msg, fromMe) => {
            const result = await originalHandleMessage(msg, fromMe);

            if (result) {
                const msgData = result.msgData;
                const messageId = msgData?.messageId;
                const direction = fromMe ? 'outgoing' : 'incoming';
                const now = Date.now();
                const ownerId = config.INSTANCE_ID || String(process.pid);
                const claimTtl = config.MESSAGE_PIPELINE?.CLAIM_TTL_MS || (10 * 60 * 1000);
                const doneTtl = config.MESSAGE_PIPELINE?.DONE_TTL_MS || (30 * 24 * 60 * 60 * 1000);

                let claimed = true;
                try {
                    if (messageId && db?.messagePipelineDedupe?.claim?.run) {
                        const claimRes = db.messagePipelineDedupe.claim.run(
                            messageId,
                            direction,
                            ownerId,
                            now,
                            now,
                            now + claimTtl
                        );
                        claimed = Boolean(claimRes && claimRes.changes > 0);
                    }
                } catch (e) {
                    claimed = true;
                }

                if (claimed) {
                    const accepted = messagePipeline.enqueue(
                        { msgData, fromMe, accountId: resolvedId },
                        {
                            onDone: (error) => {
                                const ts = Date.now();
                                try {
                                    if (error) {
                                        db?.messagePipelineDedupe?.release?.run?.(ts, ts, messageId, direction, ownerId);
                                    } else {
                                        db?.messagePipelineDedupe?.markDone?.run?.(ownerId, ts, ts + doneTtl, messageId, direction);
                                    }
                                } catch (e) {}
                            }
                        }
                    );
                    if (!accepted) {
                        try {
                            db?.messagePipelineDedupe?.release?.run?.(now, now, messageId, direction, ownerId);
                        } catch (e) {}
                    }
                }
            }

            return result;
        };

        if (this.io) {
            whatsapp.setSocketIO(this.io, resolvedId);
        }

        if (config.ENABLE_BACKGROUND_JOBS) {
            if (useJobQueue) {
                Promise.resolve(this.jobQueue.ensureCleanupJobs(resolvedId))
                    .then(() => this.jobQueue.syncScheduledJobs(resolvedId))
                    .catch((error) => {
                        logger.error('Job queue bootstrap failed', { category: 'jobs', accountId: resolvedId, error: error.message });
                    });
                try { cleanup.runDailyCleanup(); } catch (e) {}
                try { cleanup.runWeeklyCleanup(); } catch (e) {}
                logger.info('Background jobs scheduled via Redis queue', { category: 'jobs', accountId: resolvedId });
            } else {
                scheduler.start();
                cleanup.start();
            }
        } else {
            logger.info('Background jobs disabled', { category: 'lifecycle', accountId: resolvedId });
        }

        this.contexts.set(resolvedId, context);
        return context;
    }

    setSocketIO(io) {
        this.io = io;
        for (const [accountId, context] of this.contexts.entries()) {
            context.whatsapp.setSocketIO(io, accountId);
        }
    }

    setMetrics(metrics) {
        this.metrics = metrics || null;
        for (const context of this.contexts.values()) {
            try {
                context.webhook?.setMetrics?.(this.metrics);
            } catch (e) {}
            try {
                context.scheduler?.setMetrics?.(this.metrics);
            } catch (e) {}
            try {
                context.cleanup?.setMetrics?.(this.metrics);
            } catch (e) {}
        }
    }

    setJobQueue(jobQueue) {
        this.jobQueue = jobQueue || null;
    }

    attachAccount(req, res, next) {
        const headerAccountId = req.headers['x-account-id'];
        const queryAccountId = req.query.accountId;
        const sessionAccountId = req.session?.accountId;
        const accountId = headerAccountId || queryAccountId || sessionAccountId || this.getDefaultAccountId();

        if (!isValidAccountId(accountId)) {
            return sendError(req, res, 400, 'Invalid account id');
        }

        const account = this.findAccount(accountId);
        if (!account) {
            const fallbackId = this.getDefaultAccountId();
            const fallbackAccount = this.findAccount(fallbackId);
            if (fallbackAccount) {
                req.session.accountId = fallbackId;
                const unlockResult = this.ensureAccountUnlocked({
                    sessionId: req.sessionID,
                    userId: req.session?.userId,
                    accountId: fallbackId
                });
                if (!unlockResult.ok) {
                    return sendError(req, res, unlockResult.status, unlockResult.error);
                }
                req.account = this.getAccountContext(fallbackId);
                return next();
            }
            return sendError(req, res, 404, 'Account not found');
        }

        req.session.accountId = accountId;
        const unlockResult = this.ensureAccountUnlocked({
            sessionId: req.sessionID,
            userId: req.session?.userId,
            accountId
        });
        if (!unlockResult.ok) {
            return sendError(req, res, unlockResult.status, unlockResult.error);
        }
        req.account = this.getAccountContext(accountId);
        return next();
    }

    ensureAccountUnlocked({ sessionId, userId, accountId } = {}) {
        try {
            if (!vault.hasSession(sessionId)) {
                throw new CryptoLockedError();
            }

            const existingDek = vault.getAccountKey(accountId);
            if (existingDek) {
                vault.trackSessionOnAccount(sessionId, accountId);
                // Best-effort provisioning: if keyring mode is on and user is missing a wrapped DEK,
                // store it while the account is unlocked.
                try {
                    const authDb = this.getAccountContext(this.getDefaultAccountId()).db;
                    const keyringCount = authDb.userKeyrings?.countByAccount?.get(accountId)?.count || 0;
                    if (keyringCount > 0 && authDb.userKeyrings?.getByUserAndAccount && !authDb.userKeyrings.getByUserAndAccount.get(userId, accountId)) {
                        const kek = vault.getSessionKek(sessionId);
                        if (kek) {
                            const wrapped = wrapDataKey(existingDek, kek, keyringAad({ accountId, userId }));
                            authDb.userKeyrings.upsert.run(userId, accountId, wrapped);
                        }
                    }
                } catch (e) {}
                return { ok: true };
            }

            const kek = vault.getSessionKek(sessionId);
            if (!kek) {
                throw new CryptoLockedError();
            }

            const authDb = this.getAccountContext(this.getDefaultAccountId()).db;
            const keyringCount = authDb.userKeyrings?.countByAccount?.get(accountId)?.count || 0;

            let dek;
            if (keyringCount > 0) {
                const keyring = authDb.userKeyrings?.getByUserAndAccount?.get(userId, accountId);
                if (!keyring?.wrapped_dek) {
                    // Cannot unwrap without a stored wrapped key.
                    return { ok: false, status: 423, error: 'Vault locked' };
                }
                dek = unwrapDataKey(keyring.wrapped_dek, kek, keyringAad({ accountId, userId }));
            } else {
                // Legacy mode: KEK is also used as the data key.
                dek = kek;
            }

            vault.setAccountKeyForSession(accountId, dek, sessionId);
            return { ok: true };
        } catch (error) {
            if (error instanceof CryptoLockedError) {
                return { ok: false, status: 423, error: 'Vault locked' };
            }
            return { ok: false, status: 403, error: 'Account locked' };
        }
    }

    async shutdown() {
        for (const context of this.contexts.values()) {
            try {
                context.cleanup.stop();
            } catch (e) {}

            try {
                context.scheduler.stop();
            } catch (e) {}

            try {
                await context.whatsapp.destroy();
            } catch (e) {}

            try {
                await context.webhook?.shutdown?.({ timeoutMs: 5000 });
            } catch (e) {
                logger.warn('Webhook shutdown timed out', {
                    category: 'lifecycle',
                    accountId: context.account?.id,
                    error: e?.message || String(e)
                });
            }

            try {
                context.db?.close?.();
            } catch (e) {}
        }

        this.contexts.clear();
    }
}

module.exports = new AccountManager();

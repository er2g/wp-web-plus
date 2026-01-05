#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Zero-Knowledge keyring migration: introduce an account DEK (data key) wrapped per user.
 *
 * What it does:
 * - Prompts for user's password to derive their KEK (from users.encryption_salt).
 * - Generates a random account DEK (32 bytes).
 * - Re-encrypts all sensitive fields in the target account DB from legacy KEK -> new DEK.
 * - Stores the wrapped DEK in auth DB (default account DB) under user_keyrings.
 *
 * Usage:
 *   node scripts/zk-keyring-init.js --account default --username admin
 *   node scripts/zk-keyring-init.js --account foo --username admin --auth-account default
 *   node scripts/zk-keyring-init.js --account default --username admin --dry-run true
 *
 * Notes:
 * - This is a one-time operation per account.
 * - Other users will need to login while an unlocked session exists to be provisioned.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const Database = require('better-sqlite3');

const config = require('../config');
const { verifyPassword } = require('../services/passwords');
const {
    deriveMasterKey,
    encryptString,
    decryptString,
    isEncryptedValue,
    aadForField,
    wrapDataKey,
    keyringAad
} = require('../services/encryption');

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i += 1) {
        const key = argv[i];
        if (!key.startsWith('--')) continue;
        const name = key.slice(2);
        const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
        out[name] = value;
        if (value !== true) i += 1;
    }
    return out;
}

function resolveAccountDbPath(accountId) {
    return path.join(config.DATA_DIR, 'accounts', String(accountId || 'default'), 'whatsapp.db');
}

function resolveDefaultAuthAccountId() {
    try {
        const raw = fs.readFileSync(path.join(config.DATA_DIR, 'accounts.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const id = parsed?.accounts?.[0]?.id;
        return id || 'default';
    } catch (e) {
        return 'default';
    }
}

function promptHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const onData = (char) => {
            const code = char + '';
            switch (code) {
                case '\n':
                case '\r':
                case '\u0004':
                    process.stdin.off('data', onData);
                    break;
                default:
                    process.stdout.clearLine(0);
                    process.stdout.cursorTo(0);
                    process.stdout.write(question + '*'.repeat(rl.line.length));
                    break;
            }
        };
        process.stdin.on('data', onData);
        rl.question(question, (value) => {
            rl.history = rl.history.slice(1);
            rl.close();
            process.stdout.write('\n');
            resolve(value);
        });
    });
}

function ensureUserKeyringsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_keyrings (
            user_id INTEGER NOT NULL,
            account_id TEXT NOT NULL,
            wrapped_dek TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, account_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_keyrings_account_id ON user_keyrings(account_id);
    `);
}

function allowEmptyPassthrough(table, column) {
    return (
        (table === 'messages' && (column === 'body' || column === 'quoted_body'))
        || (table === 'chats' && column === 'last_message')
    );
}

function migrateValue(value, oldKey, newKey, { accountId, table, column } = {}) {
    if (value === null || value === undefined) return value;
    if (allowEmptyPassthrough(table, column) && value === '') return value;
    if (typeof value !== 'string') return value;
    if (allowEmptyPassthrough(table, column) && value === '') return value;
    if (value === '') return value;

    const aad = aadForField({ accountId, table, column });
    if (isEncryptedValue(value)) {
        const plaintext = decryptString(value, oldKey, aad);
        return encryptString(plaintext, newKey, aad);
    }
    return encryptString(value, newKey, aad);
}

function main() {
    const args = parseArgs(process.argv);
    const accountId = String(args.account || args['account-id'] || 'default');
    const authAccountId = String(args['auth-account'] || resolveDefaultAuthAccountId());
    const username = String(args.username || 'admin').trim().toLowerCase();
    const dryRun = args['dry-run'] === true || String(args['dry-run'] || '').toLowerCase() === 'true';

    const accountDbPath = path.resolve(resolveAccountDbPath(accountId));
    const authDbPath = path.resolve(resolveAccountDbPath(authAccountId));

    console.log('Zero-Knowledge keyring migration (DEK/KEK)');
    console.log('- accountId:', accountId);
    console.log('- account db:', accountDbPath);
    console.log('- auth accountId:', authAccountId);
    console.log('- auth db:', authDbPath);
    console.log('- username:', username);
    console.log('- mode:', dryRun ? 'DRY RUN (no writes)' : 'WRITE');

    if (!fs.existsSync(accountDbPath)) {
        console.error('Account DB not found:', accountDbPath);
        process.exit(2);
    }
    if (!fs.existsSync(authDbPath)) {
        console.error('Auth DB not found:', authDbPath);
        process.exit(2);
    }

    const authDb = new Database(authDbPath);
    authDb.pragma('journal_mode = WAL');
    authDb.pragma('foreign_keys = ON');
    ensureUserKeyringsTable(authDb);

    const user = authDb.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        console.error('User not found in auth DB:', username);
        process.exit(2);
    }

    const keyringCount = authDb.prepare('SELECT COUNT(*) as count FROM user_keyrings WHERE account_id = ?').get(accountId).count;
    if (keyringCount > 0) {
        console.error('Keyring already initialized for account:', accountId);
        process.exit(4);
    }

    const run = async () => {
        const password = await promptHidden('Enter password for ' + username + ': ');
        if (!password) {
            console.error('Password required');
            process.exit(2);
        }
        if (!verifyPassword(password, user.password_salt, user.password_hash)) {
            console.error('Invalid password');
            process.exit(3);
        }

        let encryptionSalt = user.encryption_salt;
        if (!encryptionSalt) {
            encryptionSalt = crypto.randomBytes(16).toString('hex');
            if (dryRun) {
                console.log('Would set users.encryption_salt for user id', user.id);
            } else {
                authDb.prepare('UPDATE users SET encryption_salt = ? WHERE id = ?').run(encryptionSalt, user.id);
            }
        }

        const kek = deriveMasterKey(password, encryptionSalt);
        const dek = crypto.randomBytes(32);
        const wrappedDek = wrapDataKey(dek, kek, keyringAad({ accountId, userId: user.id }));

        const accountDb = new Database(accountDbPath);
        accountDb.pragma('journal_mode = WAL');
        accountDb.pragma('foreign_keys = ON');

        const counters = {
            messages: 0,
            chats: 0,
            notes: 0,
            contacts: 0,
            auto_replies: 0,
            message_templates: 0,
            scheduled_messages: 0,
            users: 0
        };

        const txn = accountDb.transaction(() => {
            // messages
            {
                const select = accountDb.prepare('SELECT id, from_number, to_number, from_name, body, quoted_body, quoted_from_name FROM messages');
                const update = accountDb.prepare('UPDATE messages SET from_number = ?, to_number = ?, from_name = ?, body = ?, quoted_body = ?, quoted_from_name = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const next = {
                        from_number: migrateValue(row.from_number, kek, dek, { accountId, table: 'messages', column: 'from_number' }),
                        to_number: migrateValue(row.to_number, kek, dek, { accountId, table: 'messages', column: 'to_number' }),
                        from_name: migrateValue(row.from_name, kek, dek, { accountId, table: 'messages', column: 'from_name' }),
                        body: migrateValue(row.body, kek, dek, { accountId, table: 'messages', column: 'body' }),
                        quoted_body: migrateValue(row.quoted_body, kek, dek, { accountId, table: 'messages', column: 'quoted_body' }),
                        quoted_from_name: migrateValue(row.quoted_from_name, kek, dek, { accountId, table: 'messages', column: 'quoted_from_name' })
                    };
                    const changed = next.from_number !== row.from_number
                        || next.to_number !== row.to_number
                        || next.from_name !== row.from_name
                        || next.body !== row.body
                        || next.quoted_body !== row.quoted_body
                        || next.quoted_from_name !== row.quoted_from_name;
                    if (changed) {
                        counters.messages += 1;
                        if (!dryRun) {
                            update.run(next.from_number, next.to_number, next.from_name, next.body, next.quoted_body, next.quoted_from_name, row.id);
                        }
                    }
                }
            }

            // chats
            {
                const select = accountDb.prepare('SELECT chat_id, name, last_message FROM chats');
                const update = accountDb.prepare('UPDATE chats SET name = ?, last_message = ? WHERE chat_id = ?');
                for (const row of select.iterate()) {
                    const nextName = migrateValue(row.name, kek, dek, { accountId, table: 'chats', column: 'name' });
                    const nextLast = migrateValue(row.last_message, kek, dek, { accountId, table: 'chats', column: 'last_message' });
                    if (nextName !== row.name || nextLast !== row.last_message) {
                        counters.chats += 1;
                        if (!dryRun) update.run(nextName, nextLast, row.chat_id);
                    }
                }
            }

            // notes
            {
                const select = accountDb.prepare('SELECT id, content FROM notes');
                const update = accountDb.prepare('UPDATE notes SET content = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const next = migrateValue(row.content, kek, dek, { accountId, table: 'notes', column: 'content' });
                    if (next !== row.content) {
                        counters.notes += 1;
                        if (!dryRun) update.run(next, row.id);
                    }
                }
            }

            // contacts
            {
                const select = accountDb.prepare('SELECT id, name, phone FROM contacts');
                const update = accountDb.prepare('UPDATE contacts SET name = ?, phone = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextName = migrateValue(row.name, kek, dek, { accountId, table: 'contacts', column: 'name' });
                    const nextPhone = migrateValue(row.phone, kek, dek, { accountId, table: 'contacts', column: 'phone' });
                    if (nextName !== row.name || nextPhone !== row.phone) {
                        counters.contacts += 1;
                        if (!dryRun) update.run(nextName, nextPhone, row.id);
                    }
                }
            }

            // auto_replies
            {
                const select = accountDb.prepare('SELECT id, trigger_word, response FROM auto_replies');
                const update = accountDb.prepare('UPDATE auto_replies SET trigger_word = ?, response = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextTrigger = migrateValue(row.trigger_word, kek, dek, { accountId, table: 'auto_replies', column: 'trigger_word' });
                    const nextResp = migrateValue(row.response, kek, dek, { accountId, table: 'auto_replies', column: 'response' });
                    if (nextTrigger !== row.trigger_word || nextResp !== row.response) {
                        counters.auto_replies += 1;
                        if (!dryRun) update.run(nextTrigger, nextResp, row.id);
                    }
                }
            }

            // message_templates
            {
                const select = accountDb.prepare('SELECT id, content, variables FROM message_templates');
                const update = accountDb.prepare('UPDATE message_templates SET content = ?, variables = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextContent = migrateValue(row.content, kek, dek, { accountId, table: 'message_templates', column: 'content' });
                    const nextVars = migrateValue(row.variables, kek, dek, { accountId, table: 'message_templates', column: 'variables' });
                    if (nextContent !== row.content || nextVars !== row.variables) {
                        counters.message_templates += 1;
                        if (!dryRun) update.run(nextContent, nextVars, row.id);
                    }
                }
            }

            // scheduled_messages
            {
                const select = accountDb.prepare('SELECT id, chat_name, message FROM scheduled_messages');
                const update = accountDb.prepare('UPDATE scheduled_messages SET chat_name = ?, message = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextName = migrateValue(row.chat_name, kek, dek, { accountId, table: 'scheduled_messages', column: 'chat_name' });
                    const nextMsg = migrateValue(row.message, kek, dek, { accountId, table: 'scheduled_messages', column: 'message' });
                    if (nextName !== row.chat_name || nextMsg !== row.message) {
                        counters.scheduled_messages += 1;
                        if (!dryRun) update.run(nextName, nextMsg, row.id);
                    }
                }
            }

            // users (preferences, ai_api_key)
            {
                const select = accountDb.prepare('SELECT id, preferences, ai_api_key FROM users');
                const update = accountDb.prepare('UPDATE users SET preferences = ?, ai_api_key = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextPrefs = migrateValue(row.preferences, kek, dek, { accountId, table: 'users', column: 'preferences' });
                    const nextAi = migrateValue(row.ai_api_key, kek, dek, { accountId, table: 'users', column: 'ai_api_key' });
                    if (nextPrefs !== row.preferences || nextAi !== row.ai_api_key) {
                        counters.users += 1;
                        if (!dryRun) update.run(nextPrefs, nextAi, row.id);
                    }
                }
            }
        });

        if (!dryRun) {
            console.log('Re-encrypting account data...');
        }
        txn();

        if (dryRun) {
            console.log('Would upsert user_keyrings for user id', user.id, 'account', accountId);
        } else {
            authDb.prepare(`
                INSERT INTO user_keyrings (user_id, account_id, wrapped_dek, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(user_id, account_id) DO UPDATE SET
                    wrapped_dek = excluded.wrapped_dek,
                    updated_at = datetime('now')
            `).run(user.id, accountId, wrappedDek);
        }

        console.log('Done. Changed rows:', counters);
    };

    run().catch((err) => {
        console.error('Migration failed:', err?.message || String(err));
        process.exit(1);
    });
}

main();


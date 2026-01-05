#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Zero-Knowledge migration: encrypt existing plaintext rows in SQLite.
 *
 * Usage:
 *   node scripts/zk-migrate.js --account default --username admin
 *   node scripts/zk-migrate.js --db /path/to/whatsapp.db --account-id default --username admin
 *
 * Notes:
 * - Prompts for the user's password to derive the in-memory master key.
 * - Does NOT print or store the password.
 */
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const Database = require('better-sqlite3');

const config = require('../config');
const { verifyPassword } = require('../services/passwords');
const { deriveMasterKey, encryptString, isEncryptedValue, aadForField } = require('../services/encryption');

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

function resolveDbPath({ db, account } = {}) {
    if (db) return path.resolve(String(db));
    const accountId = String(account || 'default');
    return path.join(config.DATA_DIR, 'accounts', accountId, 'whatsapp.db');
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

function columnExists(db, table, column) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
}

function encryptIfNeeded(value, key, { accountId, table, column, allowEmptyPassthrough = false } = {}) {
    if (value === null || value === undefined) return value;
    if (allowEmptyPassthrough && value === '') return value;
    if (typeof value !== 'string') return value;
    if (value === '' && allowEmptyPassthrough) return value;
    if (value === '') return value;
    if (isEncryptedValue(value)) return value;
    return encryptString(value, key, aadForField({ accountId, table, column }));
}

function main() {
    const args = parseArgs(process.argv);
    const accountId = String(args['account-id'] || args.account || 'default');
    const dbPath = resolveDbPath({ db: args.db, account: args.account });
    const username = String(args.username || 'admin').trim().toLowerCase();
    const dryRun = args['dry-run'] === true || String(args['dry-run'] || '').toLowerCase() === 'true';

    console.log('Zero-Knowledge migration (encrypt at rest)');
    console.log('- db:', dbPath);
    console.log('- accountId:', accountId);
    console.log('- username:', username);
    console.log('- mode:', dryRun ? 'DRY RUN (no writes)' : 'WRITE');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    if (!columnExists(db, 'users', 'encryption_salt')) {
        if (dryRun) {
            console.log('Would add users.encryption_salt column');
        } else {
            db.exec('ALTER TABLE users ADD COLUMN encryption_salt TEXT');
        }
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        console.error('User not found:', username);
        process.exit(2);
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
                db.prepare('UPDATE users SET encryption_salt = ? WHERE id = ?').run(encryptionSalt, user.id);
            }
        }

        const masterKey = deriveMasterKey(password, encryptionSalt);

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

        const txn = db.transaction(() => {
            // messages
            {
                const select = db.prepare('SELECT id, from_number, to_number, from_name, body, quoted_body, quoted_from_name FROM messages');
                const update = db.prepare('UPDATE messages SET from_number = ?, to_number = ?, from_name = ?, body = ?, quoted_body = ?, quoted_from_name = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const next = {
                        from_number: encryptIfNeeded(row.from_number, masterKey, { accountId, table: 'messages', column: 'from_number' }),
                        to_number: encryptIfNeeded(row.to_number, masterKey, { accountId, table: 'messages', column: 'to_number' }),
                        from_name: encryptIfNeeded(row.from_name, masterKey, { accountId, table: 'messages', column: 'from_name' }),
                        body: encryptIfNeeded(row.body, masterKey, { accountId, table: 'messages', column: 'body', allowEmptyPassthrough: true }),
                        quoted_body: encryptIfNeeded(row.quoted_body, masterKey, { accountId, table: 'messages', column: 'quoted_body', allowEmptyPassthrough: true }),
                        quoted_from_name: encryptIfNeeded(row.quoted_from_name, masterKey, { accountId, table: 'messages', column: 'quoted_from_name' })
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
                const select = db.prepare('SELECT chat_id, name, last_message FROM chats');
                const update = db.prepare('UPDATE chats SET name = ?, last_message = ? WHERE chat_id = ?');
                for (const row of select.iterate()) {
                    const nextName = encryptIfNeeded(row.name, masterKey, { accountId, table: 'chats', column: 'name' });
                    const nextLast = encryptIfNeeded(row.last_message, masterKey, { accountId, table: 'chats', column: 'last_message', allowEmptyPassthrough: true });
                    if (nextName !== row.name || nextLast !== row.last_message) {
                        counters.chats += 1;
                        if (!dryRun) {
                            update.run(nextName, nextLast, row.chat_id);
                        }
                    }
                }
            }

            // notes
            {
                const select = db.prepare('SELECT id, content FROM notes');
                const update = db.prepare('UPDATE notes SET content = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const next = encryptIfNeeded(row.content, masterKey, { accountId, table: 'notes', column: 'content' });
                    if (next !== row.content) {
                        counters.notes += 1;
                        if (!dryRun) update.run(next, row.id);
                    }
                }
            }

            // contacts
            {
                const select = db.prepare('SELECT id, name, phone FROM contacts');
                const update = db.prepare('UPDATE contacts SET name = ?, phone = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextName = encryptIfNeeded(row.name, masterKey, { accountId, table: 'contacts', column: 'name' });
                    const nextPhone = encryptIfNeeded(row.phone, masterKey, { accountId, table: 'contacts', column: 'phone' });
                    if (nextName !== row.name || nextPhone !== row.phone) {
                        counters.contacts += 1;
                        if (!dryRun) update.run(nextName, nextPhone, row.id);
                    }
                }
            }

            // auto_replies
            {
                const select = db.prepare('SELECT id, trigger_word, response FROM auto_replies');
                const update = db.prepare('UPDATE auto_replies SET trigger_word = ?, response = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextTrigger = encryptIfNeeded(row.trigger_word, masterKey, { accountId, table: 'auto_replies', column: 'trigger_word' });
                    const nextResponse = encryptIfNeeded(row.response, masterKey, { accountId, table: 'auto_replies', column: 'response' });
                    if (nextTrigger !== row.trigger_word || nextResponse !== row.response) {
                        counters.auto_replies += 1;
                        if (!dryRun) update.run(nextTrigger, nextResponse, row.id);
                    }
                }
            }

            // message_templates
            {
                const select = db.prepare('SELECT id, content, variables FROM message_templates');
                const update = db.prepare('UPDATE message_templates SET content = ?, variables = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextContent = encryptIfNeeded(row.content, masterKey, { accountId, table: 'message_templates', column: 'content' });
                    const nextVars = encryptIfNeeded(row.variables, masterKey, { accountId, table: 'message_templates', column: 'variables' });
                    if (nextContent !== row.content || nextVars !== row.variables) {
                        counters.message_templates += 1;
                        if (!dryRun) update.run(nextContent, nextVars, row.id);
                    }
                }
            }

            // scheduled_messages
            {
                const select = db.prepare('SELECT id, chat_name, message FROM scheduled_messages');
                const update = db.prepare('UPDATE scheduled_messages SET chat_name = ?, message = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextChatName = encryptIfNeeded(row.chat_name, masterKey, { accountId, table: 'scheduled_messages', column: 'chat_name' });
                    const nextMsg = encryptIfNeeded(row.message, masterKey, { accountId, table: 'scheduled_messages', column: 'message' });
                    if (nextChatName !== row.chat_name || nextMsg !== row.message) {
                        counters.scheduled_messages += 1;
                        if (!dryRun) update.run(nextChatName, nextMsg, row.id);
                    }
                }
            }

            // users sensitive fields (preferences + ai_api_key)
            {
                const select = db.prepare('SELECT id, preferences, ai_api_key FROM users');
                const update = db.prepare('UPDATE users SET preferences = ?, ai_api_key = ? WHERE id = ?');
                for (const row of select.iterate()) {
                    const nextPrefs = encryptIfNeeded(row.preferences, masterKey, { accountId, table: 'users', column: 'preferences' });
                    const nextAiKey = encryptIfNeeded(row.ai_api_key, masterKey, { accountId, table: 'users', column: 'ai_api_key' });
                    if (nextPrefs !== row.preferences || nextAiKey !== row.ai_api_key) {
                        counters.users += 1;
                        if (!dryRun) update.run(nextPrefs, nextAiKey, row.id);
                    }
                }
            }
        });

        txn();

        console.log('Done.');
        for (const [k, v] of Object.entries(counters)) {
            console.log(`- ${k}: ${v} row(s) updated`);
        }

        if (!dryRun) {
            try {
                db.pragma('wal_checkpoint(TRUNCATE)');
                db.exec('VACUUM');
                console.log('VACUUM completed');
            } catch (e) {
                console.warn('VACUUM failed:', e.message);
            }
        }
    };

    run()
        .then(() => {
            db.close();
            process.exit(0);
        })
        .catch((err) => {
            console.error(err?.message || String(err));
            try { db.close(); } catch (e) {}
            process.exit(1);
        });
}

main();


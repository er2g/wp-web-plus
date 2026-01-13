#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (!next || next.startsWith('--')) {
                out[key] = true;
            } else {
                out[key] = next;
                i += 1;
            }
        } else {
            out._.push(token);
        }
    }
    return out;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveAccountId(accounts, raw) {
    const value = raw ? String(raw).trim() : '';
    if (!value || value.toLowerCase() === 'default') return accounts[0]?.id || 'default';
    const byId = accounts.find(a => a.id === value);
    if (byId) return byId.id;
    const byName = accounts.find(a => String(a.name || '').toLowerCase() === value.toLowerCase());
    if (byName) return byName.id;
    throw new Error(`Unknown account: ${value}`);
}

function openDb(dbPath) {
    // better-sqlite3 is already a dependency of the app
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3');
    return new Database(dbPath);
}

function pickUserId(settingsDb, userArg) {
    if (userArg) {
        const id = Number(userArg);
        if (Number.isFinite(id) && id > 0) return id;
        throw new Error(`Invalid --user: ${userArg}`);
    }
    const row = settingsDb.prepare(`SELECT id FROM users WHERE is_active = 1 ORDER BY id ASC LIMIT 1`).get();
    if (!row?.id) throw new Error('No active users found');
    return row.id;
}

function normalizeChannel(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (raw === 'strong' || raw === 'messages_strong') return 'messages_strong';
    if (raw === 'weak' || raw === 'messages') return 'messages';
    if (raw === 'inherit' || raw === 'default' || raw === 'null' || raw === 'none') return null;
    throw new Error(`Invalid --channel: ${input} (use strong|weak|inherit)`);
}

function findChatIdByMatch(accountDb, match) {
    const q = String(match || '').trim();
    if (!q) throw new Error('Missing --match');
    const rows = accountDb
        .prepare(`SELECT id, name FROM chats WHERE name LIKE ? ORDER BY last_message_at DESC LIMIT 25`)
        .all(`%${q}%`);
    if (rows.length === 0) throw new Error(`No chats matched: ${q}`);
    if (rows.length > 1) {
        console.error('Multiple chats matched. Use --chat with exact id:');
        for (const r of rows) console.error(`- ${r.id} · ${r.name}`);
        process.exit(2);
    }
    return rows[0].id;
}

function usage() {
    console.log(`Usage:
  node scripts/mobile-notifications.js list --account <id|name|default> [--user <id>] [--q <substring>] [--limit 50]
  node scripts/mobile-notifications.js set  --account <id|name|default> [--user <id>] (--chat <chatId> | --match <name>) --channel strong|weak|inherit

Notes:
  - "strong" maps to Android channel: messages_strong
  - "weak" maps to Android channel: messages
  - "inherit" clears per-chat override (uses global setting)
`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
        usage();
        return;
    }

    const repoRoot = path.join(__dirname, '..');
    const accountsPath = path.join(repoRoot, 'data', 'accounts.json');
    if (!fs.existsSync(accountsPath)) throw new Error(`Missing ${accountsPath}`);
    const accounts = readJson(accountsPath).accounts || [];
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('No accounts found in data/accounts.json');

    const targetAccountId = resolveAccountId(accounts, args.account || args.accountId);
    const defaultAccountId = accounts[0].id;

    const settingsDbPath = path.join(repoRoot, 'data', 'accounts', defaultAccountId, 'whatsapp.db');
    const accountDbPath = path.join(repoRoot, 'data', 'accounts', targetAccountId, 'whatsapp.db');
    if (!fs.existsSync(settingsDbPath)) throw new Error(`Missing settings DB: ${settingsDbPath}`);
    if (!fs.existsSync(accountDbPath)) throw new Error(`Missing account DB: ${accountDbPath}`);

    const settingsDb = openDb(settingsDbPath);
    const accountDb = targetAccountId === defaultAccountId ? settingsDb : openDb(accountDbPath);

    try {
        const userId = pickUserId(settingsDb, args.user || args.userId);

        if (cmd === 'list') {
            const limit = Math.max(1, Math.min(500, Number(args.limit || 50) || 50));
            const q = args.q ? String(args.q).trim() : '';
            const chats = accountDb
                .prepare(
                    `
                    SELECT id, name, is_group, last_message_at, unread_count
                    FROM chats
                    ${q ? 'WHERE name LIKE ?' : ''}
                    ORDER BY last_message_at DESC
                    LIMIT ?
                    `
                )
                .all(...(q ? [`%${q}%`, limit] : [limit]));

            const overrides = settingsDb
                .prepare(
                    `
                    SELECT chat_id, muted_until, android_channel
                    FROM mobile_chat_notification_settings
                    WHERE user_id = ? AND account_id = ?
                    `
                )
                .all(userId, targetAccountId);

            const byChatId = new Map(overrides.map(o => [o.chat_id, o]));
            for (const c of chats) {
                const o = byChatId.get(c.id);
                const channel = o?.android_channel ? String(o.android_channel) : 'inherit';
                const mutedUntil = o?.muted_until ? Number(o.muted_until) : 0;
                const muted = mutedUntil && mutedUntil > Date.now() ? `muted_until=${new Date(mutedUntil).toISOString()}` : '';
                console.log(`${c.id} · ${c.name} · ${channel}${muted ? ` · ${muted}` : ''}`);
            }
            return;
        }

        if (cmd === 'set') {
            const channel = normalizeChannel(args.channel);
            const chatId = args.chat ? String(args.chat).trim() : findChatIdByMatch(accountDb, args.match);
            if (!chatId) throw new Error('Missing --chat or --match');

            settingsDb
                .prepare(
                    `
                    INSERT INTO mobile_chat_notification_settings (user_id, account_id, chat_id, android_channel, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(user_id, account_id, chat_id) DO UPDATE SET
                        android_channel = excluded.android_channel,
                        updated_at = datetime('now')
                    `
                )
                .run(userId, targetAccountId, chatId, channel);

            console.log(`OK: user=${userId} account=${targetAccountId} chat=${chatId} channel=${channel || 'inherit'}`);
            return;
        }

        throw new Error(`Unknown command: ${cmd}`);
    } finally {
        try {
            if (accountDb !== settingsDb) accountDb.close();
        } catch (e) {}
        try {
            settingsDb.close();
        } catch (e) {}
    }
}

main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
});


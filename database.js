/**
 * WhatsApp Web Panel - Database Module v2
 */
const Database = require('better-sqlite3');
const config = require('./config');
const fs = require('fs');

// Ensure data directory exists
if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        chat_id TEXT,
        from_number TEXT,
        to_number TEXT,
        from_name TEXT,
        body TEXT,
        type TEXT DEFAULT 'chat',
        media_path TEXT,
        media_url TEXT,
        media_mimetype TEXT,
        is_group INTEGER DEFAULT 0,
        is_from_me INTEGER DEFAULT 0,
        timestamp INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        profile_pic TEXT,
        last_message TEXT,
        last_message_at INTEGER,
        unread_count INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_word TEXT NOT NULL,
        response TEXT NOT NULL,
        match_type TEXT DEFAULT 'contains',
        is_active INTEGER DEFAULT 1,
        reply_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        message TEXT NOT NULL,
        scheduled_at DATETIME NOT NULL,
        is_sent INTEGER DEFAULT 0,
        sent_at DATETIME,
        is_recurring INTEGER DEFAULT 0,
        cron_expression TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT NOT NULL,
        events TEXT DEFAULT 'message',
        is_active INTEGER DEFAULT 1,
        last_triggered_at DATETIME,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        code TEXT NOT NULL,
        trigger_type TEXT DEFAULT 'message',
        trigger_filter TEXT,
        is_active INTEGER DEFAULT 1,
        run_count INTEGER DEFAULT 0,
        last_run_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS script_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        script_id INTEGER,
        level TEXT DEFAULT 'info',
        message TEXT,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT DEFAULT 'info',
        category TEXT,
        message TEXT,
        data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_scripts_active ON scripts(is_active);
    CREATE INDEX IF NOT EXISTS idx_script_logs_script ON script_logs(script_id);
`);
// Add media_url column if not exists (for existing databases)try { db.exec("ALTER TABLE messages ADD COLUMN media_url TEXT"); } catch(e) {}
console.log('Database initialized');

// Prepared statements
const messages = {
    save: db.prepare(`
        INSERT OR REPLACE INTO messages
        (message_id, chat_id, from_number, to_number, from_name, body, type, media_path, media_url, media_mimetype, is_group, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getByChatId: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`),
    getAll: db.prepare(`SELECT * FROM messages ORDER BY timestamp DESC LIMIT ? OFFSET ?`),
    search: db.prepare(`SELECT * FROM messages WHERE body LIKE ? ORDER BY timestamp DESC LIMIT 100`),
    getStats: db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received,
            SUM(CASE WHEN date(datetime(timestamp/1000, 'unixepoch')) = date('now') THEN 1 ELSE 0 END) as today
        FROM messages
    `)
};

const chats = {
    upsert: db.prepare(`
        INSERT INTO chats (chat_id, name, is_group, profile_pic, last_message, last_message_at, unread_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
            name = excluded.name, profile_pic = excluded.profile_pic,
            last_message = excluded.last_message, last_message_at = excluded.last_message_at,
            unread_count = excluded.unread_count, updated_at = datetime('now')
    `),
    getAll: db.prepare(`SELECT * FROM chats ORDER BY last_message_at DESC`),
    getById: db.prepare(`SELECT * FROM chats WHERE chat_id = ?`)
};

const autoReplies = {
    getAll: db.prepare('SELECT * FROM auto_replies ORDER BY created_at DESC'),
    getActive: db.prepare('SELECT * FROM auto_replies WHERE is_active = 1'),
    getById: db.prepare('SELECT * FROM auto_replies WHERE id = ?'),
    create: db.prepare(`INSERT INTO auto_replies (trigger_word, response, match_type, is_active) VALUES (?, ?, ?, ?)`),
    update: db.prepare(`UPDATE auto_replies SET trigger_word = ?, response = ?, match_type = ?, is_active = ? WHERE id = ?`),
    delete: db.prepare('DELETE FROM auto_replies WHERE id = ?'),
    incrementCount: db.prepare('UPDATE auto_replies SET reply_count = reply_count + 1 WHERE id = ?'),
    toggle: db.prepare('UPDATE auto_replies SET is_active = ? WHERE id = ?')
};

const scheduled = {
    getAll: db.prepare('SELECT * FROM scheduled_messages ORDER BY scheduled_at ASC'),
    getPending: db.prepare(`SELECT * FROM scheduled_messages WHERE is_sent = 0 AND datetime(scheduled_at) <= datetime('now')`),
    getById: db.prepare('SELECT * FROM scheduled_messages WHERE id = ?'),
    create: db.prepare(`INSERT INTO scheduled_messages (chat_id, chat_name, message, scheduled_at, is_recurring, cron_expression) VALUES (?, ?, ?, ?, ?, ?)`),
    markSent: db.prepare(`UPDATE scheduled_messages SET is_sent = 1, sent_at = datetime('now') WHERE id = ?`),
    delete: db.prepare('DELETE FROM scheduled_messages WHERE id = ?')
};

const webhooks = {
    getAll: db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC'),
    getActive: db.prepare('SELECT * FROM webhooks WHERE is_active = 1'),
    getById: db.prepare('SELECT * FROM webhooks WHERE id = ?'),
    create: db.prepare(`INSERT INTO webhooks (name, url, events, is_active) VALUES (?, ?, ?, ?)`),
    update: db.prepare(`UPDATE webhooks SET name = ?, url = ?, events = ?, is_active = ? WHERE id = ?`),
    delete: db.prepare('DELETE FROM webhooks WHERE id = ?'),
    recordSuccess: db.prepare(`UPDATE webhooks SET success_count = success_count + 1, last_triggered_at = datetime('now') WHERE id = ?`),
    recordFail: db.prepare(`UPDATE webhooks SET fail_count = fail_count + 1, last_triggered_at = datetime('now') WHERE id = ?`)
};

const scripts = {
    getAll: db.prepare('SELECT * FROM scripts ORDER BY created_at DESC'),
    getActive: db.prepare('SELECT * FROM scripts WHERE is_active = 1'),
    getById: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    getByTrigger: db.prepare('SELECT * FROM scripts WHERE is_active = 1 AND trigger_type = ?'),
    create: db.prepare(`INSERT INTO scripts (name, description, code, trigger_type, trigger_filter, is_active) VALUES (?, ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE scripts SET name = ?, description = ?, code = ?, trigger_type = ?, trigger_filter = ?, is_active = ?, updated_at = datetime('now') WHERE id = ?`),
    delete: db.prepare('DELETE FROM scripts WHERE id = ?'),
    toggle: db.prepare('UPDATE scripts SET is_active = ? WHERE id = ?'),
    recordRun: db.prepare(`UPDATE scripts SET run_count = run_count + 1, last_run_at = datetime('now'), last_error = NULL WHERE id = ?`),
    recordError: db.prepare(`UPDATE scripts SET last_error = ?, last_run_at = datetime('now') WHERE id = ?`)
};

const scriptLogs = {
    add: db.prepare(`INSERT INTO script_logs (script_id, level, message, data) VALUES (?, ?, ?, ?)`),
    getByScript: db.prepare(`SELECT * FROM script_logs WHERE script_id = ? ORDER BY created_at DESC LIMIT ?`),
    cleanup: db.prepare(`DELETE FROM script_logs WHERE created_at < datetime('now', '-3 days')`)
};

const logs = {
    add: db.prepare(`INSERT INTO logs (level, category, message, data) VALUES (?, ?, ?, ?)`),
    getRecent: db.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT ?`),
    getByCategory: db.prepare(`SELECT * FROM logs WHERE category = ? ORDER BY created_at DESC LIMIT ?`),
    cleanup: db.prepare(`DELETE FROM logs WHERE created_at < datetime('now', '-7 days')`)
};

module.exports = { db, messages, chats, autoReplies, scheduled, webhooks, scripts, scriptLogs, logs };

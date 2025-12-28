/**
 * WhatsApp Web Panel - Database Module v2
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const { logger } = require('./services/logger');

function createDatabase(config) {
    // Ensure data directory exists
    if (!fs.existsSync(config.DATA_DIR)) {
        fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }

    const db = new Database(config.DB_PATH);
    db.pragma('journal_mode = WAL');

    // Schema migrations tracking
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

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
        retry_count INTEGER DEFAULT 0,
        next_attempt_at DATETIME,
        last_error TEXT,
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
        last_error TEXT,
        last_status INTEGER,
        last_duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        status INTEGER,
        duration INTEGER,
        attempts INTEGER DEFAULT 1,
        error TEXT,
        payload TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_scripts_active ON scripts(is_active);
    CREATE INDEX IF NOT EXISTS idx_script_logs_script ON script_logs(script_id);
    CREATE INDEX IF NOT EXISTS idx_script_logs_created ON script_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
`);

    const columnExists = (tableName, columnName) => {
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        return columns.some(column => column.name === columnName);
    };

    const migrations = [
        {
            version: 1,
            name: 'add_media_url_to_messages',
            apply: () => {
                if (!columnExists('messages', 'media_url')) {
                    db.exec('ALTER TABLE messages ADD COLUMN media_url TEXT');
                }
            }
        },
        {
            version: 2,
            name: 'add_message_indexes',
            apply: () => {
                db.exec(`
                    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp);
                    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
                `);
            }
        },
        {
            version: 3,
            name: 'add_script_logs_created_index',
            apply: () => {
                db.exec('CREATE INDEX IF NOT EXISTS idx_script_logs_created ON script_logs(created_at)');
            }
        }
    ];

    const appliedMigrations = new Set(
        db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version)
    );

    const insertMigration = db.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, datetime(\'now\'))'
    );

    migrations.forEach(migration => {
        if (appliedMigrations.has(migration.version)) {
            return;
        }

        db.transaction(() => {
            migration.apply();
            insertMigration.run(migration.version);
            logger.info(`Database migration applied: ${migration.name}`, { category: 'database' });
        })();
    });

    try {
        db.exec("ALTER TABLE scheduled_messages ADD COLUMN retry_count INTEGER DEFAULT 0");
        logger.info('Database migration: Added retry_count column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    try {
        db.exec("ALTER TABLE scheduled_messages ADD COLUMN next_attempt_at DATETIME");
        logger.info('Database migration: Added next_attempt_at column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    try {
        db.exec("ALTER TABLE scheduled_messages ADD COLUMN last_error TEXT");
        logger.info('Database migration: Added last_error column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    try {
        db.exec("ALTER TABLE webhooks ADD COLUMN last_error TEXT");
        logger.info('Database migration: Added webhooks.last_error column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    try {
        db.exec("ALTER TABLE webhooks ADD COLUMN last_status INTEGER");
        logger.info('Database migration: Added webhooks.last_status column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    try {
        db.exec("ALTER TABLE webhooks ADD COLUMN last_duration_ms INTEGER");
        logger.info('Database migration: Added webhooks.last_duration_ms column', { category: 'database' });
    } catch (e) {
        // Column already exists
    }

    logger.info('Database initialized', { category: 'database', dbPath: config.DB_PATH });

    // Prepared statements
    const messages = {
        save: db.prepare(`
        INSERT OR REPLACE INTO messages
        (message_id, chat_id, from_number, to_number, from_name, body, type, media_path, media_url, media_mimetype, is_group, is_from_me, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
        getByChatId: db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`),
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
        getById: db.prepare(`SELECT * FROM chats WHERE chat_id = ?`),
        search: db.prepare(`SELECT * FROM chats WHERE name LIKE ? ORDER BY last_message_at DESC LIMIT ? OFFSET ?`)
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
        getPending: db.prepare(`
        SELECT * FROM scheduled_messages
        WHERE is_sent = 0
          AND datetime(scheduled_at) <= datetime('now')
          AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
          AND retry_count < ?
    `),
        getById: db.prepare('SELECT * FROM scheduled_messages WHERE id = ?'),
        create: db.prepare(`INSERT INTO scheduled_messages (chat_id, chat_name, message, scheduled_at, is_recurring, cron_expression) VALUES (?, ?, ?, ?, ?, ?)`),
        markSent: db.prepare(`
        UPDATE scheduled_messages
        SET is_sent = 1,
            sent_at = datetime('now'),
            retry_count = 0,
            next_attempt_at = NULL,
            last_error = NULL
        WHERE id = ?
    `),
        recordFailure: db.prepare(`
        UPDATE scheduled_messages
        SET retry_count = ?,
            next_attempt_at = ?,
            last_error = ?
        WHERE id = ?
    `),
        delete: db.prepare('DELETE FROM scheduled_messages WHERE id = ?')
    };

    const webhooks = {
        getAll: db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC'),
        getActive: db.prepare('SELECT * FROM webhooks WHERE is_active = 1'),
        getById: db.prepare('SELECT * FROM webhooks WHERE id = ?'),
        create: db.prepare(`INSERT INTO webhooks (name, url, events, is_active) VALUES (?, ?, ?, ?)`),
        update: db.prepare(`UPDATE webhooks SET name = ?, url = ?, events = ?, is_active = ? WHERE id = ?`),
        delete: db.prepare('DELETE FROM webhooks WHERE id = ?'),
        recordSuccess: db.prepare(`
        UPDATE webhooks
        SET success_count = success_count + 1,
            last_triggered_at = datetime('now'),
            last_error = NULL,
            last_status = ?,
            last_duration_ms = ?
        WHERE id = ?
    `),
        recordFail: db.prepare(`
        UPDATE webhooks
        SET fail_count = fail_count + 1,
            last_triggered_at = datetime('now'),
            last_error = ?,
            last_status = ?,
            last_duration_ms = ?
        WHERE id = ?
    `)
    };

    const webhookDeliveries = {
        create: db.prepare(`
        INSERT INTO webhook_deliveries
        (webhook_id, event, status, duration, attempts, error, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
        getByWebhookId: db.prepare(`
        SELECT * FROM webhook_deliveries
        WHERE webhook_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `),
        getById: db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?')
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
        cleanup: db.prepare(`DELETE FROM script_logs WHERE created_at < datetime('now', ?)`)
    };

    const logs = {
        add: db.prepare(`INSERT INTO logs (level, category, message, data) VALUES (?, ?, ?, ?)`),
        getRecent: db.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT ?`),
        getByCategory: db.prepare(`SELECT * FROM logs WHERE category = ? ORDER BY created_at DESC LIMIT ?`),
        cleanup: db.prepare(`DELETE FROM logs WHERE created_at < datetime('now', ?)`)
    };

    const maintenance = {
        cleanupMessages: db.prepare(`DELETE FROM messages WHERE timestamp < ?`)
    };

    const reports = {
        getOverview: db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received,
            COUNT(DISTINCT chat_id) as active_chats
        FROM messages
        WHERE timestamp BETWEEN ? AND ?
    `),
        getTopChats: db.prepare(`
        SELECT
            m.chat_id,
            COALESCE(c.name, m.chat_id) as name,
            COUNT(*) as message_count,
            SUM(CASE WHEN m.is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN m.is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM messages m
        LEFT JOIN chats c ON c.chat_id = m.chat_id
        WHERE m.timestamp BETWEEN ? AND ?
        GROUP BY m.chat_id
        ORDER BY message_count DESC
        LIMIT ?
    `),
        getDailyTrend: db.prepare(`
        SELECT
            date(datetime(timestamp/1000, 'unixepoch')) as bucket,
            COUNT(*) as total,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM messages
        WHERE timestamp BETWEEN ? AND ?
        GROUP BY bucket
        ORDER BY bucket ASC
    `),
        getWeeklyTrend: db.prepare(`
        SELECT
            strftime('%Y-%W', datetime(timestamp/1000, 'unixepoch')) as bucket,
            MIN(date(datetime(timestamp/1000, 'unixepoch'))) as week_start,
            COUNT(*) as total,
            SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as sent,
            SUM(CASE WHEN is_from_me = 0 THEN 1 ELSE 0 END) as received
        FROM messages
        WHERE timestamp BETWEEN ? AND ?
        GROUP BY bucket
        ORDER BY bucket ASC
    `),
        getResponseTimeSummary: db.prepare(`
        WITH user_messages AS (
            SELECT chat_id, timestamp
            FROM messages
            WHERE is_from_me = 0
              AND timestamp BETWEEN ? AND ?
        ),
        pairs AS (
            SELECT
                u.chat_id,
                u.timestamp as user_ts,
                (
                    SELECT MIN(r.timestamp)
                    FROM messages r
                    WHERE r.chat_id = u.chat_id
                      AND r.is_from_me = 1
                      AND r.timestamp > u.timestamp
                ) as response_ts
            FROM user_messages u
        ),
        response_times AS (
            SELECT chat_id, (response_ts - user_ts) as response_time_ms
            FROM pairs
            WHERE response_ts IS NOT NULL
        )
        SELECT
            COUNT(*) as responses,
            AVG(response_time_ms) as avg_ms,
            MIN(response_time_ms) as min_ms,
            MAX(response_time_ms) as max_ms
        FROM response_times
    `),
        getResponseTimeByChat: db.prepare(`
        WITH user_messages AS (
            SELECT chat_id, timestamp
            FROM messages
            WHERE is_from_me = 0
              AND timestamp BETWEEN ? AND ?
        ),
        pairs AS (
            SELECT
                u.chat_id,
                u.timestamp as user_ts,
                (
                    SELECT MIN(r.timestamp)
                    FROM messages r
                    WHERE r.chat_id = u.chat_id
                      AND r.is_from_me = 1
                      AND r.timestamp > u.timestamp
                ) as response_ts
            FROM user_messages u
        ),
        response_times AS (
            SELECT chat_id, (response_ts - user_ts) as response_time_ms
            FROM pairs
            WHERE response_ts IS NOT NULL
        )
        SELECT
            r.chat_id,
            COALESCE(c.name, r.chat_id) as name,
            COUNT(*) as responses,
            AVG(response_time_ms) as avg_ms
        FROM response_times r
        LEFT JOIN chats c ON c.chat_id = r.chat_id
        GROUP BY r.chat_id
        ORDER BY avg_ms ASC
        LIMIT ?
    `),
        getResponseTimeTrendDaily: db.prepare(`
        WITH user_messages AS (
            SELECT chat_id, timestamp
            FROM messages
            WHERE is_from_me = 0
              AND timestamp BETWEEN ? AND ?
        ),
        pairs AS (
            SELECT
                u.chat_id,
                u.timestamp as user_ts,
                (
                    SELECT MIN(r.timestamp)
                    FROM messages r
                    WHERE r.chat_id = u.chat_id
                      AND r.is_from_me = 1
                      AND r.timestamp > u.timestamp
                ) as response_ts
            FROM user_messages u
        )
        SELECT
            date(datetime(user_ts/1000, 'unixepoch')) as bucket,
            COUNT(*) as responses,
            AVG(response_ts - user_ts) as avg_ms
        FROM pairs
        WHERE response_ts IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket ASC
    `),
        getResponseTimeTrendWeekly: db.prepare(`
        WITH user_messages AS (
            SELECT chat_id, timestamp
            FROM messages
            WHERE is_from_me = 0
              AND timestamp BETWEEN ? AND ?
        ),
        pairs AS (
            SELECT
                u.chat_id,
                u.timestamp as user_ts,
                (
                    SELECT MIN(r.timestamp)
                    FROM messages r
                    WHERE r.chat_id = u.chat_id
                      AND r.is_from_me = 1
                      AND r.timestamp > u.timestamp
                ) as response_ts
            FROM user_messages u
        )
        SELECT
            strftime('%Y-%W', datetime(user_ts/1000, 'unixepoch')) as bucket,
            MIN(date(datetime(user_ts/1000, 'unixepoch'))) as week_start,
            COUNT(*) as responses,
            AVG(response_ts - user_ts) as avg_ms
        FROM pairs
        WHERE response_ts IS NOT NULL
        GROUP BY bucket
        ORDER BY bucket ASC
    `)
    };

    return { db, messages, chats, autoReplies, scheduled, webhooks, webhookDeliveries, scripts, scriptLogs, logs, maintenance, reports };
}

module.exports = { createDatabase };
}

module.exports = { createDatabase };

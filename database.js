/**
 * WhatsApp Web Panel - Database Module v2
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const { logger } = require('./services/logger');
const { hashPassword } = require('./services/passwords');

function createDatabase(config) {
    // Ensure data directory exists
    if (!fs.existsSync(config.DATA_DIR)) {
        fs.mkdirSync(config.DATA_DIR, { recursive: true });
    }

    const db = new Database(config.DB_PATH);
    let isClosed = false;
    const close = () => {
        if (isClosed) return;
        isClosed = true;
        try {
            db.close();
        } catch (error) {
            // Avoid throwing from shutdown paths
        }
    };
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
        quoted_message_id TEXT,
        quoted_body TEXT,
        quoted_from_name TEXT,
        is_group INTEGER DEFAULT 0,
        is_from_me INTEGER DEFAULT 0,
        ack INTEGER DEFAULT 0,
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
        template_id INTEGER,
        match_type TEXT DEFAULT 'contains',
        is_active INTEGER DEFAULT 1,
        reply_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        variables TEXT,
        category TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        message TEXT NOT NULL,
        template_id INTEGER,
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

    CREATE TABLE IF NOT EXISTS service_locks (
        name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_service_locks_expires_at ON service_locks(expires_at);

    CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        preferences TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, role_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT UNIQUE,
        name TEXT,
        phone TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contact_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        error TEXT,
        totals_json TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sync_state (
        chat_id TEXT PRIMARY KEY,
        run_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        cursor_type TEXT,
        cursor_value TEXT,
        oldest_msg_id TEXT,
        newest_msg_id TEXT,
        done_history INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS media_tasks (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        next_attempt_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profile_pic_tasks (
        chat_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        next_attempt_at DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
    CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_messages(scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_templates_category ON message_templates(category);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_scripts_active ON scripts(is_active);
    CREATE INDEX IF NOT EXISTS idx_script_logs_script ON script_logs(script_id);
    CREATE INDEX IF NOT EXISTS idx_script_logs_created ON script_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created ON webhook_deliveries(created_at);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_chat ON contacts(chat_id);
    CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_chat ON contact_tags(chat_id);
    CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_notes_chat ON notes(chat_id);
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
        },
        {
            version: 4,
            name: 'add_template_id_to_auto_replies',
            apply: () => {
                if (!columnExists('auto_replies', 'template_id')) {
                    db.exec('ALTER TABLE auto_replies ADD COLUMN template_id INTEGER');
                }
            }
        },
        {
            version: 5,
            name: 'add_template_id_to_scheduled_messages',
            apply: () => {
                if (!columnExists('scheduled_messages', 'template_id')) {
                    db.exec('ALTER TABLE scheduled_messages ADD COLUMN template_id INTEGER');
                }
            }
        },
        {
            version: 6,
            name: 'add_tags_to_auto_replies',
            apply: () => {
                if (!columnExists('auto_replies', 'required_tag_id')) {
                    db.exec('ALTER TABLE auto_replies ADD COLUMN required_tag_id INTEGER');
                }
                if (!columnExists('auto_replies', 'exclude_tag_id')) {
                    db.exec('ALTER TABLE auto_replies ADD COLUMN exclude_tag_id INTEGER');
                }
            }
        },
        {
            version: 7,
            name: 'add_ack_to_messages',
            apply: () => {
                if (!columnExists('messages', 'ack')) {
                    db.exec('ALTER TABLE messages ADD COLUMN ack INTEGER DEFAULT 0');
                }
            }
        },
        {
            version: 8,
            name: 'add_preferences_to_users',
            apply: () => {
                if (!columnExists('users', 'preferences')) {
                    db.exec('ALTER TABLE users ADD COLUMN preferences TEXT');
                }
            }
        },
        {
            version: 9,
            name: 'add_retry_fields_and_webhook_stats',
            apply: () => {
                if (!columnExists('scheduled_messages', 'retry_count')) {
                    db.exec('ALTER TABLE scheduled_messages ADD COLUMN retry_count INTEGER DEFAULT 0');
                }
                if (!columnExists('scheduled_messages', 'next_attempt_at')) {
                    db.exec('ALTER TABLE scheduled_messages ADD COLUMN next_attempt_at DATETIME');
                }
                if (!columnExists('scheduled_messages', 'last_error')) {
                    db.exec('ALTER TABLE scheduled_messages ADD COLUMN last_error TEXT');
                }

                if (!columnExists('webhooks', 'last_error')) {
                    db.exec('ALTER TABLE webhooks ADD COLUMN last_error TEXT');
                }
                if (!columnExists('webhooks', 'last_status')) {
                    db.exec('ALTER TABLE webhooks ADD COLUMN last_status INTEGER');
                }
                if (!columnExists('webhooks', 'last_duration_ms')) {
                    db.exec('ALTER TABLE webhooks ADD COLUMN last_duration_ms INTEGER');
                }
            }
        },
        {
            version: 10,
            name: 'add_whatsapp_sync_state',
            apply: () => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS whatsapp_sync_state (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        phase TEXT NOT NULL,
                        last_chat_id TEXT,
                        last_message_ts INTEGER,
                        attempt_count INTEGER DEFAULT 0,
                        last_error TEXT,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                `);
            }
        },
        {
            version: 11,
            name: 'add_full_sync_tables',
            apply: () => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS sync_runs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        status TEXT NOT NULL,
                        phase TEXT NOT NULL,
                        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        error TEXT,
                        totals_json TEXT
                    );

                    CREATE TABLE IF NOT EXISTS chat_sync_state (
                        chat_id TEXT PRIMARY KEY,
                        run_id INTEGER NOT NULL,
                        status TEXT NOT NULL,
                        cursor_type TEXT,
                        cursor_value TEXT,
                        oldest_msg_id TEXT,
                        newest_msg_id TEXT,
                        done_history INTEGER DEFAULT 0,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        last_error TEXT
                    );

                    CREATE TABLE IF NOT EXISTS media_tasks (
                        message_id TEXT PRIMARY KEY,
                        chat_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        attempts INTEGER DEFAULT 0,
                        next_attempt_at DATETIME,
                        last_error TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );

                    CREATE TABLE IF NOT EXISTS profile_pic_tasks (
                        chat_id TEXT PRIMARY KEY,
                        status TEXT NOT NULL,
                        attempts INTEGER DEFAULT 0,
                        next_attempt_at DATETIME,
                        last_error TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    );
                `);
            }
        },
        {
            version: 12,
            name: 'add_quoted_message_fields',
            apply: () => {
                if (!columnExists('messages', 'quoted_message_id')) {
                    db.exec('ALTER TABLE messages ADD COLUMN quoted_message_id TEXT');
                }
                if (!columnExists('messages', 'quoted_body')) {
                    db.exec('ALTER TABLE messages ADD COLUMN quoted_body TEXT');
                }
                if (!columnExists('messages', 'quoted_from_name')) {
                    db.exec('ALTER TABLE messages ADD COLUMN quoted_from_name TEXT');
                }
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

    logger.info('Database initialized', { category: 'database', dbPath: config.DB_PATH });

    // Prepared statements
    const messages = {
        save: db.prepare(`
        INSERT INTO messages
        (message_id, chat_id, from_number, to_number, from_name, body, type, media_path, media_url, media_mimetype, quoted_message_id, quoted_body, quoted_from_name, is_group, is_from_me, ack, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
            chat_id = excluded.chat_id,
            from_number = excluded.from_number,
            to_number = excluded.to_number,
            from_name = excluded.from_name,
            body = excluded.body,
            type = excluded.type,
            media_path = COALESCE(excluded.media_path, messages.media_path),
            media_url = COALESCE(excluded.media_url, messages.media_url),
            media_mimetype = COALESCE(excluded.media_mimetype, messages.media_mimetype),
            quoted_message_id = COALESCE(excluded.quoted_message_id, messages.quoted_message_id),
            quoted_body = COALESCE(excluded.quoted_body, messages.quoted_body),
            quoted_from_name = COALESCE(excluded.quoted_from_name, messages.quoted_from_name),
            is_group = excluded.is_group,
            is_from_me = excluded.is_from_me,
            ack = CASE WHEN excluded.ack > messages.ack THEN excluded.ack ELSE messages.ack END,
            timestamp = excluded.timestamp
    `),
        updateAck: db.prepare(`UPDATE messages SET ack = ? WHERE message_id = ?`),
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
            name = excluded.name,
            profile_pic = COALESCE(excluded.profile_pic, chats.profile_pic),
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
        create: db.prepare(`INSERT INTO auto_replies (trigger_word, response, template_id, match_type, is_active, required_tag_id, exclude_tag_id) VALUES (?, ?, ?, ?, ?, ?, ?)`),
        update: db.prepare(`UPDATE auto_replies SET trigger_word = ?, response = ?, template_id = ?, match_type = ?, is_active = ?, required_tag_id = ?, exclude_tag_id = ? WHERE id = ?`),
        delete: db.prepare('DELETE FROM auto_replies WHERE id = ?'),
        incrementCount: db.prepare('UPDATE auto_replies SET reply_count = reply_count + 1 WHERE id = ?'),
        toggle: db.prepare('UPDATE auto_replies SET is_active = ? WHERE id = ?')
    };

    const messageTemplates = {
        getAll: db.prepare('SELECT * FROM message_templates ORDER BY created_at DESC'),
        getById: db.prepare('SELECT * FROM message_templates WHERE id = ?'),
        create: db.prepare(`INSERT INTO message_templates (name, content, variables, category) VALUES (?, ?, ?, ?)`),
        update: db.prepare(`UPDATE message_templates SET name = ?, content = ?, variables = ?, category = ?, updated_at = datetime('now') WHERE id = ?`),
        delete: db.prepare('DELETE FROM message_templates WHERE id = ?')
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
        getRecurring: db.prepare(`
        SELECT * FROM scheduled_messages
        WHERE is_recurring = 1
          AND cron_expression IS NOT NULL
    `),
        getById: db.prepare('SELECT * FROM scheduled_messages WHERE id = ?'),
        create: db.prepare(`INSERT INTO scheduled_messages (chat_id, chat_name, message, template_id, scheduled_at, is_recurring, cron_expression) VALUES (?, ?, ?, ?, ?, ?, ?)`),
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

    const locks = {
        acquire: db.prepare(`
        INSERT INTO service_locks (name, owner_id, acquired_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            owner_id = excluded.owner_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
        WHERE service_locks.owner_id = excluded.owner_id
           OR service_locks.expires_at < excluded.acquired_at
    `),
        release: db.prepare('DELETE FROM service_locks WHERE name = ? AND owner_id = ?'),
        get: db.prepare('SELECT * FROM service_locks WHERE name = ?'),
        cleanupExpired: db.prepare('DELETE FROM service_locks WHERE expires_at < ?')
    };

    const roles = {
        getAll: db.prepare('SELECT * FROM roles ORDER BY name ASC'),
        getById: db.prepare('SELECT * FROM roles WHERE id = ?'),
        getByName: db.prepare('SELECT * FROM roles WHERE name = ?'),
        create: db.prepare('INSERT INTO roles (name, description) VALUES (?, ?)'),
        delete: db.prepare('DELETE FROM roles WHERE id = ?'),
        count: db.prepare('SELECT COUNT(*) as count FROM roles')
    };

    const users = {
        getAll: db.prepare(`
        SELECT users.id, users.username, users.display_name, users.is_active, users.created_at,
               roles.name as role
        FROM users
        LEFT JOIN user_roles ON user_roles.user_id = users.id
        LEFT JOIN roles ON roles.id = user_roles.role_id
        ORDER BY users.created_at DESC
    `),
        getById: db.prepare(`
        SELECT users.*, roles.name as role
        FROM users
        LEFT JOIN user_roles ON user_roles.user_id = users.id
        LEFT JOIN roles ON roles.id = user_roles.role_id
        WHERE users.id = ?
    `),
        getByUsername: db.prepare(`
        SELECT users.*, roles.name as role
        FROM users
        LEFT JOIN user_roles ON user_roles.user_id = users.id
        LEFT JOIN roles ON roles.id = user_roles.role_id
        WHERE users.username = ?
    `),
        create: db.prepare('INSERT INTO users (username, display_name, password_hash, password_salt, is_active, preferences) VALUES (?, ?, ?, ?, ?, ?)'),
        updatePreferences: db.prepare('UPDATE users SET preferences = ? WHERE id = ?'),
        delete: db.prepare('DELETE FROM users WHERE id = ?'),
        count: db.prepare('SELECT COUNT(*) as count FROM users')
    };

    const userRoles = {
        assign: db.prepare('INSERT OR REPLACE INTO user_roles (user_id, role_id) VALUES (?, ?)'),
        clear: db.prepare('DELETE FROM user_roles WHERE user_id = ?'),
        countByRole: db.prepare('SELECT COUNT(*) as count FROM user_roles WHERE role_id = ?')
    };

    const contacts = {
        upsert: db.prepare(`
        INSERT INTO contacts (chat_id, name, phone, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
            name = excluded.name,
            phone = excluded.phone,
            updated_at = datetime('now')
    `),
        getByChatId: db.prepare(`SELECT * FROM contacts WHERE chat_id = ?`)
    };

    const tags = {
        getAll: db.prepare(`SELECT * FROM tags ORDER BY name ASC`),
        getById: db.prepare(`SELECT * FROM tags WHERE id = ?`),
        getByName: db.prepare(`SELECT * FROM tags WHERE name = ?`),
        create: db.prepare(`INSERT INTO tags (name, color) VALUES (?, ?)`),
        update: db.prepare(`UPDATE tags SET name = ?, color = ? WHERE id = ?`),
        delete: db.prepare(`DELETE FROM tags WHERE id = ?`)
    };

    const contactTags = {
        add: db.prepare(`INSERT OR IGNORE INTO contact_tags (chat_id, tag_id) VALUES (?, ?)`),
        remove: db.prepare(`DELETE FROM contact_tags WHERE chat_id = ? AND tag_id = ?`),
        getByChatId: db.prepare(`
        SELECT tags.id, tags.name, tags.color
        FROM contact_tags
        JOIN tags ON tags.id = contact_tags.tag_id
        WHERE contact_tags.chat_id = ?
        ORDER BY tags.name ASC
    `),
        getChatIdsByTagId: db.prepare(`SELECT DISTINCT chat_id FROM contact_tags WHERE tag_id = ?`),
        getChatIdsByTagName: db.prepare(`
        SELECT DISTINCT contact_tags.chat_id
        FROM contact_tags
        JOIN tags ON tags.id = contact_tags.tag_id
        WHERE tags.name = ?
    `)
    };

    const notes = {
        getByChatId: db.prepare(`SELECT * FROM notes WHERE chat_id = ? ORDER BY created_at DESC`),
        create: db.prepare(`INSERT INTO notes (chat_id, content) VALUES (?, ?)`),
        update: db.prepare(`UPDATE notes SET content = ?, updated_at = datetime('now') WHERE id = ? AND chat_id = ?`),
        delete: db.prepare(`DELETE FROM notes WHERE id = ? AND chat_id = ?`),
        searchChatIds: db.prepare(`SELECT DISTINCT chat_id FROM notes WHERE content LIKE ?`)
    };

    const whatsappSettings = {
        get: db.prepare('SELECT settings FROM whatsapp_settings WHERE id = 1'),
        upsert: db.prepare(`
            INSERT INTO whatsapp_settings (id, settings, updated_at)
            VALUES (1, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                settings = excluded.settings,
                updated_at = datetime('now')
        `)
    };

    const syncRuns = {
        create: db.prepare(`
            INSERT INTO sync_runs (status, phase, started_at, updated_at, error, totals_json)
            VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)
        `),
        getRunning: db.prepare(`
            SELECT * FROM sync_runs
            WHERE status = 'running'
            ORDER BY started_at DESC
            LIMIT 1
        `),
        getLatest: db.prepare(`
            SELECT * FROM sync_runs
            ORDER BY started_at DESC
            LIMIT 1
        `),
        getById: db.prepare('SELECT * FROM sync_runs WHERE id = ?'),
        update: db.prepare(`
            UPDATE sync_runs
            SET status = ?, phase = ?, error = ?, totals_json = ?, updated_at = datetime('now')
            WHERE id = ?
        `),
        updatePhase: db.prepare(`
            UPDATE sync_runs
            SET phase = ?, updated_at = datetime('now')
            WHERE id = ?
        `),
        updateTotals: db.prepare(`
            UPDATE sync_runs
            SET totals_json = ?, updated_at = datetime('now')
            WHERE id = ?
        `),
        markError: db.prepare(`
            UPDATE sync_runs
            SET status = 'failed',
                phase = ?,
                error = ?,
                updated_at = datetime('now')
            WHERE id = ?
        `)
    };

    const chatSyncState = {
        getByChatId: db.prepare(`
            SELECT * FROM chat_sync_state WHERE chat_id = ? AND run_id = ?
        `),
        getByChatIdAny: db.prepare(`
            SELECT * FROM chat_sync_state WHERE chat_id = ?
        `),
        upsert: db.prepare(`
            INSERT INTO chat_sync_state
                (chat_id, run_id, status, cursor_type, cursor_value, oldest_msg_id, newest_msg_id, done_history, updated_at, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
            ON CONFLICT(chat_id) DO UPDATE SET
                run_id = excluded.run_id,
                status = excluded.status,
                cursor_type = excluded.cursor_type,
                cursor_value = excluded.cursor_value,
                oldest_msg_id = excluded.oldest_msg_id,
                newest_msg_id = excluded.newest_msg_id,
                done_history = excluded.done_history,
                last_error = excluded.last_error,
                updated_at = datetime('now')
        `),
        countByRun: db.prepare(`
            SELECT COUNT(*) as total
            FROM chat_sync_state
            WHERE run_id = ?
        `),
        countDoneHistory: db.prepare(`
            SELECT COUNT(*) as total
            FROM chat_sync_state
            WHERE run_id = ? AND done_history = 1
        `)
    };

    const mediaTasks = {
        upsert: db.prepare(`
            INSERT INTO media_tasks
                (message_id, chat_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
            VALUES (?, ?, 'pending', 0, NULL, NULL, datetime('now'), datetime('now'))
            ON CONFLICT(message_id) DO UPDATE SET
                chat_id = excluded.chat_id,
                status = CASE
                    WHEN media_tasks.status IN ('done', 'failed') THEN media_tasks.status
                    ELSE excluded.status
                END,
                updated_at = datetime('now')
        `),
        getRunnable: db.prepare(`
            SELECT * FROM media_tasks
            WHERE status IN ('pending', 'running')
              AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
            ORDER BY updated_at ASC
            LIMIT ?
        `),
        markRunning: db.prepare(`
            UPDATE media_tasks
            SET status = 'running', updated_at = datetime('now')
            WHERE message_id = ? AND status IN ('pending', 'running')
        `),
        markDone: db.prepare(`
            UPDATE media_tasks
            SET status = 'done',
                attempts = ?,
                next_attempt_at = NULL,
                last_error = NULL,
                updated_at = datetime('now')
            WHERE message_id = ?
        `),
        reschedule: db.prepare(`
            UPDATE media_tasks
            SET status = 'pending',
                attempts = ?,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = datetime('now')
            WHERE message_id = ?
        `),
        markFailed: db.prepare(`
            UPDATE media_tasks
            SET status = 'failed',
                attempts = ?,
                next_attempt_at = NULL,
                last_error = ?,
                updated_at = datetime('now')
            WHERE message_id = ?
        `),
        countByStatus: db.prepare(`
            SELECT status, COUNT(*) as total
            FROM media_tasks
            GROUP BY status
        `)
    };

    const profilePicTasks = {
        upsert: db.prepare(`
            INSERT INTO profile_pic_tasks
                (chat_id, status, attempts, next_attempt_at, last_error, created_at, updated_at)
            VALUES (?, 'pending', 0, NULL, NULL, datetime('now'), datetime('now'))
            ON CONFLICT(chat_id) DO UPDATE SET
                status = CASE
                    WHEN profile_pic_tasks.status IN ('done', 'failed') THEN profile_pic_tasks.status
                    ELSE excluded.status
                END,
                updated_at = datetime('now')
        `),
        getRunnable: db.prepare(`
            SELECT * FROM profile_pic_tasks
            WHERE status IN ('pending', 'running')
              AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))
            ORDER BY updated_at ASC
            LIMIT ?
        `),
        markRunning: db.prepare(`
            UPDATE profile_pic_tasks
            SET status = 'running', updated_at = datetime('now')
            WHERE chat_id = ? AND status IN ('pending', 'running')
        `),
        markDone: db.prepare(`
            UPDATE profile_pic_tasks
            SET status = 'done',
                attempts = ?,
                next_attempt_at = NULL,
                last_error = NULL,
                updated_at = datetime('now')
            WHERE chat_id = ?
        `),
        reschedule: db.prepare(`
            UPDATE profile_pic_tasks
            SET status = 'pending',
                attempts = ?,
                next_attempt_at = ?,
                last_error = ?,
                updated_at = datetime('now')
            WHERE chat_id = ?
        `),
        markFailed: db.prepare(`
            UPDATE profile_pic_tasks
            SET status = 'failed',
                attempts = ?,
                next_attempt_at = NULL,
                last_error = ?,
                updated_at = datetime('now')
            WHERE chat_id = ?
        `),
        countByStatus: db.prepare(`
            SELECT status, COUNT(*) as total
            FROM profile_pic_tasks
            GROUP BY status
        `)
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

    const bootstrapAdmin = () => {
        const defaultRoles = [
            { name: 'admin', description: 'Tam yetkili' },
            { name: 'manager', description: 'Yonetici' },
            { name: 'agent', description: 'Agent' }
        ];

        defaultRoles.forEach(role => {
            if (!roles.getByName.get(role.name)) {
                roles.create.run(role.name, role.description);
            }
        });

        const userCount = users.count.get().count;
        if (userCount > 0) return;

        const username = (config.ADMIN_BOOTSTRAP_USERNAME || '').trim().toLowerCase();
        const password = config.ADMIN_BOOTSTRAP_PASSWORD;
        const displayName = config.ADMIN_BOOTSTRAP_NAME || username;

        if (!username || !password) {
            logger.warn('[AUTH] Admin bootstrap skipped: missing config values.', { category: 'auth' });
            return;
        }

        const { hash, salt } = hashPassword(password);
        const result = users.create.run(username, displayName, hash, salt, 1, null);
        const adminRole = roles.getByName.get('admin');
        if (adminRole) {
            userRoles.assign.run(result.lastInsertRowid, adminRole.id);
        }
    };

    bootstrapAdmin();

    return {
        db,
        close,
        messages,
        chats,
        autoReplies,
        messageTemplates,
        scheduled,
        webhooks,
        webhookDeliveries,
        scripts,
        scriptLogs,
        logs,
        locks,
        roles,
        users,
        userRoles,
        contacts,
        tags,
        contactTags,
        notes,
        whatsappSettings,
        syncRuns,
        chatSyncState,
        mediaTasks,
        profilePicTasks,
        maintenance,
        reports
    };
}

module.exports = { createDatabase };

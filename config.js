/**
 * WhatsApp Web Panel - Configuration
 */
const path = require('path');

// Load environment variables from .env file
try {
    require('dotenv').config({ quiet: true });
} catch (e) {
    // dotenv not installed, using defaults
}

function toPositiveInt(value, fallback) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const logsDir = process.env.LOGS_DIR ? path.resolve(process.env.LOGS_DIR) : path.join(__dirname, 'logs');

module.exports = {
    // Instance identity (useful for PM2 / multi-process locks)
    INSTANCE_ID: process.env.INSTANCE_ID
        || process.env.pm_id
        || process.env.NODE_APP_INSTANCE
        || String(process.pid),

    // Background jobs (scheduler/cleanup)
    ENABLE_BACKGROUND_JOBS: process.env.ENABLE_BACKGROUND_JOBS !== 'false',

    // Server
    PORT: process.env.PORT || 3000,

    // Authentication - Use environment variables for secrets
    SITE_PASSWORD: process.env.SITE_PASSWORD || 'changeme',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    SESSION_SECRET: process.env.SESSION_SECRET || 'change-this-secret-in-production',
    ADMIN_BOOTSTRAP_USERNAME: process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin',
    ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD || process.env.SITE_PASSWORD || 'changeme',
    ADMIN_BOOTSTRAP_NAME: process.env.ADMIN_BOOTSTRAP_NAME || 'Admin',

    // CORS Origins (required)
    CORS_ORIGINS: process.env.CORS_ORIGINS,

    // Redis (optional)
    REDIS_URL: process.env.REDIS_URL,
    REDIS_PREFIX: process.env.REDIS_PREFIX || 'wp-panel:',

    // Metrics (optional)
    METRICS_ENABLED: process.env.METRICS_ENABLED === 'true',
    METRICS_TOKEN: process.env.METRICS_TOKEN,

    // Password policy
    PASSWORD_POLICY: {
        MIN_LENGTH: toPositiveInt(process.env.PASSWORD_MIN_LENGTH || '8', 8),
        REQUIRE_UPPER: process.env.PASSWORD_REQUIRE_UPPER === 'true',
        REQUIRE_LOWER: process.env.PASSWORD_REQUIRE_LOWER === 'true',
        REQUIRE_NUMBER: process.env.PASSWORD_REQUIRE_NUMBER === 'true',
        REQUIRE_SYMBOL: process.env.PASSWORD_REQUIRE_SYMBOL === 'true'
    },

    // API Rate limits
    API_RATE_LIMIT: {
        IP_WINDOW_MS: toPositiveInt(process.env.API_RATE_LIMIT_IP_WINDOW_MS || String(15 * 60 * 1000), 15 * 60 * 1000),
        IP_MAX: toPositiveInt(process.env.API_RATE_LIMIT_IP_MAX || '300', 300),
        USER_WINDOW_MS: toPositiveInt(process.env.API_RATE_LIMIT_USER_WINDOW_MS || String(15 * 60 * 1000), 15 * 60 * 1000),
        USER_MAX: toPositiveInt(process.env.API_RATE_LIMIT_USER_MAX || '150', 150)
    },
    
    // Paths
    DATA_DIR: dataDir,
    SESSION_DIR: process.env.SESSION_DIR ? path.resolve(process.env.SESSION_DIR) : path.join(dataDir, 'session'),
    DB_PATH: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(dataDir, 'whatsapp.db'),
    LOGS_DIR: logsDir,
    MEDIA_DIR: process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(dataDir, 'media'),
    
    // WhatsApp
    PUPPETEER_ARGS: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
    ],
    
    // Scheduler
    SCHEDULER_CHECK_INTERVAL: 60000, // 1 minute
    SCHEDULER_MAX_RETRIES: 5,
    SCHEDULER_RETRY_BASE_MS: 60000, // 1 minute
    SCHEDULER_LOCK_TTL_MS: toPositiveInt(process.env.SCHEDULER_LOCK_TTL_MS || String(3 * 60 * 1000), 3 * 60 * 1000),

    // Cleanup
    CLEANUP_DAILY_CRON: process.env.CLEANUP_DAILY_CRON || '0 3 * * *',
    CLEANUP_WEEKLY_CRON: process.env.CLEANUP_WEEKLY_CRON || '0 4 * * 0',
    LOG_RETENTION_DAYS: toPositiveInt(process.env.LOG_RETENTION_DAYS || '30', 30),
    SCRIPT_LOG_RETENTION_DAYS: toPositiveInt(process.env.SCRIPT_LOG_RETENTION_DAYS || '30', 30),
    MESSAGE_RETENTION_DAYS: toPositiveInt(process.env.MESSAGE_RETENTION_DAYS || '90', 90),
    CLEANUP_LOCK_TTL_MS: toPositiveInt(process.env.CLEANUP_LOCK_TTL_MS || String(15 * 60 * 1000), 15 * 60 * 1000),
    
    // Webhook
    WEBHOOK_TIMEOUT: 10000, // 10 seconds
    WEBHOOK_MAX_RETRIES: 3,
    WEBHOOK_RETRY_BASE_MS: 1000, // 1 second
    
    // Logging
    LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

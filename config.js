/**
 * WhatsApp Web Panel - Configuration
 */
const path = require('path');

// Load environment variables from .env file
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, using defaults
}

function toPositiveInt(value, fallback) {
    const num = parseInt(value, 10);
    return Number.isFinite(num) && num > 0 ? num : fallback;
}

module.exports = {
    // Server
    PORT: process.env.PORT || 3000,

    // Authentication - Use environment variables for secrets
    SITE_PASSWORD: process.env.SITE_PASSWORD || 'changeme',
    SESSION_SECRET: process.env.SESSION_SECRET || 'change-this-secret-in-production',
    ADMIN_BOOTSTRAP_USERNAME: process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin',
    ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD || process.env.SITE_PASSWORD || 'changeme',
    ADMIN_BOOTSTRAP_NAME: process.env.ADMIN_BOOTSTRAP_NAME || 'Admin',

    // CORS Origins (required)
    CORS_ORIGINS: process.env.CORS_ORIGINS,

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
    DATA_DIR: path.join(__dirname, 'data'),
    SESSION_DIR: path.join(__dirname, 'data', 'session'),
    DB_PATH: path.join(__dirname, 'data', 'whatsapp.db'),
    LOGS_DIR: path.join(__dirname, 'logs'),
    MEDIA_DIR: path.join(__dirname, 'data', 'media'),
    
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

    // Cleanup
    CLEANUP_DAILY_CRON: process.env.CLEANUP_DAILY_CRON || '0 3 * * *',
    CLEANUP_WEEKLY_CRON: process.env.CLEANUP_WEEKLY_CRON || '0 4 * * 0',
    LOG_RETENTION_DAYS: toPositiveInt(process.env.LOG_RETENTION_DAYS || '30', 30),
    SCRIPT_LOG_RETENTION_DAYS: toPositiveInt(process.env.SCRIPT_LOG_RETENTION_DAYS || '30', 30),
    MESSAGE_RETENTION_DAYS: toPositiveInt(process.env.MESSAGE_RETENTION_DAYS || '90', 90),
    
    // Webhook
    WEBHOOK_TIMEOUT: 10000, // 10 seconds
    WEBHOOK_MAX_RETRIES: 3,
    WEBHOOK_RETRY_BASE_MS: 1000, // 1 second
    
    // Logging
    LOG_LEVEL: 'info'
};

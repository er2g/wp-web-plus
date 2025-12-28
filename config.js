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

module.exports = {
    // Server
    PORT: process.env.PORT || 3000,

    // Authentication - Use environment variables for secrets
    SITE_PASSWORD: process.env.SITE_PASSWORD || 'changeme',
    SESSION_SECRET: process.env.SESSION_SECRET || 'change-this-secret-in-production',

    // CORS Origins (required)
    CORS_ORIGINS: process.env.CORS_ORIGINS,

    // Password policy
    PASSWORD_POLICY: {
        MIN_LENGTH: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
        REQUIRE_UPPER: process.env.PASSWORD_REQUIRE_UPPER === 'true',
        REQUIRE_LOWER: process.env.PASSWORD_REQUIRE_LOWER === 'true',
        REQUIRE_NUMBER: process.env.PASSWORD_REQUIRE_NUMBER === 'true',
        REQUIRE_SYMBOL: process.env.PASSWORD_REQUIRE_SYMBOL === 'true'
    },

    // API Rate limits
    API_RATE_LIMIT: {
        IP_WINDOW_MS: parseInt(process.env.API_RATE_LIMIT_IP_WINDOW_MS || String(15 * 60 * 1000), 10),
        IP_MAX: parseInt(process.env.API_RATE_LIMIT_IP_MAX || '300', 10),
        USER_WINDOW_MS: parseInt(process.env.API_RATE_LIMIT_USER_WINDOW_MS || String(15 * 60 * 1000), 10),
        USER_MAX: parseInt(process.env.API_RATE_LIMIT_USER_MAX || '150', 10)
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
    
    // Webhook
    WEBHOOK_TIMEOUT: 10000, // 10 seconds
    
    // Logging
    LOG_LEVEL: 'info'
};

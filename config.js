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

    // CORS Origins
    CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3000',
    
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
    
    // Webhook
    WEBHOOK_TIMEOUT: 10000, // 10 seconds
    WEBHOOK_MAX_RETRIES: 3,
    WEBHOOK_RETRY_BASE_MS: 1000, // 1 second
    
    // Logging
    LOG_LEVEL: 'info'
};

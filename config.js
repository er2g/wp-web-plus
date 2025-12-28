/**
 * WhatsApp Web Panel - Configuration
 */
const path = require('path');

module.exports = {
    // Server
    PORT: process.env.PORT || 3000,
    
    // Authentication
    SITE_PASSWORD: 'ertug123',
    SESSION_SECRET: 'whatsapp-secret-key-2024-ertug',
    
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

/**
 * WhatsApp Web Panel - Configuration
 */
const path = require('path');
const { z } = require('zod');

// Load environment variables from .env file
try {
    require('dotenv').config({ quiet: true });
} catch (e) {
    // dotenv not installed, using defaults
}

function emptyToUndefined(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && value.trim() === '') return undefined;
    return value;
}

function booleanLike(defaultValue) {
    return z.preprocess(
        (value) => {
            const normalized = emptyToUndefined(value);
            if (normalized === undefined) return undefined;
            if (normalized === true || normalized === false) return normalized;
            const text = String(normalized).trim().toLowerCase();
            if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
            if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
            return normalized;
        },
        z.boolean().default(defaultValue)
    );
}

function positiveInt(defaultValue) {
    return z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));
}

function optionalString() {
    return z.preprocess(emptyToUndefined, z.string().min(1)).optional();
}

function requiredString(defaultValue) {
    return z.preprocess(emptyToUndefined, z.string().min(1).default(defaultValue));
}

function formatZodError(error) {
    const issues = error?.issues;
    if (!Array.isArray(issues) || issues.length === 0) return String(error?.message || error);
    return issues
        .slice(0, 12)
        .map((issue) => `${issue.path?.join('.') || 'env'}: ${issue.message}`)
        .join('; ');
}

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    PORT: positiveInt(3000),
    SHUTDOWN_TIMEOUT_MS: positiveInt(10000),

    SITE_PASSWORD: requiredString('changeme'),
    GEMINI_API_KEY: optionalString(),
    VERTEX_API_KEY: optionalString(),
    SESSION_SECRET: requiredString('change-this-secret-in-production'),

    ADMIN_BOOTSTRAP_USERNAME: requiredString('admin'),
    ADMIN_BOOTSTRAP_PASSWORD: optionalString(),
    ADMIN_BOOTSTRAP_NAME: requiredString('Admin'),

    CORS_ORIGINS: optionalString(),

    ENABLE_BACKGROUND_JOBS: booleanLike(true),

    INSTANCE_ID: optionalString(),

    REDIS_URL: optionalString(),
    REDIS_PREFIX: requiredString('wp-panel:'),

    METRICS_ENABLED: booleanLike(false),
    METRICS_TOKEN: optionalString(),

    PASSWORD_MIN_LENGTH: positiveInt(8),
    PASSWORD_REQUIRE_UPPER: booleanLike(false),
    PASSWORD_REQUIRE_LOWER: booleanLike(false),
    PASSWORD_REQUIRE_NUMBER: booleanLike(false),
    PASSWORD_REQUIRE_SYMBOL: booleanLike(false),

    API_RATE_LIMIT_IP_WINDOW_MS: positiveInt(15 * 60 * 1000),
    API_RATE_LIMIT_IP_MAX: positiveInt(300 * 1000),
    API_RATE_LIMIT_USER_WINDOW_MS: positiveInt(15 * 60 * 1000),
    API_RATE_LIMIT_USER_MAX: positiveInt(150 * 1000),

    DATA_DIR: optionalString(),
    LOGS_DIR: optionalString(),
    SESSION_DIR: optionalString(),
    DB_PATH: optionalString(),
    MEDIA_DIR: optionalString(),

    SCHEDULER_LOCK_TTL_MS: positiveInt(3 * 60 * 1000),
    CLEANUP_LOCK_TTL_MS: positiveInt(15 * 60 * 1000),

    CLEANUP_DAILY_CRON: requiredString('0 3 * * *'),
    CLEANUP_WEEKLY_CRON: requiredString('0 4 * * 0'),

    WEBHOOK_TIMEOUT: positiveInt(10000),
    WEBHOOK_MAX_RETRIES: positiveInt(3),
    WEBHOOK_RETRY_BASE_MS: positiveInt(1000),
    WEBHOOK_CONCURRENCY: positiveInt(2),
    WEBHOOK_QUEUE_LIMIT: positiveInt(2000),

    WHATSAPP_INIT_TIMEOUT_MS: positiveInt(60000),

    LOG_RETENTION_DAYS: positiveInt(30),
    SCRIPT_LOG_RETENTION_DAYS: positiveInt(30),
    MESSAGE_RETENTION_DAYS: positiveInt(90),

    LOG_LEVEL: requiredString('info')
}).passthrough();

let env;
try {
    env = envSchema.parse(process.env);
} catch (error) {
    throw new Error(`Invalid environment variables: ${formatZodError(error)}`);
}

const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(__dirname, 'data');
const logsDir = env.LOGS_DIR ? path.resolve(env.LOGS_DIR) : path.join(__dirname, 'logs');

module.exports = {
    // Instance identity (useful for PM2 / multi-process locks)
    INSTANCE_ID: env.INSTANCE_ID
        || process.env.pm_id
        || process.env.NODE_APP_INSTANCE
        || String(process.pid),

    // Background jobs (scheduler/cleanup)
    ENABLE_BACKGROUND_JOBS: env.ENABLE_BACKGROUND_JOBS,

    // Server
    PORT: env.PORT,
    SHUTDOWN_TIMEOUT_MS: env.SHUTDOWN_TIMEOUT_MS,

    // Authentication - Use environment variables for secrets
    SITE_PASSWORD: env.SITE_PASSWORD,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    VERTEX_API_KEY: env.VERTEX_API_KEY,
    SESSION_SECRET: env.SESSION_SECRET,
    ADMIN_BOOTSTRAP_USERNAME: env.ADMIN_BOOTSTRAP_USERNAME,
    ADMIN_BOOTSTRAP_PASSWORD: env.ADMIN_BOOTSTRAP_PASSWORD || env.SITE_PASSWORD || 'changeme',
    ADMIN_BOOTSTRAP_NAME: env.ADMIN_BOOTSTRAP_NAME,

    // CORS Origins (required)
    CORS_ORIGINS: env.CORS_ORIGINS,

    // Redis (optional)
    REDIS_URL: env.REDIS_URL,
    REDIS_PREFIX: env.REDIS_PREFIX,

    // Metrics (optional)
    METRICS_ENABLED: env.METRICS_ENABLED,
    METRICS_TOKEN: env.METRICS_TOKEN,

    // Password policy
    PASSWORD_POLICY: {
        MIN_LENGTH: env.PASSWORD_MIN_LENGTH,
        REQUIRE_UPPER: env.PASSWORD_REQUIRE_UPPER,
        REQUIRE_LOWER: env.PASSWORD_REQUIRE_LOWER,
        REQUIRE_NUMBER: env.PASSWORD_REQUIRE_NUMBER,
        REQUIRE_SYMBOL: env.PASSWORD_REQUIRE_SYMBOL
    },

    // API Rate limits
    API_RATE_LIMIT: {
        IP_WINDOW_MS: env.API_RATE_LIMIT_IP_WINDOW_MS,
        IP_MAX: env.API_RATE_LIMIT_IP_MAX,
        USER_WINDOW_MS: env.API_RATE_LIMIT_USER_WINDOW_MS,
        USER_MAX: env.API_RATE_LIMIT_USER_MAX
    },
    
    // Paths
    DATA_DIR: dataDir,
    SESSION_DIR: env.SESSION_DIR ? path.resolve(env.SESSION_DIR) : path.join(dataDir, 'session'),
    DB_PATH: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'whatsapp.db'),
    LOGS_DIR: logsDir,
    MEDIA_DIR: env.MEDIA_DIR ? path.resolve(env.MEDIA_DIR) : path.join(dataDir, 'media'),
    
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
    WHATSAPP_INIT_TIMEOUT_MS: env.WHATSAPP_INIT_TIMEOUT_MS,
    
    // Scheduler
    SCHEDULER_CHECK_INTERVAL: 60000, // 1 minute
    SCHEDULER_MAX_RETRIES: 5,
    SCHEDULER_RETRY_BASE_MS: 60000, // 1 minute
    SCHEDULER_LOCK_TTL_MS: env.SCHEDULER_LOCK_TTL_MS,

    // Cleanup
    CLEANUP_DAILY_CRON: env.CLEANUP_DAILY_CRON,
    CLEANUP_WEEKLY_CRON: env.CLEANUP_WEEKLY_CRON,
    LOG_RETENTION_DAYS: env.LOG_RETENTION_DAYS,
    SCRIPT_LOG_RETENTION_DAYS: env.SCRIPT_LOG_RETENTION_DAYS,
    MESSAGE_RETENTION_DAYS: env.MESSAGE_RETENTION_DAYS,
    CLEANUP_LOCK_TTL_MS: env.CLEANUP_LOCK_TTL_MS,
    
    // Webhook
    WEBHOOK_TIMEOUT: env.WEBHOOK_TIMEOUT,
    WEBHOOK_MAX_RETRIES: env.WEBHOOK_MAX_RETRIES,
    WEBHOOK_RETRY_BASE_MS: env.WEBHOOK_RETRY_BASE_MS,
    WEBHOOK_CONCURRENCY: env.WEBHOOK_CONCURRENCY,
    WEBHOOK_QUEUE_LIMIT: env.WEBHOOK_QUEUE_LIMIT,
    
    // Logging
    LOG_LEVEL: env.LOG_LEVEL
};

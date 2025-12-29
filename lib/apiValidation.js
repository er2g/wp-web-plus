const { isSafeExternalUrl } = require('./urlSafety');

// Constants
const LIMITS = {
    FILE_SIZE_BYTES: 16 * 1024 * 1024, // 16 MB
    MESSAGE_LENGTH: 10000,
    TRIGGER_LENGTH: 500,
    TAG_LENGTH: 60,
    NOTE_LENGTH: 2000,
    URL_LENGTH: 2048,
    QUERY_LENGTH: 200,
    CATEGORY_LENGTH: 50,
    TEMPLATE_NAME_LENGTH: 200,
    TEMPLATE_VARIABLES_LENGTH: 500,
    PAGINATION: {
        MESSAGES: 500,
        LOGS: 500,
        SCRIPT_LOGS: 200,
        WEBHOOK_DELIVERIES: 200
    }
};

function validateChatId(chatId) {
    if (!chatId || typeof chatId !== 'string') return false;
    // WhatsApp chat IDs are typically phone@c.us or groupId@g.us
    return /^[\w\-@.]+$/.test(chatId) && chatId.length <= 100;
}

function validateMessage(message) {
    if (!message || typeof message !== 'string') return false;
    return message.length <= LIMITS.MESSAGE_LENGTH;
}

function validateNote(note) {
    if (!note || typeof note !== 'string') return false;
    return note.length <= LIMITS.NOTE_LENGTH;
}

function normalizeTemplateVariables(rawVariables) {
    if (!rawVariables) return [];
    if (Array.isArray(rawVariables)) {
        return rawVariables
            .map(item => String(item).trim())
            .filter(Boolean)
            .slice(0, 50);
    }
    if (typeof rawVariables === 'string') {
        return rawVariables
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 50);
    }
    return [];
}

function validateUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return isSafeExternalUrl(url, { maxLength: LIMITS.URL_LENGTH });
}

function parseDateRange(query) {
    const now = Date.now();
    const endRaw = query.end ? Number(query.end) : now;
    const startRaw = query.start ? Number(query.start) : endRaw - 7 * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
        return null;
    }

    const start = Math.floor(startRaw);
    const end = Math.floor(endRaw);

    if (start > end) {
        return null;
    }

    return { start, end };
}

module.exports = {
    LIMITS,
    validateChatId,
    validateMessage,
    validateNote,
    normalizeTemplateVariables,
    validateUrl,
    parseDateRange
};


const crypto = require('crypto');
const config = require('../config');
const { base64UrlEncode, signHS256, verifyHS256 } = require('../lib/jwt');

const ISSUER = 'wp-panel';
const AUDIENCE = 'mobile';

function extractBearerToken(authHeader) {
    if (!authHeader) return null;
    const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
    const token = trimmed.slice(7).trim();
    return token || null;
}

function normalizeAccessToken(candidate) {
    if (!candidate) return null;
    const raw = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    const bearer = extractBearerToken(trimmed);
    if (bearer) return bearer;
    // Allow passing raw JWT (useful for Socket.IO handshake auth)
    if (trimmed.split('.').length === 3) return trimmed;
    return null;
}

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

function generateRefreshToken() {
    return base64UrlEncode(crypto.randomBytes(32));
}

function signAccessToken({ user, accountId }) {
    const ttlSec = Math.max(30, Number(config.MOBILE_ACCESS_TOKEN_TTL_SEC) || 900);
    return signHS256(
        {
            sub: String(user.id),
            username: user.username,
            role: user.role || 'agent',
            accountId: accountId || null
        },
        config.MOBILE_JWT_SECRET,
        { issuer: ISSUER, audience: AUDIENCE, expiresInSec: ttlSec }
    );
}

function verifyAccessToken(token) {
    return verifyHS256(token, config.MOBILE_JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
}

function refreshTtlMs() {
    const days = Math.max(1, Number(config.MOBILE_REFRESH_TOKEN_TTL_DAYS) || 30);
    return days * 24 * 60 * 60 * 1000;
}

function issueTokens({ db, user, accountId, deviceId, ip, userAgent }) {
    const nowMs = Date.now();
    const refreshToken = generateRefreshToken();
    const refreshHash = hashToken(refreshToken);
    const expiresAt = nowMs + refreshTtlMs();

    db.mobileRefreshTokens.create.run(
        user.id,
        refreshHash,
        deviceId || null,
        nowMs,
        expiresAt,
        null,
        null,
        ip || null,
        userAgent || null
    );

    db.mobileNotificationSettings.ensureDefault.run(user.id);

    const accessToken = signAccessToken({ user, accountId });
    return {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresInSec: Math.max(30, Number(config.MOBILE_ACCESS_TOKEN_TTL_SEC) || 900)
    };
}

function rotateRefreshToken({ db, oldRefreshToken, accountId, ip, userAgent }) {
    const nowMs = Date.now();
    const oldHash = hashToken(oldRefreshToken);
    const row = db.mobileRefreshTokens.getByHash.get(oldHash);
    if (!row) {
        const err = new Error('Invalid refresh token');
        err.status = 401;
        throw err;
    }
    if (row.revoked_at) {
        const err = new Error('Refresh token revoked');
        err.status = 401;
        throw err;
    }
    if (row.expires_at <= nowMs) {
        const err = new Error('Refresh token expired');
        err.status = 401;
        throw err;
    }

    const newRefreshToken = generateRefreshToken();
    const newHash = hashToken(newRefreshToken);
    const expiresAt = nowMs + refreshTtlMs();

    // Revoke old and insert new (rotation).
    db.mobileRefreshTokens.revokeByHash.run(nowMs, newHash, oldHash);
    db.mobileRefreshTokens.create.run(
        row.user_id,
        newHash,
        row.device_id || null,
        nowMs,
        expiresAt,
        null,
        null,
        ip || null,
        userAgent || null
    );

    db.mobileNotificationSettings.ensureDefault.run(row.user_id);

    const user = db.users.getById.get(row.user_id);
    if (!user || !user.is_active) {
        const err = new Error('User not active');
        err.status = 401;
        throw err;
    }

    const accessToken = signAccessToken({ user, accountId: accountId || null });
    return {
        userId: row.user_id,
        accessToken,
        refreshToken: newRefreshToken,
        tokenType: 'Bearer',
        expiresInSec: Math.max(30, Number(config.MOBILE_ACCESS_TOKEN_TTL_SEC) || 900)
    };
}

function revokeRefreshToken({ db, refreshToken, replacedByHash = null }) {
    const nowMs = Date.now();
    const hash = hashToken(refreshToken);
    db.mobileRefreshTokens.revokeByHash.run(nowMs, replacedByHash, hash);
}

function revokeAllRefreshTokensForUser({ db, userId }) {
    db.mobileRefreshTokens.revokeAllByUser.run(Date.now(), userId);
}

module.exports = {
    extractBearerToken,
    normalizeAccessToken,
    hashToken,
    signAccessToken,
    verifyAccessToken,
    issueTokens,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokensForUser
};

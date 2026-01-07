const crypto = require('crypto');

function base64UrlEncode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
    return buf
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

function base64UrlDecode(input) {
    const str = String(input).replace(/-/g, '+').replace(/_/g, '/');
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str + pad, 'base64');
}

function jsonBase64UrlEncode(obj) {
    return base64UrlEncode(Buffer.from(JSON.stringify(obj)));
}

function timingSafeEqualString(a, b) {
    const aBuf = Buffer.from(String(a));
    const bBuf = Buffer.from(String(b));
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function signHS256(payload, secret, options = {}) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const resolvedPayload = {
        iat: nowSec,
        ...payload
    };

    if (options.issuer) resolvedPayload.iss = options.issuer;
    if (options.audience) resolvedPayload.aud = options.audience;
    if (Number.isFinite(options.expiresInSec)) resolvedPayload.exp = nowSec + Math.max(1, options.expiresInSec);

    const encodedHeader = jsonBase64UrlEncode(header);
    const encodedPayload = jsonBase64UrlEncode(resolvedPayload);
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
        .createHmac('sha256', String(secret))
        .update(signingInput)
        .digest();

    return `${signingInput}.${base64UrlEncode(signature)}`;
}

function verifyHS256(token, secret, options = {}) {
    if (!token || typeof token !== 'string') {
        const err = new Error('Missing token');
        err.code = 'JWT_MISSING';
        throw err;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        const err = new Error('Invalid token format');
        err.code = 'JWT_FORMAT';
        throw err;
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    let header;
    let payload;
    try {
        header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
        payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
    } catch (e) {
        const err = new Error('Invalid token encoding');
        err.code = 'JWT_DECODE';
        throw err;
    }

    if (header?.alg !== 'HS256' || header?.typ !== 'JWT') {
        const err = new Error('Unsupported token');
        err.code = 'JWT_ALG';
        throw err;
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto
        .createHmac('sha256', String(secret))
        .update(signingInput)
        .digest();

    const signatureBuf = base64UrlDecode(encodedSignature);
    if (signatureBuf.length !== expectedSignature.length || !crypto.timingSafeEqual(signatureBuf, expectedSignature)) {
        const err = new Error('Invalid signature');
        err.code = 'JWT_SIGNATURE';
        throw err;
    }

    if (options.issuer && payload?.iss !== options.issuer) {
        const err = new Error('Invalid issuer');
        err.code = 'JWT_ISSUER';
        throw err;
    }

    if (options.audience && payload?.aud !== options.audience) {
        const err = new Error('Invalid audience');
        err.code = 'JWT_AUDIENCE';
        throw err;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload?.exp !== undefined) {
        const exp = Number(payload.exp);
        if (!Number.isFinite(exp) || nowSec >= exp) {
            const err = new Error('Token expired');
            err.code = 'JWT_EXPIRED';
            throw err;
        }
    }

    if (payload?.nbf !== undefined) {
        const nbf = Number(payload.nbf);
        if (!Number.isFinite(nbf) || nowSec < nbf) {
            const err = new Error('Token not active');
            err.code = 'JWT_NBF';
            throw err;
        }
    }

    if (options.maxAgeSec !== undefined && payload?.iat !== undefined) {
        const iat = Number(payload.iat);
        if (Number.isFinite(iat) && (nowSec - iat) > options.maxAgeSec) {
            const err = new Error('Token too old');
            err.code = 'JWT_TOO_OLD';
            throw err;
        }
    }

    return payload;
}

module.exports = {
    base64UrlEncode,
    timingSafeEqualString,
    signHS256,
    verifyHS256
};


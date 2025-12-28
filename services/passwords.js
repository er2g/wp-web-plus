const crypto = require('crypto');

const HASH_ITERATIONS = 120000;
const HASH_KEYLEN = 64;
const HASH_DIGEST = 'sha512';

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST).toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, hash) {
    const derived = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_DIGEST);
    const stored = Buffer.from(hash, 'hex');
    if (stored.length !== derived.length) {
        return false;
    }
    return crypto.timingSafeEqual(stored, derived);
}

function passwordMeetsPolicy(password, policy) {
    if (typeof password !== 'string') return false;
    if (!policy) return true;
    if (password.length < policy.MIN_LENGTH) return false;
    if (policy.REQUIRE_UPPER && !/[A-Z]/.test(password)) return false;
    if (policy.REQUIRE_LOWER && !/[a-z]/.test(password)) return false;
    if (policy.REQUIRE_NUMBER && !/[0-9]/.test(password)) return false;
    if (policy.REQUIRE_SYMBOL && !/[^A-Za-z0-9]/.test(password)) return false;
    return true;
}

module.exports = {
    hashPassword,
    verifyPassword,
    passwordMeetsPolicy
};

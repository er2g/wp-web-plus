const net = require('net');

function parseIpv4(hostname) {
    const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return null;
    const parts = match.slice(1).map(part => Number(part));
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts;
}

function isPrivateIpv4(parts) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
}

function normalizeHostname(hostname) {
    if (!hostname) return '';
    return String(hostname).trim().toLowerCase();
}

function isPrivateIpv6(hostname) {
    const normalized = normalizeHostname(hostname);
    if (!normalized) return true;
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    if (normalized.startsWith('ff')) return true; // multicast
    return false;
}

function isSafeExternalUrl(rawUrl, options = {}) {
    const maxLength = options.maxLength || 2048;
    const allowedProtocols = options.allowedProtocols || ['http:', 'https:'];

    if (!rawUrl || typeof rawUrl !== 'string') {
        return false;
    }
    if (rawUrl.length > maxLength) {
        return false;
    }

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    if (!allowedProtocols.includes(parsed.protocol)) {
        return false;
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) return false;

    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return false;
    }

    if (
        hostname.endsWith('.internal')
        || hostname.endsWith('.local')
        || hostname.endsWith('.localhost')
    ) {
        return false;
    }

    if (hostname === '169.254.169.254') {
        return false;
    }

    // Block IPv6-mapped IPv4 addresses (::ffff:127.0.0.1)
    if (hostname.includes('::ffff:')) {
        const ipv4Part = hostname.split('::ffff:')[1];
        if (ipv4Part && !isSafeExternalUrl('http://' + ipv4Part, { maxLength, allowedProtocols })) {
            return false;
        }
    }

    const ipv4Parts = parseIpv4(hostname);
    if (ipv4Parts) {
        if (isPrivateIpv4(ipv4Parts)) return false;
        return true;
    }

    const ipVersion = net.isIP(hostname);
    if (ipVersion === 6) {
        return !isPrivateIpv6(hostname);
    }

    return true;
}

module.exports = { isSafeExternalUrl };


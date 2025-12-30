const { z } = require('zod');

function first(value) {
    return Array.isArray(value) ? value[0] : value;
}

function queryString({ defaultValue = '', maxLength, trim = false } = {}) {
    return z.preprocess(
        (value) => {
            const firstValue = first(value);
            if (firstValue === undefined || firstValue === null) return undefined;
            return typeof firstValue === 'string' ? firstValue : String(firstValue);
        },
        z.string().catch(defaultValue)
    ).transform((value) => {
        let out = value;
        if (trim) out = out.trim();
        if (Number.isFinite(maxLength)) out = out.slice(0, maxLength);
        return out;
    });
}

function queryLimit({ defaultValue, max } = {}) {
    return z.preprocess(
        first,
        z.coerce.number().int().positive().catch(defaultValue)
    ).transform((value) => (Number.isFinite(max) ? Math.min(value, max) : value));
}

function queryOffset({ defaultValue = 0 } = {}) {
    return z.preprocess(
        first,
        z.coerce.number().int().min(0).catch(defaultValue)
    );
}

function optionalQueryInt() {
    return z.preprocess(
        (value) => {
            const firstValue = first(value);
            if (firstValue === undefined || firstValue === null || firstValue === '') return undefined;
            return firstValue;
        },
        z.coerce.number().int().optional()
    );
}

module.exports = {
    first,
    queryString,
    queryLimit,
    queryOffset,
    optionalQueryInt
};


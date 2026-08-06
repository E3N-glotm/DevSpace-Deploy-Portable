const SENSITIVE_KEY = /(^|[_-])(password|passwd|pwd|token|secret|authorization|cookie|credential|api[_-]?key|private[_-]?key|client[_-]?secret)([_-]|$)/i;

export function redactText(value) {
    if (typeof value !== "string")
        return value;
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
        .replace(/([?&](?:token|access_token|auth|key|secret|password)=)[^&#\s]+/gi, "$1<redacted>")
        .replace(/((?:password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>")
        .replace(/(--(?:password|passwd|token|secret|api-key)\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1<redacted>");
}

export function redactValue(value, key) {
    if (key && SENSITIVE_KEY.test(key))
        return "<redacted>";
    if (typeof value === "string")
        return redactText(value);
    if (Array.isArray(value))
        return value.map((item) => redactValue(item));
    if (value && typeof value === "object") {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value))
            result[childKey] = redactValue(childValue, childKey);
        return result;
    }
    return value;
}

export function redactedJson(value) {
    return JSON.stringify(redactValue(value));
}

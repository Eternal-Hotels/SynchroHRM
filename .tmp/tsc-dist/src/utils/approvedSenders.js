const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WILDCARD_DOMAIN_PATTERN = /^\*@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
export function normalizeSenderPattern(input) {
    return input.trim().toLowerCase();
}
export function parseApprovedSenderPatterns(input) {
    const rawEntries = Array.isArray(input)
        ? input
        : String(input ?? "")
            .split(/[\n,;]/g)
            .map((entry) => entry.trim());
    const normalized = [];
    const seen = new Set();
    for (const entry of rawEntries) {
        const pattern = normalizeSenderPattern(entry);
        if (!pattern || seen.has(pattern)) {
            continue;
        }
        seen.add(pattern);
        normalized.push(pattern);
    }
    return normalized;
}
export function isValidApprovedSenderPattern(pattern) {
    if (WILDCARD_DOMAIN_PATTERN.test(pattern)) {
        return true;
    }
    return EMAIL_PATTERN.test(pattern);
}
export function validateApprovedSenderPatterns(patterns) {
    const valid = [];
    const invalid = [];
    for (const pattern of parseApprovedSenderPatterns(patterns)) {
        if (isValidApprovedSenderPattern(pattern)) {
            valid.push(pattern);
        }
        else {
            invalid.push(pattern);
        }
    }
    return { valid, invalid };
}
export function isSenderApproved(senderEmail, approvedPatterns) {
    const normalizedSender = normalizeSenderPattern(senderEmail ?? "");
    if (!normalizedSender || !EMAIL_PATTERN.test(normalizedSender)) {
        return false;
    }
    if (approvedPatterns.length === 0) {
        return true;
    }
    return approvedPatterns.some((pattern) => matchesApprovedSenderPattern(normalizedSender, pattern));
}
function matchesApprovedSenderPattern(senderEmail, pattern) {
    if (pattern === senderEmail) {
        return true;
    }
    const wildcardDomain = pattern.match(WILDCARD_DOMAIN_PATTERN);
    if (!wildcardDomain) {
        return false;
    }
    const senderDomain = senderEmail.split("@")[1] ?? "";
    return senderDomain === wildcardDomain[1].toLowerCase();
}

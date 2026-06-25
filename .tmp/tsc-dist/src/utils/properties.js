import { parseLongDate, parseShortDate } from "./dates.js";
export const UNASSIGNED_PROPERTY_NAME = "Unassigned Property";
export const UNASSIGNED_PROPERTY_SLUG = "unassigned-property";
const ATTACHMENT_REPORT_SUFFIXES = [
    "advance-deposit-activity",
    "all-transactions",
    "adjustment-activity",
    "arrivals",
    "authorized-payments",
    "booked-reservations",
    "closed-folios-balance",
    "breakfast-and-packages",
    "departures-list",
    "direct-bill-aging",
    "direct-bill-ledger",
    "final-audit",
    "high-balance-reports",
    "hotel-statistics",
    "house-account-balances",
    "housekeeping-sheet",
    "in-house-guest-folio-balances",
    "maintenance-activity",
    "maintenance-summary",
    "no-show",
    "occupancy",
    "rate-override",
    "rate-report",
    "reservations",
    "room-count-summary",
    "tax-report",
    "trial-balance-report"
];
export function normalizePropertyName(value) {
    if (!value) {
        return null;
    }
    const trimmed = value.replace(/\s+/g, " ").trim();
    return trimmed || null;
}
export function normalizeDetectedPropertyName(value, nextLine = null) {
    let candidate = normalizePropertyName(value);
    if (!candidate) {
        return null;
    }
    const following = normalizePropertyName(nextLine);
    const spilledState = following?.match(/^([A-Z]{2})\s+Report run date:/i)?.[1] ?? null;
    if (spilledState && /,\s*(?:Date|Date Range|Current Business Day):/i.test(candidate)) {
        candidate = candidate.replace(/,\s*(Date|Date Range|Current Business Day):/i, `, ${spilledState} $1:`);
    }
    candidate = candidate
        .replace(/\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s+\d{2}:\d{2}\s+.+$/i, "")
        .replace(/\s+(?:Date Range|Date|Current Business Day):.*$/i, "")
        .replace(/\s+Report run date:.*$/i, "")
        .replace(/\s+Report run time:.*$/i, "")
        .replace(/\s+User:.*$/i, "")
        .replace(/[,\-\s]+$/g, "");
    return normalizePropertyName(candidate);
}
export function slugifyPropertyName(value) {
    const normalized = normalizePropertyName(value);
    if (!normalized) {
        return null;
    }
    const slug = normalized
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || null;
}
export function ensurePropertyRef(property) {
    const propertyName = normalizePropertyName(property?.propertyName) ?? UNASSIGNED_PROPERTY_NAME;
    const propertySlug = slugifyPropertyName(property?.propertySlug ?? propertyName) ?? UNASSIGNED_PROPERTY_SLUG;
    return { propertyName, propertySlug };
}
export function derivePropertyRefFromAttachmentName(attachmentName) {
    if (!attachmentName) {
        return null;
    }
    const fileStem = attachmentName
        .replace(/\.[^.]+$/, "")
        .replace(/_/g, " ")
        .trim();
    if (!fileStem) {
        return null;
    }
    const afterCode = fileStem.match(/^.+?-[A-Z0-9]{4,8}-(.+)$/)?.[1] ?? fileStem;
    const withoutSuffix = afterCode.replace(new RegExp(`-(?:${ATTACHMENT_REPORT_SUFFIXES.join("|")})$`, "i"), "");
    const spaced = withoutSuffix.replace(/([a-z])([A-Z])/g, "$1 $2");
    const propertyName = normalizePropertyName(spaced);
    const propertySlug = slugifyPropertyName(propertyName);
    if (!propertyName || !propertySlug || looksLikeStandaloneDateLabel(propertyName)) {
        return null;
    }
    return { propertyName, propertySlug };
}
function looksLikeStandaloneDateLabel(value) {
    const normalized = normalizePropertyName(value);
    if (!normalized) {
        return false;
    }
    if (parseShortDate(normalized) || parseLongDate(normalized)) {
        return true;
    }
    return /^\d{1,2}[-/._\s]\d{1,2}[-/._\s]\d{2,4}$/.test(normalized);
}

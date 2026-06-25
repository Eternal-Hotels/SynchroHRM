import path from "node:path";
import { ensureIsoDate } from "./dates.js";
import { sanitizeFileName } from "./files.js";
import { UNASSIGNED_PROPERTY_SLUG } from "./properties.js";
export function buildParsedCsvDownloadName(options) {
    const propertySlug = sanitizeSegment(options.propertySlug) ?? UNASSIGNED_PROPERTY_SLUG;
    const day = resolveDayLabel(options.reportDate, options.receivedAt);
    const reportLabel = sanitizeAttachmentStem(options.attachmentName)
        ?? sanitizeSegment(options.reportType?.replace(/_/g, "-"))
        ?? "report";
    return `${propertySlug}_${day}_${reportLabel}.csv`;
}
export function buildLatestExportDownloadName(options) {
    const propertySlug = sanitizeSegment(options.propertySlug) ?? UNASSIGNED_PROPERTY_SLUG;
    const reportType = sanitizeSegment(options.reportType?.replace(/_/g, "-")) ?? "report";
    const stamp = resolveTimestampLabel(options.createdAt);
    return `${propertySlug}_${reportType}_${stamp}.csv`;
}
export function buildNetSuiteMetadataCatalogDownloadName(options) {
    const stamp = resolveTimestampLabel(options.createdAt);
    return `netsuite_metadata_catalog_${stamp}.csv`;
}
function resolveDayLabel(...values) {
    for (const value of values) {
        const day = resolveIsoDay(value);
        if (day) {
            return day;
        }
    }
    return "undated";
}
function resolveTimestampLabel(value) {
    const day = resolveIsoDay(value);
    if (!day) {
        return "undated";
    }
    const time = resolveClockLabel(value);
    return time ? `${day}_${time}` : day;
}
function resolveIsoDay(value) {
    if (!value) {
        return null;
    }
    const trimmed = value.trim();
    const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) {
        return isoMatch[1];
    }
    return ensureIsoDate(trimmed);
}
function resolveClockLabel(value) {
    if (!value) {
        return null;
    }
    const trimmed = value.trim();
    const match = trimmed.match(/^\d{4}-\d{2}-\d{2}[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) {
        return null;
    }
    const [, hours, minutes, seconds = "00"] = match;
    return `${hours}-${minutes}-${seconds}`;
}
function sanitizeAttachmentStem(value) {
    if (!value) {
        return null;
    }
    return sanitizeSegment(path.parse(value.trim()).name);
}
function sanitizeSegment(value) {
    if (!value) {
        return null;
    }
    const sanitized = sanitizeFileName(value.trim())
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized || null;
}

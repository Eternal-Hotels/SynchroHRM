import { createHash } from "node:crypto";

const DEFAULT_MAX_LENGTH = 60;

export interface StatisticalAccountNumberOptions {
  propertySlug: string;
  reportType: string;
  mappingKey: string;
  takenNumbers?: Iterable<string>;
  maxLength?: number;
}

export function generateDeterministicStatisticalAccountNumber(
  options: StatisticalAccountNumberOptions
): string {
  const maxLength = normalizeMaxLength(options.maxLength);
  const takenNumbers = new Set(
    Array.from(options.takenNumbers ?? []).map((value) => normalizeAccountNumber(value)).filter(Boolean)
  );
  const base = buildBaseAccountNumber(options, maxLength);

  if (!takenNumbers.has(base)) {
    return base;
  }

  for (let collisionIndex = 1; collisionIndex < 1000; collisionIndex += 1) {
    const suffix = stableHash(
      `${options.propertySlug}|${options.reportType}|${options.mappingKey}|${collisionIndex}`,
      4
    );
    const candidate = trimForSuffix(base, suffix, maxLength);
    if (!takenNumbers.has(candidate)) {
      return candidate;
    }
  }

  return trimForSuffix(base, stableHash(`${options.propertySlug}|${options.reportType}|${options.mappingKey}|fallback`, 6), maxLength);
}

function buildBaseAccountNumber(options: StatisticalAccountNumberOptions, maxLength: number): string {
  const propertyToken = abbreviateToken(options.propertySlug, 10);
  const reportToken = abbreviateToken(options.reportType, 10);
  const hash = stableHash(`${options.propertySlug}|${options.reportType}|${options.mappingKey}`, 8);
  return normalizeAccountNumber(
    `${propertyToken}-${reportToken}-${hash}`.slice(0, maxLength)
  );
}

function abbreviateToken(value: string, maxLength: number): string {
  const normalized = normalizeAccountNumber(String(value || "stat")).replace(/-/g, "");
  return normalized.slice(0, Math.max(1, maxLength)) || "STAT";
}

function stableHash(value: string, length: number): string {
  return createHash("sha1")
    .update(value)
    .digest("hex")
    .slice(0, Math.max(1, length))
    .toUpperCase();
}

function trimForSuffix(base: string, suffix: string, maxLength: number): string {
  const safeSuffix = normalizeAccountNumber(suffix);
  const head = normalizeAccountNumber(base).slice(0, Math.max(1, maxLength - safeSuffix.length - 1));
  return normalizeAccountNumber(`${head}-${safeSuffix}`);
}

function normalizeAccountNumber(value: string): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeMaxLength(value: number | undefined): number {
  if (!Number.isInteger(value) || Number(value) <= 8) {
    return DEFAULT_MAX_LENGTH;
  }

  return Number(value);
}

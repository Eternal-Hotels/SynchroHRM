export const UNASSIGNED_PROPERTY_NAME = "Unassigned Property";
export const UNASSIGNED_PROPERTY_SLUG = "unassigned-property";

export interface PropertyRef {
  propertyName: string | null;
  propertySlug: string | null;
}

export function normalizePropertyName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || null;
}

export function normalizeDetectedPropertyName(
  value: string | null | undefined,
  nextLine: string | null | undefined = null
): string | null {
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

export function slugifyPropertyName(value: string | null | undefined): string | null {
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

export function ensurePropertyRef(property: PropertyRef | null | undefined): { propertyName: string; propertySlug: string } {
  const propertyName = normalizePropertyName(property?.propertyName) ?? UNASSIGNED_PROPERTY_NAME;
  const propertySlug = slugifyPropertyName(property?.propertySlug ?? propertyName) ?? UNASSIGNED_PROPERTY_SLUG;
  return { propertyName, propertySlug };
}

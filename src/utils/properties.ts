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

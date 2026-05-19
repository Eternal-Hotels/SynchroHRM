export function parseShortDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, mm, dd, yy] = match;
  const iso = `20${yy}-${mm}-${dd}`;
  const parsed = new Date(`${iso}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return iso;
}

export function formatRunStamp(value = new Date()): string {
  return value.toISOString().replace(/[:.]/g, "-");
}

export function ensureIsoDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  return parseShortDate(value);
}

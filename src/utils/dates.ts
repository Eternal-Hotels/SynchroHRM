export function parseShortDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const numericMatch = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (numericMatch) {
    const [, rawMonth, rawDay, rawYear] = numericMatch;
    const mm = rawMonth.padStart(2, "0");
    const dd = rawDay.padStart(2, "0");
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const iso = `${year}-${mm}-${dd}`;
    const parsed = new Date(`${iso}T00:00:00Z`);

    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return iso;
  }

  const namedMatch = value.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{2})$/);
  if (!namedMatch) {
    return null;
  }

  const [, dd, monthName, yy] = namedMatch;
  const monthIndex = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec"
  ].indexOf(monthName.toLowerCase());
  if (monthIndex < 0) {
    return null;
  }

  const iso = `20${yy}-${String(monthIndex + 1).padStart(2, "0")}-${dd}`;
  const parsed = new Date(`${iso}T00:00:00Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return iso;
}

export function parseLongDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/i);
  if (!match) {
    return null;
  }

  const [, monthName, dayValue, yearValue] = match;
  const parsed = new Date(`${monthName} ${dayValue}, ${yearValue} UTC`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const year = String(parsed.getUTCFullYear());
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

  return parseShortDate(value) ?? parseLongDate(value);
}

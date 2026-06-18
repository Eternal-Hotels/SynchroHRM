const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WILDCARD_DOMAIN_PATTERN = /^\*@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

export function normalizeSenderPattern(input: string): string {
  return input.trim().toLowerCase();
}

export function parseApprovedSenderPatterns(input: string | string[] | null | undefined): string[] {
  const rawEntries = Array.isArray(input)
    ? input
    : String(input ?? "")
      .split(/[\n,;]/g)
      .map((entry) => entry.trim());

  const normalized: string[] = [];
  const seen = new Set<string>();

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

export function isValidApprovedSenderPattern(pattern: string): boolean {
  if (WILDCARD_DOMAIN_PATTERN.test(pattern)) {
    return true;
  }

  return EMAIL_PATTERN.test(pattern);
}

export function validateApprovedSenderPatterns(patterns: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const pattern of parseApprovedSenderPatterns(patterns)) {
    if (isValidApprovedSenderPattern(pattern)) {
      valid.push(pattern);
    } else {
      invalid.push(pattern);
    }
  }

  return { valid, invalid };
}

export function isSenderApproved(senderEmail: string | null | undefined, approvedPatterns: string[]): boolean {
  const normalizedSender = normalizeSenderPattern(senderEmail ?? "");
  if (!normalizedSender || !EMAIL_PATTERN.test(normalizedSender)) {
    return false;
  }

  if (approvedPatterns.length === 0) {
    return true;
  }

  return approvedPatterns.some((pattern) => matchesApprovedSenderPattern(normalizedSender, pattern));
}

function matchesApprovedSenderPattern(senderEmail: string, pattern: string): boolean {
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

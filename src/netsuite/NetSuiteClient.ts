import { constants, createPrivateKey, randomUUID, sign as signBuffer } from "node:crypto";
import type {
  NetSuiteConnectionSettings,
  NetSuiteJournalEntryResult,
  NetSuiteJwtAlgorithm
} from "./types.js";

const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const REST_SCOPE = "rest_webservices";

export interface NetSuiteProbeSuccess {
  httpStatus: number;
  count: number;
  totalResults: number;
  columnNames: string[];
}

export interface NetSuiteMetadataCatalogRow {
  recordType: string;
  canonicalHref: string | null;
  openApiHref: string | null;
  jsonSchemaHref: string | null;
  describesHref: string | null;
  capturedAt: string;
}

export interface NetSuiteRecordSchemaSnapshot {
  recordType: string;
  schema: Record<string, unknown>;
}

export interface NetSuiteMetadataCatalogSuccess {
  httpStatus: number;
  rows: NetSuiteMetadataCatalogRow[];
  schemas: NetSuiteRecordSchemaSnapshot[];
}

export class NetSuiteRequestError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly errorCode: string | null,
    public readonly detail: string
  ) {
    super(message);
    this.name = "NetSuiteRequestError";
  }
}

export interface JwtAssertionOptions {
  clientId: string;
  certificateId: string;
  privateKeyPem: string;
  algorithm: NetSuiteJwtAlgorithm;
  audience: string;
  now?: number;
  expiresInSeconds?: number;
}

export function buildClientAssertion(options: JwtAssertionOptions): string {
  createPrivateKey(options.privateKeyPem);

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? 300;
  const header = {
    typ: "JWT",
    alg: options.algorithm,
    kid: options.certificateId
  };
  const payload = {
    iss: options.clientId,
    scope: REST_SCOPE,
    aud: options.audience,
    iat: now,
    exp: now + expiresInSeconds,
    jti: randomUUID()
  };

  const signingInput = `${toBase64UrlJson(header)}.${toBase64UrlJson(payload)}`;
  const signature = signJwt(signingInput, options.privateKeyPem, options.algorithm);
  return `${signingInput}.${signature}`;
}

export class NetSuiteClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async runSuiteQlProbe(
    settings: NetSuiteConnectionSettings,
    privateKeyPem: string
  ): Promise<NetSuiteProbeSuccess> {
    const accessToken = await this.requestAccessToken(settings, privateKeyPem);
    const queryUrl = `${settings.serviceBaseUrl}/services/rest/query/v1/suiteql?limit=1&offset=0`;
    const response = await this.fetchImpl(queryUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: "transient"
      },
      body: JSON.stringify({
        q: settings.probeQuery
      })
    });

    if (!response.ok) {
      throw await createQueryError(response);
    }

    const payload = await response.json() as {
      count?: unknown;
      totalResults?: unknown;
      items?: Array<Record<string, unknown>>;
    };
    const items = Array.isArray(payload.items) ? payload.items : [];
    const firstItem = items[0] ?? {};

    return {
      httpStatus: response.status,
      count: asNumber(payload.count),
      totalResults: asNumber(payload.totalResults),
      columnNames: Object.keys(firstItem)
    };
  }

  async fetchMetadataCatalog(
    settings: NetSuiteConnectionSettings,
    privateKeyPem: string,
    capturedAt = new Date().toISOString()
  ): Promise<NetSuiteMetadataCatalogSuccess> {
    const accessToken = await this.requestAccessToken(settings, privateKeyPem);
    const catalogUrl = `${settings.serviceBaseUrl}/services/rest/record/v1/metadata-catalog`;
    const response = await this.fetchImpl(catalogUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw await createMetadataCatalogError(response, "NetSuite metadata catalog request failed", "metadata_catalog_request_failed");
    }

    const payload = await response.json() as { items?: unknown };
    const rows = normalizeMetadataCatalogRows(payload.items, capturedAt);
    const schemas: NetSuiteRecordSchemaSnapshot[] = [];

    for (const row of rows) {
      const schemaUrl = row.jsonSchemaHref ?? row.canonicalHref ?? `${catalogUrl}/${encodeURIComponent(row.recordType)}`;
      const schemaResponse = await this.fetchImpl(schemaUrl, {
        method: "GET",
        headers: {
          accept: "application/schema+json",
          authorization: `Bearer ${accessToken}`
        }
      });

      if (!schemaResponse.ok) {
        throw await createMetadataCatalogError(
          schemaResponse,
          `NetSuite schema metadata request failed for ${row.recordType}`,
          "metadata_schema_request_failed"
        );
      }

      const schema = await schemaResponse.json() as unknown;
      schemas.push({
        recordType: row.recordType,
        schema: isRecord(schema) ? schema : { value: schema ?? null }
      });
    }

    return {
      httpStatus: response.status,
      rows,
      schemas
    };
  }

  async resolveGlAccountIds(
    settings: NetSuiteConnectionSettings,
    privateKeyPem: string,
    accountNumbers: string[]
  ): Promise<Record<string, string>> {
    const normalizedAccountNumbers = Array.from(new Set(
      accountNumbers
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    ));

    if (normalizedAccountNumbers.length === 0) {
      return {};
    }

    const accessToken = await this.requestAccessToken(settings, privateKeyPem);
    const query = `SELECT id, acctnumber FROM Account WHERE acctnumber IN (${normalizedAccountNumbers.map((value) => `'${escapeSuiteQlLiteral(value)}'`).join(", ")})`;
    const payload = await this.runSuiteQl(accessToken, settings, query, normalizedAccountNumbers.length + 1) as {
      items?: Array<Record<string, unknown>>;
    };
    const items = Array.isArray(payload.items) ? payload.items : [];
    const byAccountNumber: Record<string, string> = {};

    for (const item of items) {
      const accountNumber = readString(item?.acctnumber);
      const internalId = readString(item?.id);
      if (accountNumber && internalId) {
        byAccountNumber[accountNumber] = internalId;
      }
    }

    return byAccountNumber;
  }

  async createJournalEntry(
    settings: NetSuiteConnectionSettings,
    privateKeyPem: string,
    journalRecord: Record<string, unknown>
  ): Promise<NetSuiteJournalEntryResult> {
    const accessToken = await this.requestAccessToken(settings, privateKeyPem);
    const recordUrl = `${settings.serviceBaseUrl}/services/rest/record/v1/journalEntry`;
    const response = await this.fetchImpl(recordUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: "return=representation"
      },
      body: JSON.stringify(journalRecord)
    });

    if (!response.ok) {
      throw await createMetadataCatalogError(response, "NetSuite journal entry create failed", "journal_entry_create_failed");
    }

    const payload = await safeParseJson(response);
    const locationHeader = response.headers.get("location") || response.headers.get("Location") || "";
    const internalId = readString(payload?.id)
      ?? extractRecordIdFromLocation(locationHeader)
      ?? "";
    const tranId = readString(payload?.tranId)
      ?? readString(payload?.transactionNumber)
      ?? readString(payload?.name)
      ?? "";

    return {
      httpStatus: response.status,
      journalEntry: {
        id: internalId,
        tranId,
        location: locationHeader
      },
      raw: payload
    };
  }

  private async requestAccessToken(
    settings: NetSuiteConnectionSettings,
    privateKeyPem: string
  ): Promise<string> {
    const tokenUrl = `${settings.serviceBaseUrl}/services/rest/auth/oauth2/v1/token`;
    const assertion = buildClientAssertion({
      clientId: settings.clientId,
      certificateId: settings.certificateId,
      privateKeyPem,
      algorithm: settings.jwtAlgorithm,
      audience: tokenUrl
    });

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
      scope: REST_SCOPE
    });

    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      throw await createTokenError(response);
    }

    const payload = await response.json() as { access_token?: string };
    if (!payload.access_token) {
      throw new NetSuiteRequestError(
        "NetSuite token response did not include an access token.",
        response.status,
        "missing_access_token",
        "The token response did not include access_token."
      );
    }

    return payload.access_token;
  }

  private async runSuiteQl(
    accessToken: string,
    settings: NetSuiteConnectionSettings,
    query: string,
    limit = 50
  ): Promise<unknown> {
    const queryUrl = `${settings.serviceBaseUrl}/services/rest/query/v1/suiteql?limit=${Math.max(1, Number(limit || 1))}&offset=0`;
    const response = await this.fetchImpl(queryUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: "transient"
      },
      body: JSON.stringify({ q: query })
    });

    if (!response.ok) {
      throw await createQueryError(response);
    }

    return response.json();
  }
}

function signJwt(signingInput: string, privateKeyPem: string, algorithm: NetSuiteJwtAlgorithm): string {
  const data = Buffer.from(signingInput, "utf8");
  const signature = signBuffer(resolveHashAlgorithm(algorithm), data, buildSignOptions(privateKeyPem, algorithm));
  return toBase64Url(signature);
}

function buildSignOptions(privateKeyPem: string, algorithm: NetSuiteJwtAlgorithm) {
  if (algorithm.startsWith("PS")) {
    return {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: getPssSaltLength(algorithm)
    };
  }

  return {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363" as const
  };
}

function getPssSaltLength(algorithm: NetSuiteJwtAlgorithm): number {
  switch (algorithm) {
    case "PS256":
      return 32;
    case "PS384":
      return 48;
    case "PS512":
      return 64;
    default:
      return 32;
  }
}

function resolveHashAlgorithm(algorithm: NetSuiteJwtAlgorithm): "sha256" | "sha384" | "sha512" {
  switch (algorithm) {
    case "PS256":
    case "ES256":
      return "sha256";
    case "PS384":
    case "ES384":
      return "sha384";
    case "PS512":
    case "ES512":
      return "sha512";
  }
}

async function createTokenError(response: Response): Promise<NetSuiteRequestError> {
  const payload = await safeParseJson(response);
  const errorCode = readString(payload?.error) ?? "token_request_failed";
  const detail = readString(payload?.error_description) ?? await safeReadText(response) ?? `Token request failed with HTTP ${response.status}.`;
  return new NetSuiteRequestError(
    `NetSuite token request failed: ${detail}`,
    response.status,
    errorCode,
    detail
  );
}

async function createQueryError(response: Response): Promise<NetSuiteRequestError> {
  const payload = await safeParseJson(response);
  const errorDetails = Array.isArray(payload?.["o:errorDetails"])
    ? payload["o:errorDetails"] as Array<Record<string, unknown>>
    : [];
  const firstDetail = errorDetails[0] ?? null;
  const errorCode = readString(firstDetail?.["o:errorCode"])
    ?? readString(payload?.type)
    ?? "query_request_failed";
  const detail = readString(firstDetail?.detail)
    ?? readString(payload?.title)
    ?? await safeReadText(response)
    ?? `SuiteQL probe failed with HTTP ${response.status}.`;
  return new NetSuiteRequestError(
    `NetSuite SuiteQL probe failed: ${detail}`,
    response.status,
    errorCode,
    detail
  );
}

async function createMetadataCatalogError(
  response: Response,
  messagePrefix: string,
  fallbackCode: string
): Promise<NetSuiteRequestError> {
  const payload = await safeParseJson(response);
  const errorDetails = Array.isArray(payload?.["o:errorDetails"])
    ? payload["o:errorDetails"] as Array<Record<string, unknown>>
    : [];
  const firstDetail = errorDetails[0] ?? null;
  const errorCode = readString(firstDetail?.["o:errorCode"])
    ?? readString(payload?.type)
    ?? readString(payload?.error)
    ?? fallbackCode;
  const detail = readString(firstDetail?.detail)
    ?? readString(payload?.title)
    ?? readString(payload?.error_description)
    ?? await safeReadText(response)
    ?? `${messagePrefix} with HTTP ${response.status}.`;

  return new NetSuiteRequestError(
    `${messagePrefix}: ${detail}`,
    response.status,
    errorCode,
    detail
  );
}

async function safeParseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return await response.clone().json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.clone().text();
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeMetadataCatalogRows(items: unknown, capturedAt: string): NetSuiteMetadataCatalogRow[] {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => normalizeMetadataCatalogRow(item, capturedAt))
    .filter((row): row is NetSuiteMetadataCatalogRow => row !== null)
    .sort((left, right) => left.recordType.localeCompare(right.recordType));
}

function normalizeMetadataCatalogRow(item: unknown, capturedAt: string): NetSuiteMetadataCatalogRow | null {
  if (!isRecord(item)) {
    return null;
  }

  const links = Array.isArray(item.links)
    ? item.links.filter(isRecord)
    : [];
  const canonicalHref = readCatalogHref(links, "canonical");
  const recordType = readString(item.name)
    ?? getLastPathSegment(canonicalHref)
    ?? getLastPathSegment(readCatalogHref(links, "describes"))
    ?? null;

  if (!recordType) {
    return null;
  }

  return {
    recordType,
    canonicalHref,
    openApiHref: readCatalogHref(links, "alternate", "application/swagger+json"),
    jsonSchemaHref: readCatalogHref(links, "alternate", "application/schema+json"),
    describesHref: readCatalogHref(links, "describes"),
    capturedAt
  };
}

function readCatalogHref(
  links: Array<Record<string, unknown>>,
  rel: string,
  mediaType?: string
): string | null {
  for (const link of links) {
    if (readString(link.rel) !== rel) {
      continue;
    }
    if (mediaType && readString(link.mediaType) !== mediaType) {
      continue;
    }

    const href = readString(link.href);
    if (href) {
      return href;
    }
  }

  return null;
}

function getLastPathSegment(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const pathname = new URL(value).pathname.replace(/\/+$/g, "");
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
  } catch {
    const normalized = value.replace(/\/+$/g, "");
    const segments = normalized.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
  }
}

function extractRecordIdFromLocation(value: string | null): string | null {
  const normalized = readString(value);
  if (!normalized) {
    return null;
  }

  try {
    const pathname = new URL(normalized).pathname.replace(/\/+$/g, "");
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
  } catch {
    const segments = normalized.replace(/\/+$/g, "").split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeSuiteQlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function toBase64UrlJson(value: Record<string, unknown>): string {
  return toBase64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function toBase64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

import { constants, createPrivateKey, randomUUID, sign as signBuffer } from "node:crypto";
const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const REST_SCOPE = "rest_webservices";
export class NetSuiteRequestError extends Error {
    httpStatus;
    errorCode;
    detail;
    constructor(message, httpStatus, errorCode, detail) {
        super(message);
        this.httpStatus = httpStatus;
        this.errorCode = errorCode;
        this.detail = detail;
        this.name = "NetSuiteRequestError";
    }
}
export function buildClientAssertion(options) {
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
    fetchImpl;
    constructor(fetchImpl = fetch) {
        this.fetchImpl = fetchImpl;
    }
    async runSuiteQlProbe(settings, privateKeyPem) {
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
        const payload = await response.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        const firstItem = items[0] ?? {};
        return {
            httpStatus: response.status,
            count: asNumber(payload.count),
            totalResults: asNumber(payload.totalResults),
            columnNames: Object.keys(firstItem)
        };
    }
    async fetchMetadataCatalog(settings, privateKeyPem, capturedAt = new Date().toISOString()) {
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
        const payload = await response.json();
        const rows = normalizeMetadataCatalogRows(payload.items, capturedAt);
        const schemas = [];
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
                throw await createMetadataCatalogError(schemaResponse, `NetSuite schema metadata request failed for ${row.recordType}`, "metadata_schema_request_failed");
            }
            const schema = await schemaResponse.json();
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
    async resolveGlAccountIds(settings, privateKeyPem, accountNumbers) {
        const normalizedAccountNumbers = Array.from(new Set(accountNumbers
            .map((value) => String(value || "").trim())
            .filter(Boolean)));
        if (normalizedAccountNumbers.length === 0) {
            return {};
        }
        const accessToken = await this.requestAccessToken(settings, privateKeyPem);
        const query = `SELECT id, acctnumber FROM Account WHERE acctnumber IN (${normalizedAccountNumbers.map((value) => `'${escapeSuiteQlLiteral(value)}'`).join(", ")})`;
        const payload = await this.runSuiteQl(accessToken, settings, query, normalizedAccountNumbers.length + 1);
        const items = Array.isArray(payload.items) ? payload.items : [];
        const byAccountNumber = {};
        for (const item of items) {
            const accountNumber = readString(item?.acctnumber);
            const internalId = readString(item?.id);
            if (accountNumber && internalId) {
                byAccountNumber[accountNumber] = internalId;
            }
        }
        return byAccountNumber;
    }
    async createJournalEntry(settings, privateKeyPem, journalRecord) {
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
    async requestAccessToken(settings, privateKeyPem) {
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
        const payload = await response.json();
        if (!payload.access_token) {
            throw new NetSuiteRequestError("NetSuite token response did not include an access token.", response.status, "missing_access_token", "The token response did not include access_token.");
        }
        return payload.access_token;
    }
    async runSuiteQl(accessToken, settings, query, limit = 50) {
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
function signJwt(signingInput, privateKeyPem, algorithm) {
    const data = Buffer.from(signingInput, "utf8");
    const signature = signBuffer(resolveHashAlgorithm(algorithm), data, buildSignOptions(privateKeyPem, algorithm));
    return toBase64Url(signature);
}
function buildSignOptions(privateKeyPem, algorithm) {
    if (algorithm.startsWith("PS")) {
        return {
            key: privateKeyPem,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: getPssSaltLength(algorithm)
        };
    }
    return {
        key: privateKeyPem,
        dsaEncoding: "ieee-p1363"
    };
}
function getPssSaltLength(algorithm) {
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
function resolveHashAlgorithm(algorithm) {
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
async function createTokenError(response) {
    const payload = await safeParseJson(response);
    const errorCode = readString(payload?.error) ?? "token_request_failed";
    const detail = readString(payload?.error_description) ?? await safeReadText(response) ?? `Token request failed with HTTP ${response.status}.`;
    return new NetSuiteRequestError(`NetSuite token request failed: ${detail}`, response.status, errorCode, detail);
}
async function createQueryError(response) {
    const payload = await safeParseJson(response);
    const errorDetails = Array.isArray(payload?.["o:errorDetails"])
        ? payload["o:errorDetails"]
        : [];
    const firstDetail = errorDetails[0] ?? null;
    const errorCode = readString(firstDetail?.["o:errorCode"])
        ?? readString(payload?.type)
        ?? "query_request_failed";
    const detail = readString(firstDetail?.detail)
        ?? readString(payload?.title)
        ?? await safeReadText(response)
        ?? `SuiteQL probe failed with HTTP ${response.status}.`;
    return new NetSuiteRequestError(`NetSuite SuiteQL probe failed: ${detail}`, response.status, errorCode, detail);
}
async function createMetadataCatalogError(response, messagePrefix, fallbackCode) {
    const payload = await safeParseJson(response);
    const errorDetails = Array.isArray(payload?.["o:errorDetails"])
        ? payload["o:errorDetails"]
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
    return new NetSuiteRequestError(`${messagePrefix}: ${detail}`, response.status, errorCode, detail);
}
async function safeParseJson(response) {
    try {
        return await response.clone().json();
    }
    catch {
        return null;
    }
}
async function safeReadText(response) {
    try {
        return await response.clone().text();
    }
    catch {
        return null;
    }
}
function readString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function normalizeMetadataCatalogRows(items, capturedAt) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items
        .map((item) => normalizeMetadataCatalogRow(item, capturedAt))
        .filter((row) => row !== null)
        .sort((left, right) => left.recordType.localeCompare(right.recordType));
}
function normalizeMetadataCatalogRow(item, capturedAt) {
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
function readCatalogHref(links, rel, mediaType) {
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
function getLastPathSegment(value) {
    if (!value) {
        return null;
    }
    try {
        const pathname = new URL(value).pathname.replace(/\/+$/g, "");
        const segments = pathname.split("/").filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
    }
    catch {
        const normalized = value.replace(/\/+$/g, "");
        const segments = normalized.split("/").filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
    }
}
function extractRecordIdFromLocation(value) {
    const normalized = readString(value);
    if (!normalized) {
        return null;
    }
    try {
        const pathname = new URL(normalized).pathname.replace(/\/+$/g, "");
        const segments = pathname.split("/").filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
    }
    catch {
        const segments = normalized.replace(/\/+$/g, "").split("/").filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] ?? null : null;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function escapeSuiteQlLiteral(value) {
    return value.replace(/'/g, "''");
}
function toBase64UrlJson(value) {
    return toBase64Url(Buffer.from(JSON.stringify(value), "utf8"));
}
function toBase64Url(bytes) {
    return bytes
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

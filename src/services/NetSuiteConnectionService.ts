import { createPrivateKey } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AppDatabase } from "../db/Database.js";
import { NetSuiteClient, NetSuiteRequestError } from "../netsuite/NetSuiteClient.js";
import {
  NETSUITE_JWT_ALGORITHMS,
  type NetSuiteCatalogExportResult,
  type NetSuiteConnectionSettings,
  type NetSuiteConnectionTestResult,
  type NetSuiteConnectionUpdateInput,
  type NetSuiteConnectionView,
  type NetSuiteJwtAlgorithm
} from "../netsuite/types.js";
import { formatRunStamp } from "../utils/dates.js";
import { buildNetSuiteMetadataCatalogDownloadName } from "../utils/downloads.js";
import { ensureDir, sanitizeFileName, writeTextFile } from "../utils/files.js";
import { toCsv } from "../utils/csv.js";
import { decryptSecret, encryptSecret, getSecretMasterKeyStatus, SecretConfigurationError } from "../utils/secrets.js";

const DEFAULT_PROBE_QUERY = "SELECT id FROM Account";
const DEFAULT_JWT_ALGORITHM: NetSuiteJwtAlgorithm = "PS256";
const METADATA_CATALOG_EXPORT_COLUMNS = [
  "record_type",
  "canonical_href",
  "openapi_href",
  "json_schema_href",
  "describes_href",
  "captured_at"
] as const;

export class NetSuiteSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetSuiteSettingsError";
  }
}

export class NetSuiteConnectionService {
  private readonly client: NetSuiteClient;
  private readonly metadataCatalogDir: string;

  constructor(
    private readonly database: AppDatabase,
    private readonly secretMasterKey: string | null | undefined,
    dataDir = "./storage",
    fetchImpl: typeof fetch = fetch
  ) {
    this.client = new NetSuiteClient(fetchImpl);
    this.metadataCatalogDir = path.join(dataDir, "netsuite", "debug", "metadata-catalog");
  }

  getSettings(): NetSuiteConnectionView {
    const status = getSecretMasterKeyStatus(this.secretMasterKey);
    const settings = this.getStoredSettings();

    return {
      ...settings,
      hasPrivateKey: this.database.getNetSuiteEncryptedPrivateKey() !== null,
      maskedClientId: maskIdentifier(settings.clientId),
      maskedCertificateId: maskIdentifier(settings.certificateId),
      lastTest: normalizeStoredLastTest(this.database.getNetSuiteLastTest()),
      lastCatalogExport: normalizeStoredLastCatalogExport(this.database.getNetSuiteLastCatalogExport()),
      masterKeyConfigured: status.configured,
      availabilityError: status.error
    };
  }

  updateSettings(input: NetSuiteConnectionUpdateInput): NetSuiteConnectionView {
    const masterKey = this.requireMasterKey();
    const normalized = normalizeUpdateInput(input);
    const existing = this.getStoredSettings();
    const nextSettings: NetSuiteConnectionSettings = {
      serviceBaseUrl: normalized.serviceBaseUrl,
      clientId: normalized.clientId,
      certificateId: normalized.certificateId,
      jwtAlgorithm: normalized.jwtAlgorithm,
      probeQuery: normalized.probeQuery
    };

    this.database.setNetSuiteConnectionSettings(nextSettings);

    if (normalized.clearPrivateKey) {
      this.database.setNetSuiteEncryptedPrivateKey(null);
    } else if (normalized.privateKeyPem) {
      validatePrivateKeyPem(normalized.privateKeyPem);
      this.database.setNetSuiteEncryptedPrivateKey(encryptSecret(normalized.privateKeyPem, masterKey));
    }

    if (
      normalized.clearPrivateKey
      || Boolean(normalized.privateKeyPem)
      || JSON.stringify(existing) !== JSON.stringify(nextSettings)
    ) {
      this.database.setNetSuiteLastTest(null);
      this.database.setNetSuiteLastCatalogExport(null);
    }

    return this.getSettings();
  }

  async testConnection(): Promise<NetSuiteConnectionTestResult> {
    const masterKey = this.requireMasterKey();
    const settings = this.getStoredSettings();
    assertConfiguredSettings(settings);

    const encryptedPrivateKey = this.database.getNetSuiteEncryptedPrivateKey();
    if (!encryptedPrivateKey) {
      throw new NetSuiteSettingsError("A NetSuite private key must be saved before the connection can be tested.");
    }

    let privateKeyPem: string;
    try {
      privateKeyPem = decryptSecret(encryptedPrivateKey, masterKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new NetSuiteSettingsError(`The saved NetSuite private key could not be decrypted: ${message}`);
    }

    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();

    try {
      const result = await this.client.runSuiteQlProbe(settings, privateKeyPem);
      const summary: NetSuiteConnectionTestResult = {
        status: "success",
        checkedAt,
        durationMs: Date.now() - startedAt,
        httpStatus: result.httpStatus,
        count: result.count,
        totalResults: result.totalResults,
        columnNames: result.columnNames,
        errorCode: null,
        errorMessage: null
      };
      this.database.setNetSuiteLastTest(summary);
      return summary;
    } catch (error) {
      const normalized = normalizeConnectionError(error);
      const summary: NetSuiteConnectionTestResult = {
        status: "error",
        checkedAt,
        durationMs: Date.now() - startedAt,
        httpStatus: normalized.httpStatus,
        count: null,
        totalResults: null,
        columnNames: [],
        errorCode: normalized.errorCode,
        errorMessage: normalized.detail
      };
      this.database.setNetSuiteLastTest(summary);
      return summary;
    }
  }

  async exportMetadataCatalog(): Promise<NetSuiteCatalogExportResult> {
    const masterKey = this.requireMasterKey();
    const settings = this.getStoredSettings();
    assertConfiguredSettings(settings);

    const encryptedPrivateKey = this.database.getNetSuiteEncryptedPrivateKey();
    if (!encryptedPrivateKey) {
      throw new NetSuiteSettingsError("A NetSuite private key must be saved before the metadata catalog can be exported.");
    }

    let privateKeyPem: string;
    try {
      privateKeyPem = decryptSecret(encryptedPrivateKey, masterKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new NetSuiteSettingsError(`The saved NetSuite private key could not be decrypted: ${message}`);
    }

    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const previous = normalizeStoredLastCatalogExport(this.database.getNetSuiteLastCatalogExport());

    try {
      const result = await this.client.fetchMetadataCatalog(settings, privateKeyPem, checkedAt);
      const summary = await this.writeMetadataCatalogSnapshot(result.rows, result.schemas, {
        checkedAt,
        durationMs: Date.now() - startedAt,
        httpStatus: result.httpStatus
      });
      this.database.setNetSuiteLastCatalogExport(summary);
      return summary;
    } catch (error) {
      const normalized = normalizeConnectionError(error);
      const summary: NetSuiteCatalogExportResult = {
        status: "error",
        checkedAt,
        durationMs: Date.now() - startedAt,
        httpStatus: normalized.httpStatus,
        rowCount: null,
        schemaFileCount: previous?.schemaFileCount ?? null,
        fileName: previous?.fileName ?? null,
        latestPath: previous?.latestPath ?? null,
        schemaDirectory: previous?.schemaDirectory ?? null,
        errorCode: normalized.errorCode,
        errorMessage: normalized.detail
      };
      this.database.setNetSuiteLastCatalogExport(summary);
      return summary;
    }
  }

  getLatestMetadataCatalogDownload():
    | {
        absolutePath: string;
        fileName: string;
      }
    | null {
    const latest = normalizeStoredLastCatalogExport(this.database.getNetSuiteLastCatalogExport());
    if (!latest?.latestPath || !latest.fileName) {
      return null;
    }

    return {
      absolutePath: latest.latestPath,
      fileName: latest.fileName
    };
  }

  private getStoredSettings(): NetSuiteConnectionSettings {
    const stored = this.database.getNetSuiteConnectionSettings();
    return {
      serviceBaseUrl: typeof stored?.serviceBaseUrl === "string" ? stored.serviceBaseUrl : "",
      clientId: typeof stored?.clientId === "string" ? stored.clientId : "",
      certificateId: typeof stored?.certificateId === "string" ? stored.certificateId : "",
      jwtAlgorithm: isNetSuiteJwtAlgorithm(stored?.jwtAlgorithm) ? stored.jwtAlgorithm : DEFAULT_JWT_ALGORITHM,
      probeQuery: typeof stored?.probeQuery === "string" && stored.probeQuery.trim().length > 0
        ? stored.probeQuery
        : DEFAULT_PROBE_QUERY
    };
  }

  private requireMasterKey(): Buffer {
    const status = getSecretMasterKeyStatus(this.secretMasterKey);
    if (!status.key || status.error) {
      throw new NetSuiteSettingsError(status.error ?? "NetSuite secret storage is unavailable.");
    }
    return status.key;
  }

  private async writeMetadataCatalogSnapshot(
    rows: Array<{
      recordType: string;
      canonicalHref: string | null;
      openApiHref: string | null;
      jsonSchemaHref: string | null;
      describesHref: string | null;
      capturedAt: string;
    }>,
    schemas: Array<{
      recordType: string;
      schema: Record<string, unknown>;
    }>,
    context: {
      checkedAt: string;
      durationMs: number;
      httpStatus: number;
    }
  ): Promise<NetSuiteCatalogExportResult> {
    const stamp = formatRunStamp(new Date(context.checkedAt));
    const snapshotDir = path.join(this.metadataCatalogDir, "snapshots", stamp);
    const snapshotSchemaDir = path.join(snapshotDir, "schemas");
    const latestPath = path.join(this.metadataCatalogDir, "latest.csv");
    const latestSchemaDir = path.join(this.metadataCatalogDir, "latest-schemas");
    const snapshotCsvPath = path.join(snapshotDir, "catalog.csv");
    const csvRows = rows.map((row) => ({
      record_type: row.recordType,
      canonical_href: row.canonicalHref ?? "",
      openapi_href: row.openApiHref ?? "",
      json_schema_href: row.jsonSchemaHref ?? "",
      describes_href: row.describesHref ?? "",
      captured_at: row.capturedAt
    }));
    const csv = toCsv(csvRows, METADATA_CATALOG_EXPORT_COLUMNS);

    await ensureDir(snapshotDir);
    await ensureDir(snapshotSchemaDir);
    await writeTextFile(snapshotCsvPath, csv);
    await writeTextFile(latestPath, csv);

    await rm(latestSchemaDir, { recursive: true, force: true });
    await ensureDir(latestSchemaDir);

    for (const schema of schemas) {
      const fileName = `${sanitizeFileName(schema.recordType)}.schema.json`;
      const schemaJson = `${JSON.stringify(schema.schema, null, 2)}\n`;
      await writeTextFile(path.join(snapshotSchemaDir, fileName), schemaJson);
      await writeTextFile(path.join(latestSchemaDir, fileName), schemaJson);
    }

    return {
      status: "success",
      checkedAt: context.checkedAt,
      durationMs: context.durationMs,
      httpStatus: context.httpStatus,
      rowCount: rows.length,
      schemaFileCount: schemas.length,
      fileName: buildNetSuiteMetadataCatalogDownloadName({ createdAt: context.checkedAt }),
      latestPath,
      schemaDirectory: latestSchemaDir,
      errorCode: null,
      errorMessage: null
    };
  }
}

function normalizeUpdateInput(input: NetSuiteConnectionUpdateInput): NetSuiteConnectionUpdateInput {
  const clearPrivateKey = input.clearPrivateKey === true;
  const privateKeyPem = typeof input.privateKeyPem === "string" ? input.privateKeyPem.trim() : "";
  if (clearPrivateKey && privateKeyPem) {
    throw new NetSuiteSettingsError("Provide a new NetSuite private key or clear the saved key, but not both in the same request.");
  }

  return {
    serviceBaseUrl: normalizeServiceBaseUrl(input.serviceBaseUrl),
    clientId: requireTrimmedValue("clientId", input.clientId),
    certificateId: requireTrimmedValue("certificateId", input.certificateId),
    jwtAlgorithm: normalizeJwtAlgorithm(input.jwtAlgorithm),
    probeQuery: normalizeProbeQuery(input.probeQuery),
    privateKeyPem: privateKeyPem || null,
    clearPrivateKey
  };
}

function assertConfiguredSettings(settings: NetSuiteConnectionSettings): void {
  if (!settings.serviceBaseUrl || !settings.clientId || !settings.certificateId || !settings.probeQuery) {
    throw new NetSuiteSettingsError("Save the NetSuite service URL, client ID, certificate ID, JWT algorithm, and probe query before testing the connection.");
  }
}

function validatePrivateKeyPem(privateKeyPem: string): void {
  try {
    createPrivateKey(privateKeyPem);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new NetSuiteSettingsError(`The NetSuite private key is not a valid PEM key: ${message}`);
  }
}

function normalizeServiceBaseUrl(value: string): string {
  const normalized = requireTrimmedValue("serviceBaseUrl", value);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new NetSuiteSettingsError("serviceBaseUrl must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    throw new NetSuiteSettingsError("serviceBaseUrl must use HTTPS.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new NetSuiteSettingsError("serviceBaseUrl must be the base SuiteTalk REST URL without an extra path.");
  }
  if (url.search || url.hash) {
    throw new NetSuiteSettingsError("serviceBaseUrl must not include query parameters or fragments.");
  }

  return url.origin;
}

function normalizeProbeQuery(value: string): string {
  const query = requireTrimmedValue("probeQuery", value);
  return query;
}

function normalizeJwtAlgorithm(value: unknown): NetSuiteJwtAlgorithm {
  if (!isNetSuiteJwtAlgorithm(value)) {
    throw new NetSuiteSettingsError(`jwtAlgorithm must be one of: ${NETSUITE_JWT_ALGORITHMS.join(", ")}`);
  }
  return value;
}

function isNetSuiteJwtAlgorithm(value: unknown): value is NetSuiteJwtAlgorithm {
  return typeof value === "string" && NETSUITE_JWT_ALGORITHMS.includes(value as NetSuiteJwtAlgorithm);
}

function requireTrimmedValue(label: string, value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new NetSuiteSettingsError(`${label} is required.`);
  }
  return normalized;
}

function maskIdentifier(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 4)}***${normalized.slice(-4)}`;
}

function normalizeConnectionError(error: unknown): {
  httpStatus: number | null;
  errorCode: string | null;
  detail: string;
} {
  if (error instanceof NetSuiteRequestError) {
    return {
      httpStatus: error.httpStatus,
      errorCode: error.errorCode,
      detail: error.detail
    };
  }

  if (error instanceof SecretConfigurationError) {
    return {
      httpStatus: null,
      errorCode: "secret_configuration_error",
      detail: error.message
    };
  }

  const detail = error instanceof Error ? error.message : String(error);
  return {
    httpStatus: null,
    errorCode: "unexpected_error",
    detail
  };
}

export const NETSUITE_DEFAULT_PROBE_QUERY = DEFAULT_PROBE_QUERY;
export const NETSUITE_DEFAULT_JWT_ALGORITHM = DEFAULT_JWT_ALGORITHM;

function normalizeStoredLastTest(value: Record<string, unknown> | null): NetSuiteConnectionTestResult | null {
  if (!value) {
    return null;
  }

  if (value.status !== "success" && value.status !== "error") {
    return null;
  }

  return {
    status: value.status,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : 0,
    httpStatus: typeof value.httpStatus === "number" && Number.isFinite(value.httpStatus) ? value.httpStatus : null,
    count: typeof value.count === "number" && Number.isFinite(value.count) ? value.count : null,
    totalResults: typeof value.totalResults === "number" && Number.isFinite(value.totalResults) ? value.totalResults : null,
    columnNames: Array.isArray(value.columnNames)
      ? value.columnNames.filter((entry) => typeof entry === "string")
      : [],
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null
  };
}

function normalizeStoredLastCatalogExport(value: Record<string, unknown> | null): NetSuiteCatalogExportResult | null {
  if (!value) {
    return null;
  }

  if (value.status !== "success" && value.status !== "error") {
    return null;
  }

  return {
    status: value.status,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : 0,
    httpStatus: typeof value.httpStatus === "number" && Number.isFinite(value.httpStatus) ? value.httpStatus : null,
    rowCount: typeof value.rowCount === "number" && Number.isFinite(value.rowCount) ? value.rowCount : null,
    schemaFileCount: typeof value.schemaFileCount === "number" && Number.isFinite(value.schemaFileCount) ? value.schemaFileCount : null,
    fileName: typeof value.fileName === "string" ? value.fileName : null,
    latestPath: typeof value.latestPath === "string" ? value.latestPath : null,
    schemaDirectory: typeof value.schemaDirectory === "string" ? value.schemaDirectory : null,
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null,
    errorMessage: typeof value.errorMessage === "string" ? value.errorMessage : null
  };
}

import { DatabaseSync } from "node:sqlite";
import { rename } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/files.js";
import type { ParsedReport, ReportType, RunSummary, TriggerSource } from "../types.js";
import { COMMON_EXPORT_COLUMNS, REPORT_COLUMN_MAP } from "../reports.js";
import { UNASSIGNED_PROPERTY_NAME, UNASSIGNED_PROPERTY_SLUG } from "../utils/properties.js";
import type { UserRole } from "../auth/AuthService.js";

const APPROVED_SENDERS_STATE_KEY = "settings.approved_senders";
const NETSUITE_CONNECTION_STATE_KEY = "settings.netsuite.connection";
const NETSUITE_PRIVATE_KEY_STATE_KEY = "settings.netsuite.private_key_encrypted";
const NETSUITE_LAST_TEST_STATE_KEY = "settings.netsuite.last_test";
const NETSUITE_LAST_CATALOG_EXPORT_STATE_KEY = "settings.netsuite.last_catalog_export";

interface AttachmentInsert {
  graphMessageId: string;
  graphAttachmentId: string;
  internetMessageId: string | null;
  sourceMailbox: string;
  receivedAt: string;
  attachmentName: string;
  propertyName: string | null;
  propertySlug: string | null;
  extension: string;
  contentType: string | null;
  archivedPath: string;
  status: string;
  ingestRunId: number;
}

interface AttachmentUpdate {
  status?: string;
  propertyName?: string | null;
  propertySlug?: string | null;
  ingestRunId?: number;
  reportType?: ReportType | null;
  reportTitle?: string | null;
  reportDate?: string | null;
  parseError?: string | null;
  parsedJsonPath?: string | null;
  quarantinePath?: string | null;
}

interface NetSuiteMonetaryMappingRecord {
  propertySlug: string;
  reportType: ReportType;
  mappingKey: string;
  groupLabel: string;
  itemLabel: string;
  amountField: string;
  amountFieldLabel: string;
  defaultPostingPolarity: string;
  postingPolarity: string;
  netsuiteGlCode: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAttachmentId: number | null;
  lastAttachmentName: string;
  updatedAt: string;
}

interface NetSuitePostingDefaultsRecord {
  propertySlug: string;
  reportType: ReportType;
  balancingGlCode: string;
  externalIdPrefix: string;
  memoTemplate: string;
  subsidiaryId: string;
  currencyId: string;
  locationId: string;
  departmentId: string;
  classId: string;
  updatedAt: string;
}

interface NetSuitePostingRunInsert {
  id: string;
  propertySlug: string;
  propertyName: string | null;
  reportType: ReportType;
  reportTitle: string;
  attachmentRecordId: number;
  attachmentName: string;
  reportDate: string | null;
  status: "preview" | "submitted" | "failed";
  externalId: string;
  previewPayload: object;
  netsuiteResponseSummary: string;
  netsuiteResponsePayload: object | null;
  errorMessage: string;
  createdByUsername: string;
  submittedAt: string | null;
}

interface NetSuitePostingRunUpdate {
  status?: "preview" | "submitted" | "failed";
  externalId?: string;
  previewPayload?: object;
  netsuiteResponseSummary?: string;
  netsuiteResponsePayload?: object | null;
  errorMessage?: string;
  submittedAt?: string | null;
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(private readonly databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = MEMORY;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  static async open(databasePath: string): Promise<AppDatabase> {
    await ensureDir(path.dirname(databasePath));
    try {
      return openInitializedDatabase(databasePath);
    } catch (error) {
      if (!isSqliteDiskIoError(error)) {
        throw error;
      }

      try {
        await archiveBrokenDatabase(databasePath);
        return openInitializedDatabase(databasePath);
      } catch {
        const fallbackPath = buildFallbackDatabasePath(databasePath);
        return openInitializedDatabase(fallbackPath);
      }
    }
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_source TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        messages_seen INTEGER NOT NULL DEFAULT 0,
        attachments_seen INTEGER NOT NULL DEFAULT 0,
        attachments_approved INTEGER NOT NULL DEFAULT 0,
        attachments_not_approved INTEGER NOT NULL DEFAULT 0,
        attachments_archived INTEGER NOT NULL DEFAULT 0,
        attachments_parsed INTEGER NOT NULL DEFAULT 0,
        attachments_deferred INTEGER NOT NULL DEFAULT 0,
        attachments_failed INTEGER NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        graph_message_id TEXT PRIMARY KEY,
        internet_message_id TEXT,
        subject TEXT,
        sender_email TEXT,
        received_at TEXT NOT NULL,
        web_link TEXT,
        has_attachments INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        graph_message_id TEXT NOT NULL,
        graph_attachment_id TEXT NOT NULL,
        last_ingest_run_id INTEGER NOT NULL,
        internet_message_id TEXT,
        source_mailbox TEXT NOT NULL,
        received_at TEXT NOT NULL,
        attachment_name TEXT NOT NULL,
        property_name TEXT,
        property_slug TEXT,
        extension TEXT NOT NULL,
        content_type TEXT,
        archived_path TEXT NOT NULL,
        quarantine_path TEXT,
        status TEXT NOT NULL,
        report_type TEXT,
        report_title TEXT,
        report_date TEXT,
        parse_error TEXT,
        parsed_json_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(graph_message_id, graph_attachment_id),
        FOREIGN KEY (graph_message_id) REFERENCES messages(graph_message_id),
        FOREIGN KEY (last_ingest_run_id) REFERENCES ingest_runs(id)
      );

      CREATE TABLE IF NOT EXISTS export_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ingest_run_id INTEGER NOT NULL,
        property_name TEXT,
        property_slug TEXT,
        report_type TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        csv_path TEXT NOT NULL,
        latest_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id)
      );

      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS netsuite_monetary_mappings (
        property_slug TEXT NOT NULL,
        report_type TEXT NOT NULL,
        mapping_key TEXT NOT NULL,
        group_label TEXT NOT NULL DEFAULT '',
        item_label TEXT NOT NULL DEFAULT '',
        amount_field TEXT NOT NULL DEFAULT '',
        amount_field_label TEXT NOT NULL DEFAULT '',
        default_posting_polarity TEXT NOT NULL DEFAULT '',
        posting_polarity TEXT NOT NULL DEFAULT '',
        netsuite_gl_code TEXT NOT NULL DEFAULT '',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_attachment_id INTEGER,
        last_attachment_name TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (property_slug, report_type, mapping_key),
        FOREIGN KEY (last_attachment_id) REFERENCES attachments(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS netsuite_posting_defaults (
        property_slug TEXT NOT NULL,
        report_type TEXT NOT NULL,
        balancing_gl_code TEXT NOT NULL DEFAULT '',
        external_id_prefix TEXT NOT NULL DEFAULT '',
        memo_template TEXT NOT NULL DEFAULT '',
        subsidiary_id TEXT NOT NULL DEFAULT '',
        currency_id TEXT NOT NULL DEFAULT '',
        location_id TEXT NOT NULL DEFAULT '',
        department_id TEXT NOT NULL DEFAULT '',
        class_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (property_slug, report_type)
      );

      CREATE TABLE IF NOT EXISTS netsuite_posting_runs (
        id TEXT PRIMARY KEY,
        property_slug TEXT NOT NULL,
        property_name TEXT,
        report_type TEXT NOT NULL,
        report_title TEXT NOT NULL DEFAULT '',
        attachment_record_id INTEGER NOT NULL,
        attachment_name TEXT NOT NULL DEFAULT '',
        report_date TEXT,
        status TEXT NOT NULL CHECK (status IN ('preview', 'submitted', 'failed')),
        external_id TEXT NOT NULL DEFAULT '',
        preview_payload TEXT NOT NULL DEFAULT '',
        netsuite_response_summary TEXT NOT NULL DEFAULT '',
        netsuite_response_payload TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_by_username TEXT NOT NULL DEFAULT '',
        submitted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (attachment_record_id) REFERENCES attachments(id) ON DELETE CASCADE
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_netsuite_monetary_mappings_property
      ON netsuite_monetary_mappings (property_slug, report_type, item_label);

      CREATE INDEX IF NOT EXISTS idx_netsuite_posting_runs_property
      ON netsuite_posting_runs (property_slug, report_type, created_at DESC);
    `);

    for (const [reportType, columns] of Object.entries(REPORT_COLUMN_MAP)) {
      const reportColumns = columns
        .filter((column) => !COMMON_EXPORT_COLUMNS.includes(column as (typeof COMMON_EXPORT_COLUMNS)[number]) && column !== "ingest_run_id")
        .map((column) => `${column} TEXT`)
        .join(",\n");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${reportType} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ingest_run_id INTEGER NOT NULL,
          attachment_record_id INTEGER NOT NULL,
          source_mailbox TEXT NOT NULL,
          graph_message_id TEXT NOT NULL,
          internet_message_id TEXT,
          received_at TEXT NOT NULL,
          attachment_id TEXT NOT NULL,
          attachment_name TEXT NOT NULL,
          property_name TEXT,
          property_slug TEXT,
          report_type TEXT NOT NULL,
          report_title TEXT NOT NULL,
          report_date TEXT,
          ${reportColumns},
          created_at TEXT NOT NULL,
          FOREIGN KEY (attachment_record_id) REFERENCES attachments(id),
          FOREIGN KEY (ingest_run_id) REFERENCES ingest_runs(id)
        );
      `);
    }

    this.ensureColumn("attachments", "property_name", "TEXT");
    this.ensureColumn("attachments", "property_slug", "TEXT");
    this.ensureColumn("messages", "sender_email", "TEXT");
    this.ensureColumn("ingest_runs", "attachments_approved", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("ingest_runs", "attachments_not_approved", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("export_history", "property_name", "TEXT");
    this.ensureColumn("export_history", "property_slug", "TEXT");
    for (const reportType of Object.keys(REPORT_COLUMN_MAP)) {
      this.ensureColumn(reportType, "property_name", "TEXT");
      this.ensureColumn(reportType, "property_slug", "TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  createRun(triggerSource: TriggerSource): number {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO ingest_runs (trigger_source, status, started_at)
      VALUES (?, 'running', ?)
    `);
    const result = statement.run(triggerSource, now);
    return Number(result.lastInsertRowid);
  }

  updateRunProgress(runId: number, summary: RunSummary): void {
    this.db.prepare(`
      UPDATE ingest_runs
      SET messages_seen = ?,
          attachments_seen = ?,
          attachments_approved = ?,
          attachments_not_approved = ?,
          attachments_archived = ?,
          attachments_parsed = ?,
          attachments_deferred = ?,
          attachments_failed = ?
      WHERE id = ?
    `).run(
      summary.messagesSeen,
      summary.attachmentsSeen,
      summary.attachmentsApproved,
      summary.attachmentsNotApproved,
      summary.attachmentsArchived,
      summary.attachmentsParsed,
      summary.attachmentsDeferred,
      summary.attachmentsFailed,
      runId
    );
  }

  finishRun(runId: number, status: "completed" | "failed", summary: RunSummary): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ingest_runs
      SET status = ?,
          finished_at = ?,
          messages_seen = ?,
          attachments_seen = ?,
          attachments_approved = ?,
          attachments_not_approved = ?,
          attachments_archived = ?,
          attachments_parsed = ?,
          attachments_deferred = ?,
          attachments_failed = ?,
          notes = ?
      WHERE id = ?
    `).run(
      status,
      now,
      summary.messagesSeen,
      summary.attachmentsSeen,
      summary.attachmentsApproved,
      summary.attachmentsNotApproved,
      summary.attachmentsArchived,
      summary.attachmentsParsed,
      summary.attachmentsDeferred,
      summary.attachmentsFailed,
      JSON.stringify(summary.notes),
      runId
    );
  }

  getRunProgress(runId: number): Record<string, unknown> | null {
    const run = this.db.prepare(`
      SELECT
        id,
        trigger_source,
        status,
        started_at,
        finished_at,
        messages_seen,
        attachments_seen,
        attachments_approved,
        attachments_not_approved,
        attachments_archived,
        attachments_parsed,
        attachments_deferred,
        attachments_failed
      FROM ingest_runs
      WHERE id = ?
    `).get(runId) as Record<string, unknown> | undefined;

    return run ?? null;
  }

  getRun(runId: number): Record<string, unknown> | null {
    const run = this.db.prepare(`SELECT * FROM ingest_runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
    if (!run) {
      return null;
    }

    const attachments = this.db.prepare(`
      SELECT id, graph_message_id, graph_attachment_id, attachment_name, property_name, property_slug, status, report_type, report_title, report_date, parse_error, archived_path, quarantine_path, parsed_json_path
      FROM attachments
      WHERE last_ingest_run_id = ?
      ORDER BY id
    `).all(runId) as Array<Record<string, unknown>>;

    return {
      ...run,
      attachments,
      notes: parseNotes(run.notes)
    };
  }

  getLatestRunProgress(): Record<string, unknown> | null {
    const run = this.db.prepare(`
      SELECT
        id,
        trigger_source,
        status,
        started_at,
        finished_at,
        messages_seen,
        attachments_seen,
        attachments_approved,
        attachments_not_approved,
        attachments_archived,
        attachments_parsed,
        attachments_deferred,
        attachments_failed
      FROM ingest_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    return run ?? null;
  }

  getLatestRun(): Record<string, unknown> | null {
    const run = this.db.prepare(`
      SELECT * FROM ingest_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as Record<string, unknown> | undefined;

    if (!run) {
      return null;
    }

    return {
      ...run,
      notes: parseNotes(run.notes)
    };
  }

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now);
  }

  getUserByUsername(username: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT id, username, password_hash, role, created_at, updated_at
      FROM app_users
      WHERE username = ?
      LIMIT 1
    `).get(username) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  getUserById(userId: number): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT id, username, password_hash, role, created_at, updated_at
      FROM app_users
      WHERE id = ?
      LIMIT 1
    `).get(userId) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  listUsers(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT id, username, role, created_at
      FROM app_users
      ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username ASC
    `).all() as Array<Record<string, unknown>>;
  }

  createUser(username: string, passwordHash: string, role: UserRole): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO app_users (username, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, passwordHash, role, now, now);

    return Number(result.lastInsertRowid);
  }

  updateUserPasswordHash(userId: number, passwordHash: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE app_users
      SET password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(passwordHash, now, userId);
  }

  deleteUser(userId: number): void {
    this.db.prepare(`DELETE FROM app_users WHERE id = ?`).run(userId);
  }

  createSession(token: string, userId: number, expiresAt: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_sessions (token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(token, userId, expiresAt, now);
  }

  getSessionUser(token: string, now: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT u.id, u.username, u.role
      FROM app_sessions s
      INNER JOIN app_users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?
      LIMIT 1
    `).get(token, now) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  deleteSession(token: string): void {
    this.db.prepare(`DELETE FROM app_sessions WHERE token = ?`).run(token);
  }

  deleteExpiredSessions(now: string): void {
    this.db.prepare(`DELETE FROM app_sessions WHERE expires_at <= ?`).run(now);
  }

  upsertMessage(message: {
    graphMessageId: string;
    internetMessageId: string | null;
    subject: string | null;
    senderEmail: string | null;
    receivedAt: string;
    webLink: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO messages (graph_message_id, internet_message_id, subject, sender_email, received_at, web_link, has_attachments, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(graph_message_id) DO UPDATE SET
        internet_message_id = excluded.internet_message_id,
        subject = excluded.subject,
        sender_email = excluded.sender_email,
        received_at = excluded.received_at,
        web_link = excluded.web_link,
        last_seen_at = excluded.last_seen_at
    `).run(
      message.graphMessageId,
      message.internetMessageId,
      message.subject,
      message.senderEmail,
      message.receivedAt,
      message.webLink,
      now
    );
  }

  getApprovedSenderPatterns(): string[] | null {
    const raw = this.getState(APPROVED_SENDERS_STATE_KEY);
    if (raw === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
    } catch {
      return [];
    }
  }

  setApprovedSenderPatterns(patterns: string[]): void {
    this.setState(APPROVED_SENDERS_STATE_KEY, JSON.stringify(patterns));
  }

  getNetSuiteConnectionSettings(): Record<string, unknown> | null {
    return this.getJsonState(NETSUITE_CONNECTION_STATE_KEY);
  }

  setNetSuiteConnectionSettings(settings: object): void {
    this.setState(NETSUITE_CONNECTION_STATE_KEY, JSON.stringify(settings));
  }

  getNetSuiteEncryptedPrivateKey(): string | null {
    return this.getState(NETSUITE_PRIVATE_KEY_STATE_KEY);
  }

  setNetSuiteEncryptedPrivateKey(value: string | null): void {
    this.setState(NETSUITE_PRIVATE_KEY_STATE_KEY, value);
  }

  getNetSuiteLastTest(): Record<string, unknown> | null {
    return this.getJsonState(NETSUITE_LAST_TEST_STATE_KEY);
  }

  setNetSuiteLastTest(result: object | null): void {
    this.setState(NETSUITE_LAST_TEST_STATE_KEY, result ? JSON.stringify(result) : null);
  }

  getNetSuiteLastCatalogExport(): Record<string, unknown> | null {
    return this.getJsonState(NETSUITE_LAST_CATALOG_EXPORT_STATE_KEY);
  }

  setNetSuiteLastCatalogExport(result: object | null): void {
    this.setState(NETSUITE_LAST_CATALOG_EXPORT_STATE_KEY, result ? JSON.stringify(result) : null);
  }

  listNetSuitePostingPropertySummaries(reportTypes: ReportType[]): Array<Record<string, unknown>> {
    if (reportTypes.length === 0) {
      return [];
    }

    const placeholders = buildSqlPlaceholders(reportTypes.length);
    return this.db.prepare(`
      SELECT
        COALESCE(property_slug, '${UNASSIGNED_PROPERTY_SLUG}') AS property_slug,
        COALESCE(MAX(NULLIF(property_name, '')), '${UNASSIGNED_PROPERTY_NAME}') AS property_name,
        COUNT(*) AS attachment_count,
        MAX(received_at) AS last_received_at
      FROM attachments
      WHERE status = 'parsed'
        AND report_type IN (${placeholders})
      GROUP BY COALESCE(property_slug, '${UNASSIGNED_PROPERTY_SLUG}')
      ORDER BY property_name
    `).all(...reportTypes) as Array<Record<string, unknown>>;
  }

  getNetSuiteMonetaryMappings(propertySlug: string, reportType: ReportType): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        property_slug,
        report_type,
        mapping_key,
        group_label,
        item_label,
        amount_field,
        amount_field_label,
        default_posting_polarity,
        posting_polarity,
        netsuite_gl_code,
        first_seen_at,
        last_seen_at,
        last_attachment_id,
        last_attachment_name,
        updated_at
      FROM netsuite_monetary_mappings
      WHERE property_slug = ? AND report_type = ?
      ORDER BY group_label, item_label, amount_field_label, mapping_key
    `).all(propertySlug, reportType) as Array<Record<string, unknown>>;
  }

  upsertNetSuiteMonetaryMappings(records: NetSuiteMonetaryMappingRecord[]): void {
    if (records.length === 0) {
      return;
    }

    const statement = this.db.prepare(`
      INSERT INTO netsuite_monetary_mappings (
        property_slug,
        report_type,
        mapping_key,
        group_label,
        item_label,
        amount_field,
        amount_field_label,
        default_posting_polarity,
        posting_polarity,
        netsuite_gl_code,
        first_seen_at,
        last_seen_at,
        last_attachment_id,
        last_attachment_name,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(property_slug, report_type, mapping_key) DO UPDATE SET
        group_label = excluded.group_label,
        item_label = excluded.item_label,
        amount_field = excluded.amount_field,
        amount_field_label = excluded.amount_field_label,
        default_posting_polarity = excluded.default_posting_polarity,
        posting_polarity = excluded.posting_polarity,
        netsuite_gl_code = excluded.netsuite_gl_code,
        first_seen_at = MIN(netsuite_monetary_mappings.first_seen_at, excluded.first_seen_at),
        last_seen_at = excluded.last_seen_at,
        last_attachment_id = excluded.last_attachment_id,
        last_attachment_name = excluded.last_attachment_name,
        updated_at = excluded.updated_at
    `);

    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        statement.run(
          record.propertySlug,
          record.reportType,
          record.mappingKey,
          record.groupLabel,
          record.itemLabel,
          record.amountField,
          record.amountFieldLabel,
          record.defaultPostingPolarity,
          record.postingPolarity,
          record.netsuiteGlCode,
          record.firstSeenAt,
          record.lastSeenAt,
          record.lastAttachmentId,
          record.lastAttachmentName,
          record.updatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getNetSuitePostingDefaults(propertySlug: string, reportType: ReportType): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT
        property_slug,
        report_type,
        balancing_gl_code,
        external_id_prefix,
        memo_template,
        subsidiary_id,
        currency_id,
        location_id,
        department_id,
        class_id,
        updated_at
      FROM netsuite_posting_defaults
      WHERE property_slug = ? AND report_type = ?
    `).get(propertySlug, reportType) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  saveNetSuitePostingDefaults(record: NetSuitePostingDefaultsRecord): void {
    this.db.prepare(`
      INSERT INTO netsuite_posting_defaults (
        property_slug,
        report_type,
        balancing_gl_code,
        external_id_prefix,
        memo_template,
        subsidiary_id,
        currency_id,
        location_id,
        department_id,
        class_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(property_slug, report_type) DO UPDATE SET
        balancing_gl_code = excluded.balancing_gl_code,
        external_id_prefix = excluded.external_id_prefix,
        memo_template = excluded.memo_template,
        subsidiary_id = excluded.subsidiary_id,
        currency_id = excluded.currency_id,
        location_id = excluded.location_id,
        department_id = excluded.department_id,
        class_id = excluded.class_id,
        updated_at = excluded.updated_at
    `).run(
      record.propertySlug,
      record.reportType,
      record.balancingGlCode,
      record.externalIdPrefix,
      record.memoTemplate,
      record.subsidiaryId,
      record.currencyId,
      record.locationId,
      record.departmentId,
      record.classId,
      record.updatedAt
    );
  }

  insertNetSuitePostingRun(record: NetSuitePostingRunInsert): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO netsuite_posting_runs (
        id,
        property_slug,
        property_name,
        report_type,
        report_title,
        attachment_record_id,
        attachment_name,
        report_date,
        status,
        external_id,
        preview_payload,
        netsuite_response_summary,
        netsuite_response_payload,
        error_message,
        created_by_username,
        submitted_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.propertySlug,
      record.propertyName,
      record.reportType,
      record.reportTitle,
      record.attachmentRecordId,
      record.attachmentName,
      record.reportDate,
      record.status,
      record.externalId,
      JSON.stringify(record.previewPayload),
      record.netsuiteResponseSummary,
      record.netsuiteResponsePayload ? JSON.stringify(record.netsuiteResponsePayload) : "",
      record.errorMessage,
      record.createdByUsername,
      record.submittedAt,
      now,
      now
    );
  }

  updateNetSuitePostingRun(runId: string, update: NetSuitePostingRunUpdate): void {
    const current = this.getNetSuitePostingRun(runId);
    if (!current) {
      throw new Error(`NetSuite posting run ${runId} was not found.`);
    }

    const status = update.status ?? String(current.status || "preview");
    const externalId = update.externalId ?? String(current.external_id || "");
    const previewPayload = Object.prototype.hasOwnProperty.call(update, "previewPayload")
      ? JSON.stringify(update.previewPayload ?? {})
      : String(current.preview_payload || "");
    const netsuiteResponseSummary = update.netsuiteResponseSummary ?? String(current.netsuite_response_summary || "");
    const netsuiteResponsePayload = Object.prototype.hasOwnProperty.call(update, "netsuiteResponsePayload")
      ? JSON.stringify(update.netsuiteResponsePayload ?? {})
      : String(current.netsuite_response_payload || "");
    const errorMessage = update.errorMessage ?? String(current.error_message || "");
    const submittedAt = Object.prototype.hasOwnProperty.call(update, "submittedAt")
      ? (update.submittedAt ?? null)
      : (typeof current.submitted_at === "string" && current.submitted_at ? current.submitted_at : null);

    this.db.prepare(`
      UPDATE netsuite_posting_runs
      SET status = ?,
          external_id = ?,
          preview_payload = ?,
          netsuite_response_summary = ?,
          netsuite_response_payload = ?,
          error_message = ?,
          submitted_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      externalId,
      previewPayload,
      netsuiteResponseSummary,
      netsuiteResponsePayload,
      errorMessage,
      submittedAt,
      new Date().toISOString(),
      runId
    );
  }

  getNetSuitePostingRun(runId: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT *
      FROM netsuite_posting_runs
      WHERE id = ?
    `).get(runId) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  listNetSuitePostingRuns(propertySlug: string, reportType: ReportType, limit = 10): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT *
      FROM netsuite_posting_runs
      WHERE property_slug = ? AND report_type = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(propertySlug, reportType, limit) as Array<Record<string, unknown>>;
  }

  getAttachmentRecord(graphMessageId: string, graphAttachmentId: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT * FROM attachments WHERE graph_message_id = ? AND graph_attachment_id = ?
    `).get(graphMessageId, graphAttachmentId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  listAttachmentsForReparse(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        id,
        graph_message_id,
        graph_attachment_id,
        internet_message_id,
        source_mailbox,
        received_at,
        attachment_name,
        property_name,
        property_slug,
        extension,
        content_type,
        archived_path,
        report_title,
        report_date
      FROM attachments
      ORDER BY received_at, id
    `).all() as Array<Record<string, unknown>>;
  }

  insertAttachment(input: AttachmentInsert): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO attachments (
        graph_message_id,
        graph_attachment_id,
        last_ingest_run_id,
        internet_message_id,
        source_mailbox,
        received_at,
        attachment_name,
        property_name,
        property_slug,
        extension,
        content_type,
        archived_path,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.graphMessageId,
      input.graphAttachmentId,
      input.ingestRunId,
      input.internetMessageId,
      input.sourceMailbox,
      input.receivedAt,
      input.attachmentName,
      input.propertyName,
      input.propertySlug,
      input.extension,
      input.contentType,
      input.archivedPath,
      input.status,
      now,
      now
    );

    return Number(result.lastInsertRowid);
  }

  updateAttachment(recordId: number, input: AttachmentUpdate): void {
    const current = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(recordId) as Record<string, string | number | null>;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE attachments
      SET status = ?,
          property_name = ?,
          property_slug = ?,
          report_type = ?,
          report_title = ?,
          report_date = ?,
          parse_error = ?,
          parsed_json_path = ?,
          quarantine_path = ?,
          last_ingest_run_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      pickAttachmentUpdateValue(input, "status", current.status),
      pickAttachmentUpdateValue(input, "propertyName", current.property_name),
      pickAttachmentUpdateValue(input, "propertySlug", current.property_slug),
      pickAttachmentUpdateValue(input, "reportType", current.report_type),
      pickAttachmentUpdateValue(input, "reportTitle", current.report_title),
      pickAttachmentUpdateValue(input, "reportDate", current.report_date),
      pickAttachmentUpdateValue(input, "parseError", current.parse_error),
      pickAttachmentUpdateValue(input, "parsedJsonPath", current.parsed_json_path),
      pickAttachmentUpdateValue(input, "quarantinePath", current.quarantine_path),
      pickAttachmentUpdateValue(input, "ingestRunId", current.last_ingest_run_id),
      now,
      recordId
    );
  }

  insertParsedReport(
    runId: number,
    attachmentRecordId: number,
    provenance: {
      sourceMailbox: string;
      graphMessageId: string;
      internetMessageId: string | null;
      receivedAt: string;
      attachmentId: string;
      attachmentName: string;
      propertyName: string | null;
      propertySlug: string | null;
    },
    report: ParsedReport
  ): number {
    const specificColumns = REPORT_COLUMN_MAP[report.reportType].filter((column) => ![
      "source_mailbox",
      "graph_message_id",
      "internet_message_id",
      "received_at",
      "attachment_id",
      "attachment_name",
      "property_name",
      "property_slug",
      "report_type",
      "report_title",
      "report_date",
      "ingest_run_id"
    ].includes(column));

    const insertColumns = [
      "ingest_run_id",
      "attachment_record_id",
      "source_mailbox",
      "graph_message_id",
      "internet_message_id",
      "received_at",
      "attachment_id",
      "attachment_name",
      "property_name",
      "property_slug",
      "report_type",
      "report_title",
      "report_date",
      ...specificColumns,
      "created_at"
    ];

    const placeholders = insertColumns.map(() => "?").join(", ");
    const statement = this.db.prepare(`
      INSERT INTO ${report.reportType} (${insertColumns.join(", ")})
      VALUES (${placeholders})
    `);
    const now = new Date().toISOString();

    let inserted = 0;
    for (const row of report.rows) {
      const values = [
        runId,
        attachmentRecordId,
        provenance.sourceMailbox,
        provenance.graphMessageId,
        provenance.internetMessageId,
        provenance.receivedAt,
        provenance.attachmentId,
        provenance.attachmentName,
        provenance.propertyName,
        provenance.propertySlug,
        report.reportType,
        report.reportTitle,
        report.reportDate,
        ...specificColumns.map((column) => normalizeRowValue(row[column])),
        now
      ];
      statement.run(...values);
      inserted += 1;
    }

    return inserted;
  }

  getExportRows(reportType: ReportType, options?: { runId?: number; propertySlug?: string | null }): Array<Record<string, unknown>> {
    const clauses: string[] = [];
    const params: Array<number | string> = [];

    if (options?.runId !== undefined) {
      clauses.push("ingest_run_id = ?");
      params.push(options.runId);
    }
    if (options?.propertySlug) {
      clauses.push("COALESCE(property_slug, ?) = ?");
      params.push(UNASSIGNED_PROPERTY_SLUG, options.propertySlug);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const statement = this.db.prepare(`SELECT ${REPORT_COLUMN_MAP[reportType].join(", ")} FROM ${reportType}${where} ORDER BY id`);
    return statement.all(...params) as Array<Record<string, unknown>>;
  }

  getAttachmentExportRows(reportType: ReportType, attachmentRecordId: number): Array<Record<string, unknown>> {
    const statement = this.db.prepare(`
      SELECT ${REPORT_COLUMN_MAP[reportType].join(", ")}
      FROM ${reportType}
      WHERE attachment_record_id = ?
      ORDER BY id
    `);
    return statement.all(attachmentRecordId) as Array<Record<string, unknown>>;
  }

  recordExport(
    runId: number,
    reportType: ReportType,
    rowCount: number,
    csvPath: string,
    latestPath: string,
    property: { propertyName: string | null; propertySlug: string | null }
  ): void {
    this.db.prepare(`
      INSERT INTO export_history (ingest_run_id, property_name, property_slug, report_type, row_count, csv_path, latest_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, property.propertyName, property.propertySlug, reportType, rowCount, csvPath, latestPath, new Date().toISOString());
  }

  updateExportRowCount(exportId: number, rowCount: number): void {
    this.db.prepare(`UPDATE export_history SET row_count = ? WHERE id = ?`).run(rowCount, exportId);
  }

  getLatestExport(reportType: ReportType, propertySlug?: string | null): Record<string, unknown> | null {
    const row = propertySlug
      ? this.db.prepare(`
        SELECT * FROM export_history
        WHERE report_type = ? AND COALESCE(property_slug, ?) = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(reportType, UNASSIGNED_PROPERTY_SLUG, propertySlug) as Record<string, unknown> | undefined
      : this.db.prepare(`
        SELECT * FROM export_history
        WHERE report_type = ? AND property_slug IS NULL
        ORDER BY id DESC
        LIMIT 1
      `).get(reportType) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  getPropertySummaries(): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        COALESCE(property_slug, '${UNASSIGNED_PROPERTY_SLUG}') AS property_slug,
        COALESCE(MAX(NULLIF(property_name, '')), '${UNASSIGNED_PROPERTY_NAME}') AS property_name,
        COUNT(*) AS attachment_count,
        SUM(CASE WHEN status = 'parsed' THEN 1 ELSE 0 END) AS parsed_count,
        SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS deferred_count,
        SUM(CASE WHEN status IN ('failed', 'unsupported') THEN 1 ELSE 0 END) AS failed_count,
        MAX(received_at) AS last_received_at
      FROM attachments
      GROUP BY COALESCE(property_slug, '${UNASSIGNED_PROPERTY_SLUG}')
      HAVING SUM(CASE WHEN status IN ('parsed', 'deferred') THEN 1 ELSE 0 END) > 0
      ORDER BY property_name
    `).all() as Array<Record<string, unknown>>;
  }

  getPropertySummary(propertySlug: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT
        COALESCE(property_slug, ?) AS property_slug,
        COALESCE(MAX(NULLIF(property_name, '')), ?) AS property_name,
        COUNT(*) AS attachment_count,
        SUM(CASE WHEN status = 'parsed' THEN 1 ELSE 0 END) AS parsed_count,
        SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS deferred_count,
        SUM(CASE WHEN status IN ('failed', 'unsupported') THEN 1 ELSE 0 END) AS failed_count,
        MAX(received_at) AS last_received_at
      FROM attachments
      WHERE COALESCE(property_slug, ?) = ?
      GROUP BY COALESCE(property_slug, ?)
      HAVING SUM(CASE WHEN status IN ('parsed', 'deferred') THEN 1 ELSE 0 END) > 0
    `).get(
      UNASSIGNED_PROPERTY_SLUG,
      UNASSIGNED_PROPERTY_NAME,
      UNASSIGNED_PROPERTY_SLUG,
      propertySlug,
      UNASSIGNED_PROPERTY_SLUG
    ) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  getPropertyAttachments(propertySlug: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT
        id,
        graph_message_id,
        graph_attachment_id,
        attachment_name,
        property_name,
        property_slug,
        status,
        report_type,
        report_title,
        report_date,
        parse_error,
        archived_path,
        quarantine_path,
        parsed_json_path,
        received_at
      FROM attachments
      WHERE COALESCE(property_slug, ?) = ?
      ORDER BY received_at DESC, id DESC
    `).all(UNASSIGNED_PROPERTY_SLUG, propertySlug) as Array<Record<string, unknown>>;
  }

  getAttachmentById(attachmentId: number): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT
        id,
        graph_message_id,
        graph_attachment_id,
        last_ingest_run_id,
        internet_message_id,
        source_mailbox,
        received_at,
        attachment_name,
        property_name,
        property_slug,
        extension,
        content_type,
        archived_path,
        quarantine_path,
        parse_error,
        parsed_json_path,
        status,
        report_type,
        report_title,
        report_date
      FROM attachments
      WHERE id = ?
    `).get(attachmentId) as Record<string, unknown> | undefined;

    return row ?? null;
  }

  deleteParsedReportsForAttachment(attachmentRecordId: number): void {
    this.db.exec("BEGIN");
    try {
      for (const reportType of Object.keys(REPORT_COLUMN_MAP)) {
        this.db.prepare(`
          DELETE FROM ${reportType}
          WHERE attachment_record_id = ?
        `).run(attachmentRecordId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearDerivedReportData(): void {
    this.db.exec("BEGIN");
    try {
      for (const reportType of Object.keys(REPORT_COLUMN_MAP)) {
        this.db.exec(`DELETE FROM ${reportType};`);
      }
      this.db.exec("DELETE FROM export_history;");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPropertyReportCounts(propertySlug: string): Array<Record<string, unknown>> {
    return this.db.prepare(`
      SELECT report_type, COUNT(*) AS attachment_count
      FROM attachments
      WHERE COALESCE(property_slug, ?) = ? AND report_type IS NOT NULL
      GROUP BY report_type
    `).all(UNASSIGNED_PROPERTY_SLUG, propertySlug) as Array<Record<string, unknown>>;
  }

  renameProperty(currentSlug: string, nextName: string, nextSlug: string): void {
    const now = new Date().toISOString();
    const oldSegment = `${path.sep}${currentSlug}${path.sep}`;
    const newSegment = `${path.sep}${nextSlug}${path.sep}`;

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE attachments
        SET property_name = ?,
            property_slug = ?,
            archived_path = CASE
              WHEN archived_path IS NULL THEN NULL
              ELSE REPLACE(archived_path, ?, ?)
            END,
            quarantine_path = CASE
              WHEN quarantine_path IS NULL THEN NULL
              ELSE REPLACE(quarantine_path, ?, ?)
            END,
            parsed_json_path = CASE
              WHEN parsed_json_path IS NULL THEN NULL
              ELSE REPLACE(parsed_json_path, ?, ?)
            END,
            updated_at = ?
        WHERE COALESCE(property_slug, ?) = ?
      `).run(
        nextName,
        nextSlug,
        oldSegment,
        newSegment,
        oldSegment,
        newSegment,
        oldSegment,
        newSegment,
        now,
        UNASSIGNED_PROPERTY_SLUG,
        currentSlug
      );

      this.db.prepare(`
        UPDATE export_history
        SET property_name = ?,
            property_slug = ?,
            csv_path = CASE
              WHEN csv_path IS NULL THEN NULL
              ELSE REPLACE(csv_path, ?, ?)
            END,
            latest_path = CASE
              WHEN latest_path IS NULL THEN NULL
              ELSE REPLACE(latest_path, ?, ?)
            END
        WHERE COALESCE(property_slug, ?) = ?
      `).run(
        nextName,
        nextSlug,
        oldSegment,
        newSegment,
        oldSegment,
        newSegment,
        UNASSIGNED_PROPERTY_SLUG,
        currentSlug
      );

      for (const reportType of Object.keys(REPORT_COLUMN_MAP)) {
        this.db.prepare(`
          UPDATE ${reportType}
          SET property_name = ?,
              property_slug = ?
          WHERE COALESCE(property_slug, ?) = ?
        `).run(nextName, nextSlug, UNASSIGNED_PROPERTY_SLUG, currentSlug);
      }

      this.db.prepare(`
        UPDATE netsuite_monetary_mappings
        SET property_slug = ?
        WHERE property_slug = ?
      `).run(nextSlug, currentSlug);

      this.db.prepare(`
        UPDATE netsuite_posting_defaults
        SET property_slug = ?
        WHERE property_slug = ?
      `).run(nextSlug, currentSlug);

      this.db.prepare(`
        UPDATE netsuite_posting_runs
        SET property_slug = ?,
            property_name = COALESCE(?, property_name)
        WHERE property_slug = ?
      `).run(nextSlug, nextName, currentSlug);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private getJsonState(key: string): Record<string, unknown> | null {
    const raw = this.getState(key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

function normalizeRowValue(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value);
}

function pickAttachmentUpdateValue<T extends keyof AttachmentUpdate>(
  input: AttachmentUpdate,
  key: T,
  fallback: string | number | null | undefined
): string | number | null {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? ((input[key] as string | number | null | undefined) ?? null)
    : (fallback ?? null);
}

function isSqliteDiskIoError(error: unknown): boolean {
  return error instanceof Error && /disk I\/O error/i.test(error.message);
}

async function archiveBrokenDatabase(databasePath: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidates = [
    databasePath,
    `${databasePath}-journal`,
    `${databasePath}-wal`,
    `${databasePath}-shm`
  ];

  for (const candidate of candidates) {
    try {
      await rename(candidate, `${candidate}.corrupt-${stamp}`);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function buildFallbackDatabasePath(databasePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const parsed = path.parse(databasePath);
  return path.join(parsed.dir, `${parsed.name}.recovery-${stamp}${parsed.ext}`);
}

function buildSqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function parseNotes(notes: unknown): string[] {
  if (typeof notes !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(notes);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function openInitializedDatabase(databasePath: string): AppDatabase {
  const database = new AppDatabase(databasePath);
  try {
    database.initialize();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

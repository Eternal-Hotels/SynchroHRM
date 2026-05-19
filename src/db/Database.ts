import { DatabaseSync } from "node:sqlite";
import { rename } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/files.js";
import type { ParsedReport, ReportType, RunSummary, TriggerSource } from "../types.js";
import { COMMON_EXPORT_COLUMNS, REPORT_COLUMN_MAP } from "../reports.js";
import { UNASSIGNED_PROPERTY_NAME, UNASSIGNED_PROPERTY_SLUG } from "../utils/properties.js";

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
  reportType?: ReportType | null;
  reportTitle?: string | null;
  reportDate?: string | null;
  parseError?: string | null;
  parsedJsonPath?: string | null;
  quarantinePath?: string | null;
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

  finishRun(runId: number, status: "completed" | "failed", summary: RunSummary): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ingest_runs
      SET status = ?,
          finished_at = ?,
          messages_seen = ?,
          attachments_seen = ?,
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
      summary.attachmentsArchived,
      summary.attachmentsParsed,
      summary.attachmentsDeferred,
      summary.attachmentsFailed,
      JSON.stringify(summary.notes),
      runId
    );
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
      notes: typeof run.notes === "string" ? JSON.parse(run.notes) : []
    };
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
      notes: typeof run.notes === "string" ? JSON.parse(run.notes) : []
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

  upsertMessage(message: {
    graphMessageId: string;
    internetMessageId: string | null;
    subject: string | null;
    receivedAt: string;
    webLink: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO messages (graph_message_id, internet_message_id, subject, received_at, web_link, has_attachments, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(graph_message_id) DO UPDATE SET
        internet_message_id = excluded.internet_message_id,
        subject = excluded.subject,
        received_at = excluded.received_at,
        web_link = excluded.web_link,
        last_seen_at = excluded.last_seen_at
    `).run(
      message.graphMessageId,
      message.internetMessageId,
      message.subject,
      message.receivedAt,
      message.webLink,
      now
    );
  }

  getAttachmentRecord(graphMessageId: string, graphAttachmentId: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT * FROM attachments WHERE graph_message_id = ? AND graph_attachment_id = ?
    `).get(graphMessageId, graphAttachmentId) as Record<string, unknown> | undefined;
    return row ?? null;
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
      input.status ?? current.status,
      input.propertyName ?? current.property_name ?? null,
      input.propertySlug ?? current.property_slug ?? null,
      input.reportType ?? current.report_type ?? null,
      input.reportTitle ?? current.report_title ?? null,
      input.reportDate ?? current.report_date ?? null,
      input.parseError ?? current.parse_error ?? null,
      input.parsedJsonPath ?? current.parsed_json_path ?? null,
      input.quarantinePath ?? current.quarantine_path ?? null,
      Number(current.last_ingest_run_id),
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
}

function normalizeRowValue(value: string | number | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value);
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

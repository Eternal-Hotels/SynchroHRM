import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../db/Database.js";
import { PdfReportParser, UnsupportedReportError, type PdfAnalysis } from "../parsers/pdfReportParser.js";
import type {
  IncomingAttachment,
  IngestionRunResult,
  MailAttachmentSource,
  RunSummary,
  TriggerSource
} from "../types.js";
import { parseLongDate } from "../utils/dates.js";
import { logger } from "../utils/logger.js";
import { ensureDir, movePathIfExists, pathExists, sanitizeFileName, writeBufferFile, writeTextFile } from "../utils/files.js";
import {
  ensurePropertyRef,
  normalizePropertyName,
  slugifyPropertyName,
  UNASSIGNED_PROPERTY_NAME,
  UNASSIGNED_PROPERTY_SLUG,
  type PropertyRef
} from "../utils/properties.js";
import { ExportService } from "./ExportService.js";

const DELTA_STATE_KEY = "graph.delta.inbox";

interface PreparedAttachment {
  attachment: IncomingAttachment;
  propertyName: string | null;
  propertySlug: string | null;
  reportTitle: string | null;
  reportDate: string | null;
  parsedReport: PdfAnalysis["parsedReport"];
  preparationError: Error | null;
}

interface PropertyMoveRequest {
  propertyName: string;
  propertySlug?: string | null;
}

interface AttachmentRetryResult {
  succeeded: boolean;
  message: string;
  propertySlug: string;
  attachment: Record<string, unknown>;
}

interface PropertyDirectoryMove {
  sourcePath: string;
  destinationPath: string;
}

interface ParsedPropertyRef {
  propertyName: string;
  propertySlug: string;
}

export class PropertyUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropertyUpdateError";
  }
}

export class AttachmentRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentRetryError";
  }
}

export class IngestionService {
  private readonly parser = new PdfReportParser();
  private readonly exportService: ExportService;
  private activeRun: Promise<IngestionRunResult> | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly source: MailAttachmentSource,
    private readonly dataDir: string
  ) {
    this.exportService = new ExportService(database, dataDir);
  }

  run(triggerSource: TriggerSource): Promise<IngestionRunResult> {
    if (this.activeRun) {
      return this.activeRun;
    }

    this.activeRun = this.runInternal(triggerSource).finally(() => {
      this.activeRun = null;
    });

    return this.activeRun;
  }

  getLatestExport(
    reportType: Parameters<ExportService["getLatestExport"]>[0],
    propertySlug?: Parameters<ExportService["getLatestExport"]>[1]
  ): Record<string, unknown> | null {
    return this.exportService.getLatestExport(reportType, propertySlug);
  }

  async retryAttachmentParse(attachmentId: number): Promise<AttachmentRetryResult> {
    if (this.activeRun) {
      throw new AttachmentRetryError("Please wait for the active inbox sync to finish before retrying a parse.");
    }

    const attachment = this.database.getAttachmentById(attachmentId);
    if (!attachment) {
      throw new AttachmentRetryError(`Attachment ${attachmentId} was not found.`);
    }

    const currentStatus = typeof attachment.status === "string" ? attachment.status : "";
    if (!["failed", "unsupported"].includes(currentStatus)) {
      throw new AttachmentRetryError("Only failed or unsupported PDF attachments can be retried.");
    }

    const archivedPath = typeof attachment.archived_path === "string" ? attachment.archived_path : null;
    if (!archivedPath || !(await pathExists(archivedPath))) {
      throw new AttachmentRetryError(`Archived file for attachment ${attachmentId} is unavailable.`);
    }

    const extension = typeof attachment.extension === "string"
      ? attachment.extension.toLowerCase()
      : path.extname(String(attachment.attachment_name ?? "")).toLowerCase();
    if (extension !== ".pdf") {
      throw new AttachmentRetryError("Only PDF attachments can be retried.");
    }

    const bytes = await readFile(archivedPath);
    const existingPropertyName = typeof attachment.property_name === "string" ? attachment.property_name : null;
    const existingPropertySlug = typeof attachment.property_slug === "string" ? attachment.property_slug : null;
    const fallbackProperty = parsePropertyFromAttachmentName(String(attachment.attachment_name ?? ""));
    const existingReportTitle = typeof attachment.report_title === "string" ? attachment.report_title : null;
    const existingReportDate = typeof attachment.report_date === "string" ? attachment.report_date : null;
    const propertyFromRecord = ensurePropertyRef({
      propertyName: existingPropertyName,
      propertySlug: existingPropertySlug
    });

    let analysis: PdfAnalysis | null = null;
    try {
      analysis = await this.parser.analyze(bytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.database.updateAttachment(attachmentId, {
        status: "failed",
        propertyName: propertyFromRecord.propertyName,
        propertySlug: propertyFromRecord.propertySlug,
        reportType: null,
        reportTitle: existingReportTitle,
        reportDate: existingReportDate,
        parsedJsonPath: null,
        parseError: reason
      });
      return {
        succeeded: false,
        message: `Retry failed for ${String(attachment.attachment_name ?? `attachment ${attachmentId}`)}: ${reason}`,
        propertySlug: propertyFromRecord.propertySlug,
        attachment: this.database.getAttachmentById(attachmentId) ?? attachment
      };
    }

    const property = ensurePropertyRef({
      propertyName: existingPropertyName && existingPropertyName !== UNASSIGNED_PROPERTY_NAME
        ? existingPropertyName
        : (analysis.propertyName ?? fallbackProperty?.propertyName ?? null),
      propertySlug: existingPropertySlug && existingPropertySlug !== UNASSIGNED_PROPERTY_SLUG
        ? existingPropertySlug
        : (analysis.propertySlug ?? fallbackProperty?.propertySlug ?? null)
    });
    const reportTitle = analysis.reportTitle ?? existingReportTitle;
    const reportDate = resolveAttachmentReportDate(
      String(attachment.attachment_name ?? ""),
      analysis.parsedReport?.reportDate ?? analysis.reportDate ?? existingReportDate
    );

    if (!analysis.parsedReport) {
      const reason = analysis.error?.message ?? "The PDF title does not match any known report family.";
      this.database.updateAttachment(attachmentId, {
        status: analysis.error instanceof UnsupportedReportError ? "unsupported" : "failed",
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        reportType: null,
        reportTitle,
        reportDate,
        parsedJsonPath: null,
        parseError: reason
      });
      return {
        succeeded: false,
        message: `Retry still needs parser support for ${String(attachment.attachment_name ?? `attachment ${attachmentId}`)}.`,
        propertySlug: property.propertySlug,
        attachment: this.database.getAttachmentById(attachmentId) ?? attachment
      };
    }

    const parsedReport = {
      ...analysis.parsedReport,
      reportDate,
      propertyName: property.propertyName,
      propertySlug: property.propertySlug
    };
    const parsedJsonPath = path.join(
      this.dataDir,
      "parsed",
      property.propertySlug,
      parsedReport.reportType,
      `${sanitizeFileName(String(attachment.graph_message_id ?? ""))}_${sanitizeFileName(String(attachment.attachment_name ?? ""))}.json`
    );
    await writeTextFile(parsedJsonPath, `${JSON.stringify(parsedReport, null, 2)}\n`);

    this.database.deleteParsedReportsForAttachment(attachmentId);
    this.database.insertParsedReport(
      Number(attachment.last_ingest_run_id),
      attachmentId,
      {
        sourceMailbox: String(attachment.source_mailbox ?? ""),
        graphMessageId: String(attachment.graph_message_id ?? ""),
        internetMessageId: typeof attachment.internet_message_id === "string" ? attachment.internet_message_id : null,
        receivedAt: String(attachment.received_at ?? ""),
        attachmentId: String(attachment.graph_attachment_id ?? ""),
        attachmentName: String(attachment.attachment_name ?? ""),
        propertyName: property.propertyName,
        propertySlug: property.propertySlug
      },
      parsedReport
    );

    this.database.updateAttachment(attachmentId, {
      status: "parsed",
      propertyName: property.propertyName,
      propertySlug: property.propertySlug,
      reportType: parsedReport.reportType,
      reportTitle: parsedReport.reportTitle,
      reportDate: parsedReport.reportDate,
      parsedJsonPath,
      parseError: null,
      quarantinePath: null
    });
    await this.exportService.refreshLatestExports(property.propertySlug);

    return {
      succeeded: true,
      message: `Retry parsed ${String(attachment.attachment_name ?? `attachment ${attachmentId}`)} successfully.`,
      propertySlug: property.propertySlug,
      attachment: this.database.getAttachmentById(attachmentId) ?? attachment
    };
  }

  async updateProperty(currentSlug: string, input: PropertyMoveRequest): Promise<Record<string, unknown>> {
    if (this.activeRun) {
      throw new PropertyUpdateError("Please wait for the active inbox sync to finish before editing a property.");
    }

    const current = this.database.getPropertySummary(currentSlug);
    if (!current) {
      throw new PropertyUpdateError(`Property ${currentSlug} was not found.`);
    }

    const nextName = normalizePropertyName(input.propertyName);
    if (!nextName) {
      throw new PropertyUpdateError("Property name is required.");
    }

    const requestedSlug = normalizePropertyName(input.propertySlug ?? null);
    const nextSlug = slugifyPropertyName(requestedSlug || nextName);
    if (!nextSlug) {
      throw new PropertyUpdateError("Property folder slug could not be generated from the values you entered.");
    }

    if (nextSlug !== currentSlug && this.database.getPropertySummary(nextSlug)) {
      throw new PropertyUpdateError(`The folder slug ${nextSlug} is already assigned to another property.`);
    }

    const moves = await this.collectPropertyMoves(currentSlug, nextSlug);
    const completedMoves: PropertyDirectoryMove[] = [];
    let propertyCommitted = false;

    try {
      for (const move of moves) {
        const moved = await movePathIfExists(move.sourcePath, move.destinationPath);
        if (moved) {
          completedMoves.push(move);
        }
      }

      this.database.renameProperty(currentSlug, nextName, nextSlug);
      propertyCommitted = true;
      try {
        await this.exportService.refreshLatestExports(nextSlug);
      } catch (error) {
        logger.error("Property rename completed but export refresh failed", {
          propertySlug: nextSlug,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return this.database.getPropertySummary(nextSlug) ?? {
        property_name: nextName,
        property_slug: nextSlug
      };
    } catch (error) {
      if (propertyCommitted) {
        throw error;
      }

      for (const move of completedMoves.reverse()) {
        try {
          await movePathIfExists(move.destinationPath, move.sourcePath);
        } catch {
          logger.error("Failed to roll back property folder rename", {
            from: move.destinationPath,
            to: move.sourcePath
          });
        }
      }

      throw error;
    }
  }

  private async runInternal(triggerSource: TriggerSource): Promise<IngestionRunResult> {
    await Promise.all([
      ensureDir(path.join(this.dataDir, "raw")),
      ensureDir(path.join(this.dataDir, "quarantine")),
      ensureDir(path.join(this.dataDir, "parsed"))
    ]);

    const runId = this.database.createRun(triggerSource);
    const summary: RunSummary = {
      messagesSeen: 0,
      attachmentsSeen: 0,
      attachmentsArchived: 0,
      attachmentsParsed: 0,
      attachmentsDeferred: 0,
      attachmentsFailed: 0,
      notes: []
    };

    try {
      const deltaToken = this.database.getState(DELTA_STATE_KEY);
      const pulled = await this.source.pullAttachments(deltaToken);
      summary.messagesSeen = pulled.messagesSeen;
      if (pulled.deltaWasReset) {
        summary.notes.push("Microsoft Graph delta token was reset and a full Inbox scan was retried.");
      }

      const preparedAttachments = await this.prepareAttachments(pulled.attachments);

      for (const prepared of preparedAttachments) {
        const attachment = prepared.attachment;
        summary.attachmentsSeen += 1;
        this.database.upsertMessage({
          graphMessageId: attachment.message.graphMessageId,
          internetMessageId: attachment.message.internetMessageId,
          subject: attachment.message.subject,
          receivedAt: attachment.message.receivedAt,
          webLink: attachment.message.webLink
        });

        const existing = this.database.getAttachmentRecord(attachment.message.graphMessageId, attachment.attachmentId);
        if (existing) {
          summary.notes.push(`Skipped duplicate attachment ${attachment.attachmentName} (${attachment.attachmentId}).`);
          continue;
        }

        await this.processAttachment(runId, summary, prepared);
      }

      if (pulled.nextDeltaToken) {
        this.database.setState(DELTA_STATE_KEY, pulled.nextDeltaToken);
      }

      const exports = await this.exportService.exportRun(runId);
      this.database.finishRun(runId, "completed", summary);

      return {
        runId,
        status: "completed",
        summary,
        exports
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.notes.push(`Run failed: ${message}`);
      this.database.finishRun(runId, "failed", summary);
      logger.error("Ingestion run failed", { runId, error: message });
      return {
        runId,
        status: "failed",
        summary,
        exports: []
      };
    }
  }

  private async processAttachment(runId: number, summary: RunSummary, prepared: PreparedAttachment): Promise<void> {
    const { attachment } = prepared;
    const property = ensurePropertyRef(prepared);
    const resolvedReportDate = resolveAttachmentReportDate(
      attachment.attachmentName,
      prepared.parsedReport?.reportDate ?? prepared.reportDate
    );
    const archivedPath = await this.archiveAttachment(attachment, property);
    const extension = path.extname(attachment.attachmentName).toLowerCase();
    const recordId = this.database.insertAttachment({
      graphMessageId: attachment.message.graphMessageId,
      graphAttachmentId: attachment.attachmentId,
      ingestRunId: runId,
      internetMessageId: attachment.message.internetMessageId,
      sourceMailbox: attachment.sourceMailbox,
      receivedAt: attachment.message.receivedAt,
      attachmentName: attachment.attachmentName,
      propertyName: property.propertyName,
      propertySlug: property.propertySlug,
      extension,
      contentType: attachment.contentType,
      archivedPath,
      status: "archived"
    });
    summary.attachmentsArchived += 1;

    if (extension === ".xlsx") {
      this.database.updateAttachment(recordId, {
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        status: "deferred",
        reportTitle: prepared.reportTitle,
        reportDate: resolvedReportDate,
        parseError: "XLSX parsing is intentionally deferred in v1."
      });
      summary.attachmentsDeferred += 1;
      return;
    }

    try {
      if (!prepared.parsedReport) {
        throw prepared.preparationError ?? new UnsupportedReportError("The PDF title does not match any known report family.");
      }

      const parsedReport = {
        ...prepared.parsedReport,
        reportDate: resolvedReportDate
      };
      const parsedJsonPath = path.join(
        this.dataDir,
        "parsed",
        property.propertySlug,
        parsedReport.reportType,
        `${sanitizeFileName(attachment.message.graphMessageId)}_${sanitizeFileName(attachment.attachmentName)}.json`
      );
      await writeTextFile(parsedJsonPath, `${JSON.stringify(parsedReport, null, 2)}\n`);

      this.database.insertParsedReport(
        runId,
        recordId,
        {
          sourceMailbox: attachment.sourceMailbox,
          graphMessageId: attachment.message.graphMessageId,
          internetMessageId: attachment.message.internetMessageId,
          receivedAt: attachment.message.receivedAt,
          attachmentId: attachment.attachmentId,
          attachmentName: attachment.attachmentName,
          propertyName: property.propertyName,
          propertySlug: property.propertySlug
        },
        parsedReport
      );

      this.database.updateAttachment(recordId, {
        status: "parsed",
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        reportType: parsedReport.reportType,
        reportTitle: parsedReport.reportTitle,
        reportDate: resolvedReportDate,
        parsedJsonPath
      });
      summary.attachmentsParsed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const quarantineReason = error instanceof UnsupportedReportError ? "unsupported" : "failed";
      const quarantinePath = path.join(
        this.dataDir,
        "quarantine",
        quarantineReason,
        property.propertySlug,
        `${sanitizeFileName(attachment.message.graphMessageId)}_${sanitizeFileName(attachment.attachmentName)}`
      );
      await writeBufferFile(quarantinePath, attachment.bytes);
      this.database.updateAttachment(recordId, {
        status: quarantineReason,
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        reportTitle: prepared.reportTitle,
        reportDate: resolvedReportDate,
        parseError: reason,
        quarantinePath
      });
      summary.attachmentsFailed += 1;
      summary.notes.push(`Attachment ${attachment.attachmentName} ${quarantineReason}: ${reason}`);
    }
  }

  private async archiveAttachment(attachment: IncomingAttachment, property: PropertyRef): Promise<string> {
    const receivedDay = attachment.message.receivedAt.slice(0, 10);
    const resolved = ensurePropertyRef(property);
    const archivePath = path.join(
      this.dataDir,
      "raw",
      resolved.propertySlug,
      receivedDay,
      `${sanitizeFileName(attachment.message.graphMessageId)}_${sanitizeFileName(attachment.attachmentName)}`
    );
    await writeBufferFile(archivePath, attachment.bytes);
    return archivePath;
  }

  private async prepareAttachments(attachments: IncomingAttachment[]): Promise<PreparedAttachment[]> {
    const prepared = await Promise.all(attachments.map(async (attachment) => {
      const extension = path.extname(attachment.attachmentName).toLowerCase();
      if (extension !== ".pdf") {
        return {
          attachment,
          propertyName: null,
          propertySlug: null,
          reportTitle: null,
          reportDate: null,
          parsedReport: null,
          preparationError: null
        } satisfies PreparedAttachment;
      }

      try {
        const analysis = await this.parser.analyze(attachment.bytes);
        const fallbackProperty = parsePropertyFromAttachmentName(attachment.attachmentName);
        return {
          attachment,
          propertyName: analysis.propertyName ?? fallbackProperty?.propertyName ?? null,
          propertySlug: analysis.propertySlug ?? fallbackProperty?.propertySlug ?? null,
          reportTitle: analysis.reportTitle,
          reportDate: analysis.reportDate,
          parsedReport: analysis.parsedReport,
          preparationError: analysis.error
        } satisfies PreparedAttachment;
      } catch (error) {
        return {
          attachment,
          propertyName: null,
          propertySlug: null,
          reportTitle: null,
          reportDate: null,
          parsedReport: null,
          preparationError: error instanceof Error ? error : new Error(String(error))
        } satisfies PreparedAttachment;
      }
    }));

    const dominantProperty = determineDominantProperty(prepared);
    if (!dominantProperty) {
      return prepared;
    }

    return prepared.map((entry) => (
      entry.propertySlug
        ? entry
        : {
            ...entry,
            propertyName: dominantProperty.propertyName,
            propertySlug: dominantProperty.propertySlug
          }
    ));
  }

  private async collectPropertyMoves(currentSlug: string, nextSlug: string): Promise<PropertyDirectoryMove[]> {
    if (currentSlug === nextSlug) {
      return [];
    }

    const candidates: PropertyDirectoryMove[] = [
      {
        sourcePath: path.join(this.dataDir, "raw", currentSlug),
        destinationPath: path.join(this.dataDir, "raw", nextSlug)
      },
      {
        sourcePath: path.join(this.dataDir, "parsed", currentSlug),
        destinationPath: path.join(this.dataDir, "parsed", nextSlug)
      },
      {
        sourcePath: path.join(this.dataDir, "exports", "properties", currentSlug),
        destinationPath: path.join(this.dataDir, "exports", "properties", nextSlug)
      }
    ];

    const quarantineDir = path.join(this.dataDir, "quarantine");
    if (await pathExists(quarantineDir)) {
      for (const reason of await readdir(quarantineDir)) {
        candidates.push({
          sourcePath: path.join(quarantineDir, reason, currentSlug),
          destinationPath: path.join(quarantineDir, reason, nextSlug)
        });
      }
    }

    const moves: PropertyDirectoryMove[] = [];
    for (const candidate of candidates) {
      if (!(await pathExists(candidate.sourcePath))) {
        continue;
      }
      if (await pathExists(candidate.destinationPath)) {
        throw new PropertyUpdateError(`The destination folder already exists: ${candidate.destinationPath}`);
      }
      moves.push(candidate);
    }

    return moves;
  }
}

function determineDominantProperty(attachments: PreparedAttachment[]): { propertyName: string; propertySlug: string } | null {
  const counts = new Map<string, { propertyName: string; propertySlug: string; count: number }>();

  for (const attachment of attachments) {
    const propertyName = attachment.propertyName;
    const propertySlug = attachment.propertySlug;
    if (!propertyName || !propertySlug) {
      continue;
    }

    const current = counts.get(propertySlug);
    if (current) {
      current.count += 1;
      continue;
    }

    counts.set(propertySlug, { propertyName, propertySlug, count: 1 });
  }

  return Array.from(counts.values()).sort((left, right) => right.count - left.count)[0] ?? null;
}

function resolveAttachmentReportDate(attachmentName: string, parsedReportDate: string | null): string | null {
  const fileDate = parseDateFromAttachmentName(attachmentName);

  // PDTOR packets are keyed operationally by the attachment date label.
  if (fileDate && /-PDTOR-/i.test(attachmentName)) {
    return fileDate;
  }

  return parsedReportDate ?? fileDate;
}

function parseDateFromAttachmentName(attachmentName: string): string | null {
  const match = attachmentName.match(/^([A-Za-z]+\s+\d{1,2},\s+\d{4})-/);
  if (!match) {
    return null;
  }

  return parseLongDate(match[1]);
}

function parsePropertyFromAttachmentName(attachmentName: string): ParsedPropertyRef | null {
  if (!attachmentName) {
    return null;
  }

  const fileStem = attachmentName
    .replace(/\.[^.]+$/, "")
    .replace(/_/g, " ")
    .trim();

  const afterCode = fileStem.match(/^.+?-[A-Z0-9]{4,8}-(.+)$/)?.[1] ?? fileStem;
  const withoutSuffix = afterCode.replace(
    /-(?:authorized-payments|breakfast-and-packages|departures-list|house-account-balances|maintenance-activity|no-show|room-count-summary|all-transactions|arrivals|direct-bill-aging|final-audit|hotel-statistics|housekeeping-sheet|rate-override)$/i,
    ""
  );
  const spaced = withoutSuffix.replace(/([a-z])([A-Z])/g, "$1 $2");
  const propertyName = normalizePropertyName(spaced);
  const propertySlug = slugifyPropertyName(propertyName);

  if (!propertyName || !propertySlug) {
    return null;
  }

  return { propertyName, propertySlug };
}

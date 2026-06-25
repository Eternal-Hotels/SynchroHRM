import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { AppDatabase } from "../db/Database.js";
import { PdfReportParser, UnsupportedReportError } from "../parsers/pdfReportParser.js";
import { WorkbookReportParser } from "../parsers/workbookReportParser.js";
import type {
  IncomingAttachment,
  IngestionRunResult,
  MailAttachmentSource,
  ParsedReport,
  RunSummary,
  TriggerSource
} from "../types.js";
import { parseLongDate } from "../utils/dates.js";
import { logger } from "../utils/logger.js";
import {
  ensureDir,
  movePathIfExists,
  pathExists,
  remapStoredDataPath,
  sanitizeFileName,
  writeBufferFile,
  writeTextFile
} from "../utils/files.js";
import { isSenderApproved, validateApprovedSenderPatterns } from "../utils/approvedSenders.js";
import {
  derivePropertyRefFromAttachmentName,
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
  parsedReport: ParsedReport | null;
  preparationError: Error | null;
}

interface AttachmentAnalysis {
  propertyName: string | null;
  propertySlug: string | null;
  reportDate: string | null;
  reportTitle: string | null;
  parsedReport: ParsedReport | null;
  error: Error | null;
}

interface PropertyMoveRequest {
  propertyName: string;
  propertySlug?: string | null;
}

interface IngestionRunOptions {
  fullRescan?: boolean;
}

interface StoredWorkbookRepairOptions {
  propertySlug?: string | null;
  attachmentNameIncludes?: string | null;
}

interface ActiveRunState {
  runId: number;
  triggerSource: TriggerSource;
  promise: Promise<IngestionRunResult>;
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

export class ReparseOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReparseOperationError";
  }
}

export class IngestionOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionOperationError";
  }
}

export class IngestionService {
  private readonly parser = new PdfReportParser();
  private readonly workbookParser = new WorkbookReportParser();
  private readonly exportService: ExportService;
  private activeRun: ActiveRunState | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly source: MailAttachmentSource,
    private readonly dataDir: string,
    private readonly defaultApprovedSenderPatterns: string[] = []
  ) {
    this.exportService = new ExportService(database, dataDir);
  }

  getApprovedSenderPatterns(): { patterns: string[]; source: "database" | "default" } {
    const persistedPatterns = this.database.getApprovedSenderPatterns();
    if (persistedPatterns !== null) {
      return {
        patterns: persistedPatterns,
        source: "database"
      };
    }

    return {
      patterns: this.defaultApprovedSenderPatterns,
      source: "default"
    };
  }

  updateApprovedSenderPatterns(patterns: string[]): string[] {
    const validated = validateApprovedSenderPatterns(patterns);
    if (validated.invalid.length > 0) {
      throw new PropertyUpdateError(`Invalid sender patterns: ${validated.invalid.join(", ")}`);
    }

    this.database.setApprovedSenderPatterns(validated.valid);
    return validated.valid;
  }

  run(triggerSource: TriggerSource, options: IngestionRunOptions = {}): Promise<IngestionRunResult> {
    if (this.activeRun) {
      return this.activeRun.promise;
    }

    return this.startExclusiveRun(
      triggerSource,
      (runId) => this.runInternal(runId, triggerSource, options)
    ).promise;
  }

  startManualRun(options: IngestionRunOptions = {}): { runId: number; status: "running"; triggerSource: "manual" } {
    if (this.activeRun) {
      throw new IngestionOperationError("Please wait for the active inbox sync to finish before starting another mailbox scan.");
    }

    const activeRun = this.startExclusiveRun("manual", (runId) => this.runInternal(runId, "manual", options));
    return {
      runId: activeRun.runId,
      status: "running",
      triggerSource: "manual"
    };
  }

  startReparseRun(): { runId: number; status: "running"; triggerSource: "reparse" } {
    const activeRun = this.startStoredReportReparse();
    return {
      runId: activeRun.runId,
      status: "running",
      triggerSource: "reparse"
    };
  }

  getActiveRunId(): number | null {
    return this.activeRun?.runId ?? null;
  }

  isRunActive(runId: number): boolean {
    return this.activeRun?.runId === runId;
  }

  getLatestExport(
    reportType: Parameters<ExportService["getLatestExport"]>[0],
    propertySlug?: Parameters<ExportService["getLatestExport"]>[1]
  ): Record<string, unknown> | null {
    return this.exportService.getLatestExport(reportType, propertySlug);
  }

  async reparseStoredReports(): Promise<IngestionRunResult> {
    return this.startStoredReportReparse().promise;
  }

  async repairStoredWorkbookAttachments(options: StoredWorkbookRepairOptions = {}): Promise<IngestionRunResult> {
    return this.startStoredWorkbookRepair(options).promise;
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

    const archivedPath = await this.resolveArchivedRawPath(attachmentId, attachment.archived_path);
    if (!archivedPath) {
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
    const fallbackProperty = derivePropertyRefFromAttachmentName(String(attachment.attachment_name ?? ""));
    const existingReportTitle = typeof attachment.report_title === "string" ? attachment.report_title : null;
    const existingReportDate = typeof attachment.report_date === "string" ? attachment.report_date : null;
    const propertyFromRecord = ensurePropertyRef({
      propertyName: existingPropertyName,
      propertySlug: existingPropertySlug
    });

    let analysis: AttachmentAnalysis | null = null;
    try {
      analysis = await this.analyzeAttachment(bytes, extension);
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

    if (!analysis) {
      throw new AttachmentRetryError("Only PDF and XLSX attachments can be retried.");
    }

    const property = resolveReprocessedPropertyRef(
      extension,
      {
        propertyName: analysis.propertyName,
        propertySlug: analysis.propertySlug
      },
      {
        propertyName: existingPropertyName,
        propertySlug: existingPropertySlug
      },
      fallbackProperty
    );
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
      buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), String(attachment.attachment_name ?? ""), ".json")
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

  private startExclusiveRun(
    triggerSource: TriggerSource,
    execute: (runId: number) => Promise<IngestionRunResult>
  ): ActiveRunState {
    const runId = this.database.createRun(triggerSource);
    const promise = execute(runId).finally(() => {
      if (this.activeRun?.runId === runId) {
        this.activeRun = null;
      }
    });
    const activeRun = {
      runId,
      triggerSource,
      promise
    } satisfies ActiveRunState;
    this.activeRun = activeRun;
    return activeRun;
  }

  private startStoredReportReparse(): ActiveRunState {
    if (this.activeRun) {
      throw new ReparseOperationError("Please wait for the active ingestion run to finish before reparsing stored reports.");
    }

    return this.startExclusiveRun("reparse", (runId) => this.reparseStoredReportsInternal(runId));
  }

  private startStoredWorkbookRepair(options: StoredWorkbookRepairOptions): ActiveRunState {
    if (this.activeRun) {
      throw new ReparseOperationError("Please wait for the active ingestion run to finish before repairing stored workbook attachments.");
    }

    return this.startExclusiveRun("reparse", (runId) => this.repairStoredWorkbookAttachmentsInternal(runId, options));
  }

  private persistRunProgress(runId: number, summary: RunSummary): void {
    this.database.updateRunProgress(runId, summary);
  }

  private async pullAndProcessAttachments(
    runId: number,
    summary: RunSummary,
    approvedSenderPatterns: string[],
    deltaToken: string | null
  ): Promise<{ nextDeltaToken: string | null; deltaWasReset: boolean; messagesSeen: number }> {
    if (typeof this.source.scanAttachments === "function") {
      return this.source.scanAttachments(deltaToken, async (attachments, progress) => {
        summary.messagesSeen = progress.messagesSeen;
        await this.processIncomingAttachments(runId, summary, approvedSenderPatterns, attachments);
      });
    }

    const pulled = await this.source.pullAttachments(deltaToken);
    summary.messagesSeen = pulled.messagesSeen;
    await this.processIncomingAttachments(runId, summary, approvedSenderPatterns, pulled.attachments);
    return pulled;
  }

  private async processIncomingAttachments(
    runId: number,
    summary: RunSummary,
    approvedSenderPatterns: string[],
    attachments: IncomingAttachment[]
  ): Promise<void> {
    if (attachments.length === 0) {
      this.persistRunProgress(runId, summary);
      return;
    }

    summary.attachmentsSeen += attachments.length;
    const attachmentsFromApprovedSenders = this.filterAttachmentsByApprovedSender(
      attachments,
      approvedSenderPatterns,
      summary
    );
    this.persistRunProgress(runId, summary);

    if (attachmentsFromApprovedSenders.length === 0) {
      return;
    }

    const preparedAttachments = await this.prepareAttachments(attachmentsFromApprovedSenders);

    for (const prepared of preparedAttachments) {
      const attachment = prepared.attachment;
      this.database.upsertMessage({
        graphMessageId: attachment.message.graphMessageId,
        internetMessageId: attachment.message.internetMessageId,
        subject: attachment.message.subject,
        senderEmail: attachment.message.senderEmail,
        receivedAt: attachment.message.receivedAt,
        webLink: attachment.message.webLink
      });

      const existing = this.database.getAttachmentRecord(attachment.message.graphMessageId, attachment.attachmentId);
      if (existing) {
        summary.notes.push(`Skipped duplicate attachment ${attachment.attachmentName} (${attachment.attachmentId}).`);
        this.persistRunProgress(runId, summary);
        continue;
      }

      await this.processAttachment(runId, summary, prepared);
      this.persistRunProgress(runId, summary);
    }
  }

  private async runInternal(runId: number, triggerSource: TriggerSource, options: IngestionRunOptions): Promise<IngestionRunResult> {
    const summary: RunSummary = {
      messagesSeen: 0,
      attachmentsSeen: 0,
      attachmentsApproved: 0,
      attachmentsNotApproved: 0,
      attachmentsArchived: 0,
      attachmentsParsed: 0,
      attachmentsDeferred: 0,
      attachmentsFailed: 0,
      notes: []
    };

    try {
      await Promise.all([
        ensureDir(path.join(this.dataDir, "raw")),
        ensureDir(path.join(this.dataDir, "quarantine")),
        ensureDir(path.join(this.dataDir, "parsed"))
      ]);

      const storedDeltaToken = this.database.getState(DELTA_STATE_KEY);
      const fullRescan = options.fullRescan ?? triggerSource === "manual";
      const deltaToken = fullRescan ? null : storedDeltaToken;
      if (fullRescan) {
        summary.notes.push(
          storedDeltaToken
            ? "Manual run ignored the saved Microsoft Graph delta token and performed a full Inbox scan."
            : "Manual run performed a full Inbox scan because no Graph delta token was saved yet."
        );
      }
      const approvedSenderPatterns = this.getApprovedSenderPatterns().patterns;
      const pulled = await this.pullAndProcessAttachments(runId, summary, approvedSenderPatterns, deltaToken);
      summary.messagesSeen = pulled.messagesSeen;
      if (pulled.deltaWasReset) {
        summary.notes.push("Microsoft Graph delta token was reset and a full Inbox scan was retried.");
      }
      this.persistRunProgress(runId, summary);

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

  private async reparseStoredReportsInternal(runId: number): Promise<IngestionRunResult> {
    const summary: RunSummary = {
      messagesSeen: 0,
      attachmentsSeen: 0,
      attachmentsApproved: 0,
      attachmentsNotApproved: 0,
      attachmentsArchived: 0,
      attachmentsParsed: 0,
      attachmentsDeferred: 0,
      attachmentsFailed: 0,
      notes: []
    };

    try {
      await Promise.all([
        ensureDir(path.join(this.dataDir, "raw")),
        ensureDir(path.join(this.dataDir, "quarantine")),
        ensureDir(path.join(this.dataDir, "parsed"))
      ]);

      const attachments = this.database.listAttachmentsForReparse();
      summary.messagesSeen = attachments.length;
      summary.attachmentsSeen = attachments.length;
      summary.attachmentsApproved = attachments.length;
      this.persistRunProgress(runId, summary);

      await this.resetGeneratedArtifacts();
      this.database.clearDerivedReportData();

      if (attachments.length === 0) {
        summary.notes.push("No archived attachments were available under storage/raw to reparse.");
      }

      for (const attachment of attachments) {
        await this.reparseAttachment(runId, summary, attachment);
        this.persistRunProgress(runId, summary);
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
      summary.notes.push(`Reparse failed: ${message}`);
      this.database.finishRun(runId, "failed", summary);
      logger.error("Stored report reparse failed", { runId, error: message });
      return {
        runId,
        status: "failed",
        summary,
        exports: []
      };
    }
  }

  private async repairStoredWorkbookAttachmentsInternal(
    runId: number,
    options: StoredWorkbookRepairOptions
  ): Promise<IngestionRunResult> {
    const summary: RunSummary = {
      messagesSeen: 0,
      attachmentsSeen: 0,
      attachmentsApproved: 0,
      attachmentsNotApproved: 0,
      attachmentsArchived: 0,
      attachmentsParsed: 0,
      attachmentsDeferred: 0,
      attachmentsFailed: 0,
      notes: []
    };

    try {
      await Promise.all([
        ensureDir(path.join(this.dataDir, "raw")),
        ensureDir(path.join(this.dataDir, "quarantine")),
        ensureDir(path.join(this.dataDir, "parsed"))
      ]);

      const attachments = this.filterStoredWorkbookAttachments(
        this.database.listAttachmentsForReparse(),
        options
      );
      summary.messagesSeen = attachments.length;
      summary.attachmentsSeen = attachments.length;
      summary.attachmentsApproved = attachments.length;
      this.persistRunProgress(runId, summary);

      if (attachments.length === 0) {
        summary.notes.push("No stored workbook attachments matched the requested repair filter.");
      }

      for (const attachment of attachments) {
        await this.reparseAttachment(runId, summary, attachment);
        this.persistRunProgress(runId, summary);
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
      summary.notes.push(`Workbook repair failed: ${message}`);
      this.database.finishRun(runId, "failed", summary);
      logger.error("Stored workbook repair failed", { runId, error: message });
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

    try {
      if (extension === ".xlsx" && prepared.preparationError && !(prepared.preparationError instanceof UnsupportedReportError)) {
        throw prepared.preparationError;
      }

      if (extension === ".xlsx" && !prepared.parsedReport) {
        this.database.updateAttachment(recordId, {
          propertyName: property.propertyName,
          propertySlug: property.propertySlug,
          status: "deferred",
          reportTitle: prepared.reportTitle,
          reportDate: resolvedReportDate,
          parseError: prepared.preparationError?.message ?? "Workbook parsing is not supported for this XLSX family yet."
        });
        summary.attachmentsDeferred += 1;
        return;
      }

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
        buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName, ".json")
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
        buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName)
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

  private async analyzeAttachment(bytes: Buffer, extension: string): Promise<AttachmentAnalysis | null> {
    if (extension === ".pdf") {
      return this.parser.analyze(bytes);
    }
    if (extension === ".xlsx") {
      return this.workbookParser.analyze(bytes);
    }

    return null;
  }

  private async archiveAttachment(attachment: IncomingAttachment, property: PropertyRef): Promise<string> {
    const receivedDay = attachment.message.receivedAt.slice(0, 10);
    const resolved = ensurePropertyRef(property);
    const archivePath = path.join(
      this.dataDir,
      "raw",
      resolved.propertySlug,
      receivedDay,
      buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName)
    );
    await writeBufferFile(archivePath, attachment.bytes);
    return archivePath;
  }

  private async prepareAttachments(attachments: IncomingAttachment[]): Promise<PreparedAttachment[]> {
    const prepared = await Promise.all(attachments.map(async (attachment) => {
      const extension = path.extname(attachment.attachmentName).toLowerCase();
      if (![".pdf", ".xlsx"].includes(extension)) {
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
        const analysis = await this.analyzeAttachment(attachment.bytes, extension);
        if (!analysis) {
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

        const fallbackProperty = derivePropertyRefFromAttachmentName(attachment.attachmentName);
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

  private filterStoredWorkbookAttachments(
    attachments: Array<Record<string, unknown>>,
    options: StoredWorkbookRepairOptions
  ): Array<Record<string, unknown>> {
    const propertySlugFilter = normalizePropertyName(options.propertySlug ?? null)?.toLowerCase() ?? null;
    const attachmentNameFilter = normalizePropertyName(options.attachmentNameIncludes ?? null)?.toLowerCase() ?? null;

    return attachments.filter((attachment) => {
      const extension = String(attachment.extension ?? path.extname(String(attachment.attachment_name ?? ""))).toLowerCase();
      if (extension !== ".xlsx") {
        return false;
      }

      if (propertySlugFilter) {
        const currentSlug = normalizePropertyName(typeof attachment.property_slug === "string" ? attachment.property_slug : null)?.toLowerCase() ?? "";
        if (currentSlug !== propertySlugFilter) {
          return false;
        }
      }

      if (attachmentNameFilter) {
        const attachmentName = String(attachment.attachment_name ?? "").toLowerCase();
        if (!attachmentName.includes(attachmentNameFilter)) {
          return false;
        }
      }

      return true;
    });
  }

  private filterAttachmentsByApprovedSender(
    attachments: IncomingAttachment[],
    approvedSenderPatterns: string[],
    summary: RunSummary
  ): IncomingAttachment[] {
    if (approvedSenderPatterns.length === 0) {
      summary.attachmentsApproved += attachments.length;
      return attachments;
    }

    const allowed: IncomingAttachment[] = [];
    for (const attachment of attachments) {
      if (isSenderApproved(attachment.message.senderEmail, approvedSenderPatterns)) {
        summary.attachmentsApproved += 1;
        allowed.push(attachment);
        continue;
      }

      summary.attachmentsNotApproved += 1;
      summary.notes.push(
        `Skipped attachment ${attachment.attachmentName} from unapproved sender ${attachment.message.senderEmail ?? "unknown"}.`
      );
    }

    return allowed;
  }

  private async reparseAttachment(
    runId: number,
    summary: RunSummary,
    attachment: Record<string, unknown>
  ): Promise<void> {
    const attachmentId = Number(attachment.id);
    const attachmentName = String(attachment.attachment_name ?? "");
    const extension = String(attachment.extension ?? path.extname(attachmentName)).toLowerCase();
    const existingPropertyName = typeof attachment.property_name === "string" ? attachment.property_name : null;
    const existingPropertySlug = typeof attachment.property_slug === "string" ? attachment.property_slug : null;
    const fallbackProperty = derivePropertyRefFromAttachmentName(attachmentName);
    const property = ensurePropertyRef({
      propertyName: existingPropertyName,
      propertySlug: existingPropertySlug
    });
    const reportDate = resolveAttachmentReportDate(
      attachmentName,
      typeof attachment.report_date === "string" ? attachment.report_date : null
    );

    this.database.deleteParsedReportsForAttachment(attachmentId);

    const archivedPath = await this.resolveArchivedRawPath(attachmentId, attachment.archived_path);
    if (!archivedPath) {
      this.database.updateAttachment(attachmentId, {
        ingestRunId: runId,
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        status: "failed",
        reportType: null,
        reportTitle: typeof attachment.report_title === "string" ? attachment.report_title : null,
        reportDate,
        parsedJsonPath: null,
        quarantinePath: null,
        parseError: "Archived raw file is missing, so this attachment could not be reparsed."
      });
      summary.attachmentsFailed += 1;
      summary.notes.push(`Attachment ${attachmentName} is missing its archived raw file.`);
      return;
    }

    const bytes = await readFile(archivedPath);

    try {
      const analysis = await this.analyzeAttachment(bytes, extension);
      if (!analysis) {
        throw new UnsupportedReportError(`Unsupported attachment extension for reparse: ${extension}`);
      }

      const refreshedProperty = resolveReprocessedPropertyRef(
        extension,
        {
          propertyName: analysis.propertyName,
          propertySlug: analysis.propertySlug
        },
        {
          propertyName: existingPropertyName,
          propertySlug: existingPropertySlug
        },
        fallbackProperty
      );

      if (extension === ".xlsx" && !analysis.parsedReport) {
        this.database.updateAttachment(attachmentId, {
          ingestRunId: runId,
          propertyName: refreshedProperty.propertyName,
          propertySlug: refreshedProperty.propertySlug,
          status: "deferred",
          reportType: null,
          reportTitle: analysis.reportTitle ?? (typeof attachment.report_title === "string" ? attachment.report_title : null),
          reportDate: resolveAttachmentReportDate(
            attachmentName,
            analysis.reportDate ?? (typeof attachment.report_date === "string" ? attachment.report_date : null)
          ),
          parsedJsonPath: null,
          quarantinePath: null,
          parseError: analysis.error?.message ?? "Workbook parsing is not supported for this XLSX family yet."
        });
        summary.attachmentsDeferred += 1;
        return;
      }

      if (!analysis.parsedReport) {
        const reason = analysis.error?.message ?? "The PDF title does not match any known report family.";
        const quarantineReason = analysis.error instanceof UnsupportedReportError ? "unsupported" : "failed";
        const quarantinePath = path.join(
          this.dataDir,
          "quarantine",
          quarantineReason,
          refreshedProperty.propertySlug,
          buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName)
        );
        await writeBufferFile(quarantinePath, bytes);
        this.database.updateAttachment(attachmentId, {
          ingestRunId: runId,
          propertyName: refreshedProperty.propertyName,
          propertySlug: refreshedProperty.propertySlug,
          status: quarantineReason,
          reportType: null,
          reportTitle: analysis.reportTitle ?? (typeof attachment.report_title === "string" ? attachment.report_title : null),
          reportDate: resolveAttachmentReportDate(
            attachmentName,
            analysis.reportDate ?? (typeof attachment.report_date === "string" ? attachment.report_date : null)
          ),
          parsedJsonPath: null,
          quarantinePath,
          parseError: reason
        });
        summary.attachmentsFailed += 1;
        summary.notes.push(`Attachment ${attachmentName} ${quarantineReason}: ${reason}`);
        return;
      }

      const reparsed = {
        ...analysis.parsedReport,
        propertyName: refreshedProperty.propertyName,
        propertySlug: refreshedProperty.propertySlug,
        reportDate: resolveAttachmentReportDate(attachmentName, analysis.parsedReport.reportDate)
      };
      const parsedJsonPath = path.join(
        this.dataDir,
        "parsed",
        refreshedProperty.propertySlug,
        reparsed.reportType,
        buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName, ".json")
      );
      await writeTextFile(parsedJsonPath, `${JSON.stringify(reparsed, null, 2)}\n`);

      this.database.insertParsedReport(
        runId,
        attachmentId,
        {
          sourceMailbox: String(attachment.source_mailbox ?? ""),
          graphMessageId: String(attachment.graph_message_id ?? ""),
          internetMessageId: typeof attachment.internet_message_id === "string" ? attachment.internet_message_id : null,
          receivedAt: String(attachment.received_at ?? ""),
          attachmentId: String(attachment.graph_attachment_id ?? ""),
          attachmentName,
          propertyName: refreshedProperty.propertyName,
          propertySlug: refreshedProperty.propertySlug
        },
        reparsed
      );

      this.database.updateAttachment(attachmentId, {
        ingestRunId: runId,
        propertyName: refreshedProperty.propertyName,
        propertySlug: refreshedProperty.propertySlug,
        status: "parsed",
        reportType: reparsed.reportType,
        reportTitle: reparsed.reportTitle,
        reportDate: reparsed.reportDate,
        parsedJsonPath,
        quarantinePath: null,
        parseError: null
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
        buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName)
      );
      await writeBufferFile(quarantinePath, bytes);
      this.database.updateAttachment(attachmentId, {
        ingestRunId: runId,
        propertyName: property.propertyName,
        propertySlug: property.propertySlug,
        status: quarantineReason,
        reportType: null,
        reportTitle: typeof attachment.report_title === "string" ? attachment.report_title : null,
        reportDate,
        parsedJsonPath: null,
        quarantinePath,
        parseError: reason
      });
      summary.attachmentsFailed += 1;
      summary.notes.push(`Attachment ${attachmentName} ${quarantineReason}: ${reason}`);
    }
  }

  private async resolveArchivedRawPath(attachmentId: number, storedPath: unknown): Promise<string | null> {
    if (typeof storedPath !== "string") {
      return null;
    }

    const candidate = storedPath.trim();
    if (!candidate) {
      return null;
    }

    if (await pathExists(candidate)) {
      return candidate;
    }

    const remappedPath = remapStoredDataPath(candidate, this.dataDir);
    if (!remappedPath || !(await pathExists(remappedPath))) {
      return null;
    }

    if (remappedPath !== candidate) {
      this.database.updateAttachment(attachmentId, { archivedPath: remappedPath });
    }

    return remappedPath;
  }

  private async resetGeneratedArtifacts(): Promise<void> {
    await Promise.all([
      rm(path.join(this.dataDir, "parsed"), { recursive: true, force: true }),
      rm(path.join(this.dataDir, "quarantine"), { recursive: true, force: true }),
      rm(path.join(this.dataDir, "exports"), { recursive: true, force: true })
    ]);

    await Promise.all([
      ensureDir(path.join(this.dataDir, "parsed")),
      ensureDir(path.join(this.dataDir, "quarantine")),
      ensureDir(path.join(this.dataDir, "exports"))
    ]);
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

function buildAttachmentArtifactFileName(graphMessageId: string, attachmentName: string, suffix = ""): string {
  const messagePart = sanitizeFileName(graphMessageId);
  const originalExtension = path.extname(attachmentName).toLowerCase();
  const baseName = path.basename(attachmentName, originalExtension);
  const safeBaseName = sanitizeFileName(baseName);
  const fullName = `${messagePart}_${sanitizeFileName(attachmentName)}`;
  if (fullName.length + suffix.length <= 180) {
    return `${fullName}${suffix}`;
  }

  const hash = createHash("sha1")
    .update(`${graphMessageId}\n${attachmentName}`)
    .digest("hex")
    .slice(0, 12);
  const trimmedMessage = messagePart.slice(0, 80).replace(/[-_]+$/g, "");
  const trimmedBaseName = safeBaseName.slice(0, 60).replace(/[-_]+$/g, "");
  const safeExtension = sanitizeFileName(originalExtension).replace(/^[-_]+/, "");
  const normalizedExtension = safeExtension ? `.${safeExtension}` : "";
  return `${trimmedMessage}_${trimmedBaseName}_${hash}${normalizedExtension}${suffix}`;
}

function parseDateFromAttachmentName(attachmentName: string): string | null {
  const match = attachmentName.match(/^([A-Za-z]+\s+\d{1,2},\s+\d{4})-/);
  if (!match) {
    return null;
  }

  return parseLongDate(match[1]);
}

function resolveReprocessedPropertyRef(
  extension: string,
  detected: PropertyRef | null | undefined,
  existing: PropertyRef | null | undefined,
  fallback: PropertyRef | null | undefined
): { propertyName: string; propertySlug: string } {
  const existingAssigned = hasAssignedProperty(existing);

  if (extension !== ".xlsx" && existingAssigned) {
    return ensurePropertyRef(existing);
  }

  return ensurePropertyRef({
    propertyName: detected?.propertyName ?? fallback?.propertyName ?? existing?.propertyName ?? null,
    propertySlug: detected?.propertySlug ?? fallback?.propertySlug ?? existing?.propertySlug ?? null
  });
}

function hasAssignedProperty(property: PropertyRef | null | undefined): boolean {
  const propertyName = normalizePropertyName(property?.propertyName);
  const propertySlug = slugifyPropertyName(property?.propertySlug ?? propertyName);
  return Boolean(
    propertyName
    && propertySlug
    && propertyName !== UNASSIGNED_PROPERTY_NAME
    && propertySlug !== UNASSIGNED_PROPERTY_SLUG
  );
}

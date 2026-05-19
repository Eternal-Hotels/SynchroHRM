import { readdir } from "node:fs/promises";
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
import { logger } from "../utils/logger.js";
import { ensureDir, movePathIfExists, pathExists, sanitizeFileName, writeBufferFile, writeTextFile } from "../utils/files.js";
import { ensurePropertyRef, normalizePropertyName, slugifyPropertyName, type PropertyRef } from "../utils/properties.js";
import { ExportService } from "./ExportService.js";

const DELTA_STATE_KEY = "graph.delta.inbox";

interface PreparedAttachment {
  attachment: IncomingAttachment;
  propertyName: string | null;
  propertySlug: string | null;
  parsedReport: PdfAnalysis["parsedReport"];
  preparationError: Error | null;
}

interface PropertyMoveRequest {
  propertyName: string;
  propertySlug?: string | null;
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
        parseError: "XLSX parsing is intentionally deferred in v1."
      });
      summary.attachmentsDeferred += 1;
      return;
    }

    try {
      if (!prepared.parsedReport) {
        throw prepared.preparationError ?? new UnsupportedReportError("The PDF title does not match any known report family.");
      }

      const parsedReport = prepared.parsedReport;
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
        reportDate: parsedReport.reportDate,
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
          parsedReport: null,
          preparationError: null
        } satisfies PreparedAttachment;
      }

      try {
        const analysis = await this.parser.analyze(attachment.bytes);
        return {
          attachment,
          propertyName: analysis.propertyName,
          propertySlug: analysis.propertySlug,
          parsedReport: analysis.parsedReport,
          preparationError: analysis.error
        } satisfies PreparedAttachment;
      } catch (error) {
        return {
          attachment,
          propertyName: null,
          propertySlug: null,
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

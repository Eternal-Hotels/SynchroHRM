import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PdfReportParser, UnsupportedReportError } from "../parsers/pdfReportParser.js";
import { WorkbookReportParser } from "../parsers/workbookReportParser.js";
import { parseLongDate } from "../utils/dates.js";
import { logger } from "../utils/logger.js";
import { ensureDir, movePathIfExists, pathExists, remapStoredDataPath, sanitizeFileName, writeBufferFile, writeTextFile } from "../utils/files.js";
import { isSenderApproved, validateApprovedSenderPatterns } from "../utils/approvedSenders.js";
import { derivePropertyRefFromAttachmentName, ensurePropertyRef, normalizePropertyName, slugifyPropertyName, UNASSIGNED_PROPERTY_NAME, UNASSIGNED_PROPERTY_SLUG } from "../utils/properties.js";
import { ExportService } from "./ExportService.js";
const DELTA_STATE_KEY = "graph.delta.inbox";
export class PropertyUpdateError extends Error {
    constructor(message) {
        super(message);
        this.name = "PropertyUpdateError";
    }
}
export class AttachmentRetryError extends Error {
    constructor(message) {
        super(message);
        this.name = "AttachmentRetryError";
    }
}
export class ReparseOperationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ReparseOperationError";
    }
}
export class IngestionOperationError extends Error {
    constructor(message) {
        super(message);
        this.name = "IngestionOperationError";
    }
}
export class IngestionService {
    database;
    source;
    dataDir;
    defaultApprovedSenderPatterns;
    parser = new PdfReportParser();
    workbookParser = new WorkbookReportParser();
    exportService;
    activeRun = null;
    constructor(database, source, dataDir, defaultApprovedSenderPatterns = []) {
        this.database = database;
        this.source = source;
        this.dataDir = dataDir;
        this.defaultApprovedSenderPatterns = defaultApprovedSenderPatterns;
        this.exportService = new ExportService(database, dataDir);
    }
    getApprovedSenderPatterns() {
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
    updateApprovedSenderPatterns(patterns) {
        const validated = validateApprovedSenderPatterns(patterns);
        if (validated.invalid.length > 0) {
            throw new PropertyUpdateError(`Invalid sender patterns: ${validated.invalid.join(", ")}`);
        }
        this.database.setApprovedSenderPatterns(validated.valid);
        return validated.valid;
    }
    run(triggerSource, options = {}) {
        if (this.activeRun) {
            return this.activeRun.promise;
        }
        return this.startExclusiveRun(triggerSource, (runId) => this.runInternal(runId, triggerSource, options)).promise;
    }
    startManualRun(options = {}) {
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
    startReparseRun() {
        const activeRun = this.startStoredReportReparse();
        return {
            runId: activeRun.runId,
            status: "running",
            triggerSource: "reparse"
        };
    }
    getActiveRunId() {
        return this.activeRun?.runId ?? null;
    }
    isRunActive(runId) {
        return this.activeRun?.runId === runId;
    }
    getLatestExport(reportType, propertySlug) {
        return this.exportService.getLatestExport(reportType, propertySlug);
    }
    async reparseStoredReports() {
        return this.startStoredReportReparse().promise;
    }
    async repairStoredWorkbookAttachments(options = {}) {
        return this.startStoredWorkbookRepair(options).promise;
    }
    async retryAttachmentParse(attachmentId) {
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
        let analysis = null;
        try {
            analysis = await this.analyzeAttachment(bytes, extension);
        }
        catch (error) {
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
        const property = resolveReprocessedPropertyRef(extension, {
            propertyName: analysis.propertyName,
            propertySlug: analysis.propertySlug
        }, {
            propertyName: existingPropertyName,
            propertySlug: existingPropertySlug
        }, fallbackProperty);
        const reportTitle = analysis.reportTitle ?? existingReportTitle;
        const reportDate = resolveAttachmentReportDate(String(attachment.attachment_name ?? ""), analysis.parsedReport?.reportDate ?? analysis.reportDate ?? existingReportDate);
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
        const parsedJsonPath = path.join(this.dataDir, "parsed", property.propertySlug, parsedReport.reportType, buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), String(attachment.attachment_name ?? ""), ".json"));
        await writeTextFile(parsedJsonPath, `${JSON.stringify(parsedReport, null, 2)}\n`);
        this.database.deleteParsedReportsForAttachment(attachmentId);
        this.database.insertParsedReport(Number(attachment.last_ingest_run_id), attachmentId, {
            sourceMailbox: String(attachment.source_mailbox ?? ""),
            graphMessageId: String(attachment.graph_message_id ?? ""),
            internetMessageId: typeof attachment.internet_message_id === "string" ? attachment.internet_message_id : null,
            receivedAt: String(attachment.received_at ?? ""),
            attachmentId: String(attachment.graph_attachment_id ?? ""),
            attachmentName: String(attachment.attachment_name ?? ""),
            propertyName: property.propertyName,
            propertySlug: property.propertySlug
        }, parsedReport);
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
    async updateProperty(currentSlug, input) {
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
        const completedMoves = [];
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
            }
            catch (error) {
                logger.error("Property rename completed but export refresh failed", {
                    propertySlug: nextSlug,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
            return this.database.getPropertySummary(nextSlug) ?? {
                property_name: nextName,
                property_slug: nextSlug
            };
        }
        catch (error) {
            if (propertyCommitted) {
                throw error;
            }
            for (const move of completedMoves.reverse()) {
                try {
                    await movePathIfExists(move.destinationPath, move.sourcePath);
                }
                catch {
                    logger.error("Failed to roll back property folder rename", {
                        from: move.destinationPath,
                        to: move.sourcePath
                    });
                }
            }
            throw error;
        }
    }
    startExclusiveRun(triggerSource, execute) {
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
        };
        this.activeRun = activeRun;
        return activeRun;
    }
    startStoredReportReparse() {
        if (this.activeRun) {
            throw new ReparseOperationError("Please wait for the active ingestion run to finish before reparsing stored reports.");
        }
        return this.startExclusiveRun("reparse", (runId) => this.reparseStoredReportsInternal(runId));
    }
    startStoredWorkbookRepair(options) {
        if (this.activeRun) {
            throw new ReparseOperationError("Please wait for the active ingestion run to finish before repairing stored workbook attachments.");
        }
        return this.startExclusiveRun("reparse", (runId) => this.repairStoredWorkbookAttachmentsInternal(runId, options));
    }
    persistRunProgress(runId, summary) {
        this.database.updateRunProgress(runId, summary);
    }
    async pullAndProcessAttachments(runId, summary, approvedSenderPatterns, deltaToken) {
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
    async processIncomingAttachments(runId, summary, approvedSenderPatterns, attachments) {
        if (attachments.length === 0) {
            this.persistRunProgress(runId, summary);
            return;
        }
        summary.attachmentsSeen += attachments.length;
        const attachmentsFromApprovedSenders = this.filterAttachmentsByApprovedSender(attachments, approvedSenderPatterns, summary);
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
    async runInternal(runId, triggerSource, options) {
        const summary = {
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
                summary.notes.push(storedDeltaToken
                    ? "Manual run ignored the saved Microsoft Graph delta token and performed a full Inbox scan."
                    : "Manual run performed a full Inbox scan because no Graph delta token was saved yet.");
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
        }
        catch (error) {
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
    async reparseStoredReportsInternal(runId) {
        const summary = {
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
        }
        catch (error) {
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
    async repairStoredWorkbookAttachmentsInternal(runId, options) {
        const summary = {
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
            const attachments = this.filterStoredWorkbookAttachments(this.database.listAttachmentsForReparse(), options);
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
        }
        catch (error) {
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
    async processAttachment(runId, summary, prepared) {
        const { attachment } = prepared;
        const property = ensurePropertyRef(prepared);
        const resolvedReportDate = resolveAttachmentReportDate(attachment.attachmentName, prepared.parsedReport?.reportDate ?? prepared.reportDate);
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
            const parsedJsonPath = path.join(this.dataDir, "parsed", property.propertySlug, parsedReport.reportType, buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName, ".json"));
            await writeTextFile(parsedJsonPath, `${JSON.stringify(parsedReport, null, 2)}\n`);
            this.database.insertParsedReport(runId, recordId, {
                sourceMailbox: attachment.sourceMailbox,
                graphMessageId: attachment.message.graphMessageId,
                internetMessageId: attachment.message.internetMessageId,
                receivedAt: attachment.message.receivedAt,
                attachmentId: attachment.attachmentId,
                attachmentName: attachment.attachmentName,
                propertyName: property.propertyName,
                propertySlug: property.propertySlug
            }, parsedReport);
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
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const quarantineReason = error instanceof UnsupportedReportError ? "unsupported" : "failed";
            const quarantinePath = path.join(this.dataDir, "quarantine", quarantineReason, property.propertySlug, buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName));
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
    async analyzeAttachment(bytes, extension) {
        if (extension === ".pdf") {
            return this.parser.analyze(bytes);
        }
        if (extension === ".xlsx") {
            return this.workbookParser.analyze(bytes);
        }
        return null;
    }
    async archiveAttachment(attachment, property) {
        const receivedDay = attachment.message.receivedAt.slice(0, 10);
        const resolved = ensurePropertyRef(property);
        const archivePath = path.join(this.dataDir, "raw", resolved.propertySlug, receivedDay, buildAttachmentArtifactFileName(attachment.message.graphMessageId, attachment.attachmentName));
        await writeBufferFile(archivePath, attachment.bytes);
        return archivePath;
    }
    async prepareAttachments(attachments) {
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
                };
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
                    };
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
                };
            }
            catch (error) {
                return {
                    attachment,
                    propertyName: null,
                    propertySlug: null,
                    reportTitle: null,
                    reportDate: null,
                    parsedReport: null,
                    preparationError: error instanceof Error ? error : new Error(String(error))
                };
            }
        }));
        const dominantProperty = determineDominantProperty(prepared);
        if (!dominantProperty) {
            return prepared;
        }
        return prepared.map((entry) => (entry.propertySlug
            ? entry
            : {
                ...entry,
                propertyName: dominantProperty.propertyName,
                propertySlug: dominantProperty.propertySlug
            }));
    }
    filterStoredWorkbookAttachments(attachments, options) {
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
    filterAttachmentsByApprovedSender(attachments, approvedSenderPatterns, summary) {
        if (approvedSenderPatterns.length === 0) {
            summary.attachmentsApproved += attachments.length;
            return attachments;
        }
        const allowed = [];
        for (const attachment of attachments) {
            if (isSenderApproved(attachment.message.senderEmail, approvedSenderPatterns)) {
                summary.attachmentsApproved += 1;
                allowed.push(attachment);
                continue;
            }
            summary.attachmentsNotApproved += 1;
            summary.notes.push(`Skipped attachment ${attachment.attachmentName} from unapproved sender ${attachment.message.senderEmail ?? "unknown"}.`);
        }
        return allowed;
    }
    async reparseAttachment(runId, summary, attachment) {
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
        const reportDate = resolveAttachmentReportDate(attachmentName, typeof attachment.report_date === "string" ? attachment.report_date : null);
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
            const refreshedProperty = resolveReprocessedPropertyRef(extension, {
                propertyName: analysis.propertyName,
                propertySlug: analysis.propertySlug
            }, {
                propertyName: existingPropertyName,
                propertySlug: existingPropertySlug
            }, fallbackProperty);
            if (extension === ".xlsx" && !analysis.parsedReport) {
                this.database.updateAttachment(attachmentId, {
                    ingestRunId: runId,
                    propertyName: refreshedProperty.propertyName,
                    propertySlug: refreshedProperty.propertySlug,
                    status: "deferred",
                    reportType: null,
                    reportTitle: analysis.reportTitle ?? (typeof attachment.report_title === "string" ? attachment.report_title : null),
                    reportDate: resolveAttachmentReportDate(attachmentName, analysis.reportDate ?? (typeof attachment.report_date === "string" ? attachment.report_date : null)),
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
                const quarantinePath = path.join(this.dataDir, "quarantine", quarantineReason, refreshedProperty.propertySlug, buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName));
                await writeBufferFile(quarantinePath, bytes);
                this.database.updateAttachment(attachmentId, {
                    ingestRunId: runId,
                    propertyName: refreshedProperty.propertyName,
                    propertySlug: refreshedProperty.propertySlug,
                    status: quarantineReason,
                    reportType: null,
                    reportTitle: analysis.reportTitle ?? (typeof attachment.report_title === "string" ? attachment.report_title : null),
                    reportDate: resolveAttachmentReportDate(attachmentName, analysis.reportDate ?? (typeof attachment.report_date === "string" ? attachment.report_date : null)),
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
            const parsedJsonPath = path.join(this.dataDir, "parsed", refreshedProperty.propertySlug, reparsed.reportType, buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName, ".json"));
            await writeTextFile(parsedJsonPath, `${JSON.stringify(reparsed, null, 2)}\n`);
            this.database.insertParsedReport(runId, attachmentId, {
                sourceMailbox: String(attachment.source_mailbox ?? ""),
                graphMessageId: String(attachment.graph_message_id ?? ""),
                internetMessageId: typeof attachment.internet_message_id === "string" ? attachment.internet_message_id : null,
                receivedAt: String(attachment.received_at ?? ""),
                attachmentId: String(attachment.graph_attachment_id ?? ""),
                attachmentName,
                propertyName: refreshedProperty.propertyName,
                propertySlug: refreshedProperty.propertySlug
            }, reparsed);
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
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const quarantineReason = error instanceof UnsupportedReportError ? "unsupported" : "failed";
            const quarantinePath = path.join(this.dataDir, "quarantine", quarantineReason, property.propertySlug, buildAttachmentArtifactFileName(String(attachment.graph_message_id ?? ""), attachmentName));
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
    async resolveArchivedRawPath(attachmentId, storedPath) {
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
    async resetGeneratedArtifacts() {
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
    async collectPropertyMoves(currentSlug, nextSlug) {
        if (currentSlug === nextSlug) {
            return [];
        }
        const candidates = [
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
        const moves = [];
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
function determineDominantProperty(attachments) {
    const counts = new Map();
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
function resolveAttachmentReportDate(attachmentName, parsedReportDate) {
    const fileDate = parseDateFromAttachmentName(attachmentName);
    // PDTOR packets are keyed operationally by the attachment date label.
    if (fileDate && /-PDTOR-/i.test(attachmentName)) {
        return fileDate;
    }
    return parsedReportDate ?? fileDate;
}
function buildAttachmentArtifactFileName(graphMessageId, attachmentName, suffix = "") {
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
function parseDateFromAttachmentName(attachmentName) {
    const match = attachmentName.match(/^([A-Za-z]+\s+\d{1,2},\s+\d{4})-/);
    if (!match) {
        return null;
    }
    return parseLongDate(match[1]);
}
function resolveReprocessedPropertyRef(extension, detected, existing, fallback) {
    const existingAssigned = hasAssignedProperty(existing);
    if (extension !== ".xlsx" && existingAssigned) {
        return ensurePropertyRef(existing);
    }
    return ensurePropertyRef({
        propertyName: detected?.propertyName ?? fallback?.propertyName ?? existing?.propertyName ?? null,
        propertySlug: detected?.propertySlug ?? fallback?.propertySlug ?? existing?.propertySlug ?? null
    });
}
function hasAssignedProperty(property) {
    const propertyName = normalizePropertyName(property?.propertyName);
    const propertySlug = slugifyPropertyName(property?.propertySlug ?? propertyName);
    return Boolean(propertyName
        && propertySlug
        && propertyName !== UNASSIGNED_PROPERTY_NAME
        && propertySlug !== UNASSIGNED_PROPERTY_SLUG);
}

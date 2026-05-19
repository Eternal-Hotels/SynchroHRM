export const REPORT_TYPES = [
  "history_forecast_rows",
  "manager_flash_metric_rows",
  "reservations_made_yesterday_rows",
  "zero_rate_room_rows",
  "ar_detailed_aging_rows",
  "rate_change_rows"
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export type TriggerSource = "manual" | "scheduled" | "test";

export interface MailMessageRef {
  graphMessageId: string;
  internetMessageId: string | null;
  subject: string | null;
  receivedAt: string;
  webLink: string | null;
}

export interface IncomingAttachment {
  sourceMailbox: string;
  message: MailMessageRef;
  attachmentId: string;
  attachmentName: string;
  contentType: string | null;
  bytes: Buffer;
}

export interface PullAttachmentsResult {
  attachments: IncomingAttachment[];
  nextDeltaToken: string | null;
  deltaWasReset: boolean;
  messagesSeen: number;
}

export interface MailAttachmentSource {
  pullAttachments(deltaToken: string | null): Promise<PullAttachmentsResult>;
}

export interface ParsedReport {
  reportType: ReportType;
  reportTitle: string;
  reportDate: string | null;
  propertyName: string | null;
  propertySlug: string | null;
  rows: Array<Record<string, string | number | null>>;
}

export interface RunSummary {
  messagesSeen: number;
  attachmentsSeen: number;
  attachmentsArchived: number;
  attachmentsParsed: number;
  attachmentsDeferred: number;
  attachmentsFailed: number;
  notes: string[];
}

export interface ExportFileInfo {
  reportType: ReportType;
  propertyName: string | null;
  propertySlug: string | null;
  csvPath: string;
  latestPath: string;
  rowCount: number;
}

export interface IngestionRunResult {
  runId: number;
  status: "completed" | "failed";
  summary: RunSummary;
  exports: ExportFileInfo[];
}

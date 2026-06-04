export const REPORT_TYPES = [
  "history_forecast_rows",
  "manager_flash_metric_rows",
  "reservations_made_yesterday_rows",
  "zero_rate_room_rows",
  "ar_detailed_aging_rows",
  "rate_change_rows",
  "all_night_audit_report_rows",
  "choice_audit_packet_rows",
  "best_western_daily_report_rows",
  "adjustment_refund_activity_rows",
  "all_transaction_rows",
  "room_tax_listing_rows",
  "daily_transaction_log_rows",
  "credit_card_transaction_rows",
  "closed_folio_balance_rows",
  "operator_transaction_rows",
  "advance_deposit_activity_rows",
  "booked_reservations_rows",
  "direct_bill_aging_rows",
  "direct_bill_ledger_rows",
  "final_audit_metric_rows",
  "high_balance_report_rows",
  "hotel_statistics_metric_rows",
  "in_house_guest_folio_balance_rows",
  "maintenance_summary_rows",
  "occupancy_forecast_rows",
  "rate_override_rows",
  "rate_report_rows",
  "reservation_listing_rows",
  "tax_report_rows",
  "trial_balance_report_rows"
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

export type TriggerSource = "manual" | "scheduled" | "test" | "reparse";

export interface MailMessageRef {
  graphMessageId: string;
  internetMessageId: string | null;
  subject: string | null;
  senderEmail: string | null;
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

export interface PullAttachmentsMeta {
  nextDeltaToken: string | null;
  deltaWasReset: boolean;
  messagesSeen: number;
}

export interface AttachmentBatchProgress {
  messagesSeen: number;
}

export type AttachmentBatchHandler = (
  attachments: IncomingAttachment[],
  progress: AttachmentBatchProgress
) => Promise<void> | void;

export interface MailAttachmentSource {
  pullAttachments(deltaToken: string | null): Promise<PullAttachmentsResult>;
  scanAttachments?(deltaToken: string | null, onAttachments: AttachmentBatchHandler): Promise<PullAttachmentsMeta>;
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
  attachmentsApproved: number;
  attachmentsNotApproved: number;
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

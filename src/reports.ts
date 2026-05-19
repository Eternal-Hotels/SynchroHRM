import type { ReportType } from "./types.js";

export const COMMON_EXPORT_COLUMNS = [
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
] as const;

export const REPORT_COLUMN_MAP: Record<ReportType, readonly string[]> = {
  history_forecast_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "business_date",
    "section",
    "day_of_week",
    "total_occ",
    "arrivals",
    "comp_rooms",
    "house_use_rooms",
    "deduct_indiv_rooms",
    "non_deduct_indiv_rooms",
    "deduct_group_rooms",
    "non_deduct_group_rooms",
    "occupancy_pct",
    "room_revenue",
    "average_rate",
    "departures",
    "day_use_rooms",
    "no_show_rooms",
    "ooo_rooms",
    "in_house_people"
  ],
  manager_flash_metric_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "metric_name",
    "period",
    "metric_value"
  ],
  reservations_made_yesterday_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "guest_name",
    "arrival_date",
    "departure_date",
    "persons",
    "rooms",
    "nights",
    "rate_amount",
    "rate_code",
    "market_code",
    "booking_user",
    "made_on_date",
    "company_group_note"
  ],
  zero_rate_room_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "room_account_no",
    "guest_or_group_name",
    "persons",
    "rate_code",
    "block_code",
    "market_code",
    "arrival_date",
    "departure_date",
    "balance_amount",
    "room_type",
    "payment_method",
    "tax_code",
    "note"
  ],
  ar_detailed_aging_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "account_name",
    "guest_name",
    "invoice_no",
    "folio_no",
    "post_date",
    "up_to_30",
    "days_31_60",
    "days_61_90",
    "days_91_120",
    "days_121_150",
    "days_151_plus",
    "total_amount"
  ],
  rate_change_rows: [
    ...COMMON_EXPORT_COLUMNS,
    "confirmation_no",
    "room_no",
    "guest_name",
    "account_kind",
    "company_or_agent",
    "old_rate_code",
    "new_rate_code",
    "old_rate_amount",
    "new_rate_amount",
    "block_code",
    "changed_by",
    "changed_at"
  ]
};

export const REPORT_EXPORT_COLUMN_MAP: Record<ReportType, readonly string[]> = Object.fromEntries(
  Object.entries(REPORT_COLUMN_MAP).map(([reportType, columns]) => [
    reportType,
    columns.filter((column) => !COMMON_EXPORT_COLUMNS.includes(column as (typeof COMMON_EXPORT_COLUMNS)[number]))
  ])
) as unknown as Record<ReportType, readonly string[]>;

export const REPORT_TITLES: Record<ReportType, string> = {
  history_forecast_rows: "History and Forecast",
  manager_flash_metric_rows: "Manager - Flash Last Day",
  reservations_made_yesterday_rows: "Reservations - made Yesterday",
  zero_rate_room_rows: "Zero Rate Rooms",
  ar_detailed_aging_rows: "AR Detailed Aging",
  rate_change_rows: "Rate Change Report"
};

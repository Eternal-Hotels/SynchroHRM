import fs from "node:fs";
import path from "node:path";

type ParsedRow = Record<string, unknown>;

interface ParsedReportFile {
  reportTitle?: string;
  rows?: ParsedRow[];
}

interface ReportSnapshot {
  propertySlug: string;
  reportType: string;
  reportTitle: string;
  latestParsedJsonPath: string;
  rows: ParsedRow[];
}

interface AuditRecommendation {
  suggestedMappingCount?: number;
  suggestedStrategy?: string;
  notes: string[];
}

const STORAGE_PARSED_DIR = path.resolve("storage", "parsed");
const PROPERTY_PREFIX = "holiday-inn-express-";
const TSV_HEADER = [
  "property_slug",
  "report_type",
  "report_title",
  "latest_parsed_json_path",
  "row_count",
  "current_mapping_count",
  "metadata_row_count",
  "bad_amount_row_count",
  "suggested_mapping_count",
  "suggested_strategy",
  "sections",
  "notes"
].join("\t");

const COMMON_EXPORT_COLUMNS = new Set([
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
]);

const METRIC_SKIP_FIELDS = new Set([
  "section",
  "subsection",
  "group_name",
  "report_name",
  "metric_name",
  "summary_label",
  "row_kind",
  "line_text",
  "note"
]);

function main(): void {
  const snapshots = loadSnapshots();
  console.log(TSV_HEADER);

  for (const snapshot of snapshots) {
    const metadataRows = snapshot.rows.filter(isMetadataLikeRow);
    const recommendation = buildRecommendation(snapshot);
    const sections = Array.from(
      new Set(snapshot.rows.map((row) => normalizeWhitespace(row.section)).filter(Boolean))
    ).slice(0, 8);
    const badAmountRowCount = snapshot.rows.filter((row) => {
      return Object.prototype.hasOwnProperty.call(row, "amount") && parseAmount(row.amount) === null;
    }).length;

    const fields = [
      snapshot.propertySlug,
      snapshot.reportType,
      snapshot.reportTitle,
      snapshot.latestParsedJsonPath,
      String(snapshot.rows.length),
      String(countCurrentMappings(snapshot)),
      String(metadataRows.length),
      badAmountRowCount > 0 ? String(badAmountRowCount) : "",
      recommendation.suggestedMappingCount === undefined ? "" : String(recommendation.suggestedMappingCount),
      recommendation.suggestedStrategy ?? "",
      sections.join("|"),
      recommendation.notes.join("; ")
    ];

    console.log(fields.map(escapeTsv).join("\t"));
  }
}

function loadSnapshots(): ReportSnapshot[] {
  if (!fs.existsSync(STORAGE_PARSED_DIR)) {
    throw new Error(`Parsed storage directory was not found: ${STORAGE_PARSED_DIR}`);
  }

  const propertyDirs = fs.readdirSync(STORAGE_PARSED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PROPERTY_PREFIX))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const snapshots: ReportSnapshot[] = [];
  for (const propertySlug of propertyDirs) {
    const propertyDir = path.join(STORAGE_PARSED_DIR, propertySlug);
    const reportTypeDirs = fs.readdirSync(propertyDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const reportType of reportTypeDirs) {
      const reportDir = path.join(propertyDir, reportType);
      const jsonFiles = fs.readdirSync(reportDir)
        .filter((name) => name.endsWith(".json"))
        .sort((left, right) => left.localeCompare(right));
      if (jsonFiles.length === 0) {
        continue;
      }

      const latestFile = jsonFiles[jsonFiles.length - 1];
      const latestPath = path.join(reportDir, latestFile);
      const parsed = JSON.parse(fs.readFileSync(latestPath, "utf8")) as ParsedReportFile;
      const rows = Array.isArray(parsed.rows) ? parsed.rows : [];

      snapshots.push({
        propertySlug,
        reportType,
        reportTitle: normalizeWhitespace(parsed.reportTitle) || reportType,
        latestParsedJsonPath: path.relative(process.cwd(), latestPath).replace(/\\/g, "/"),
        rows
      });
    }
  }

  return snapshots;
}

function countCurrentMappings(snapshot: ReportSnapshot): number {
  if (snapshot.rows.length === 0) {
    return 0;
  }

  if (snapshot.reportType === "all_transaction_rows") {
    const byKey = new Set<string>();
    for (const row of snapshot.rows) {
      const itemLabel = buildAllTransactionCategoryLabel(row, snapshot);
      const amount = parseAmount(row.amount);
      if (amount === null) {
        continue;
      }

      byKey.add(buildMappingKey(snapshot.reportType, "amount", [itemLabel]));
    }
    return byKey.size;
  }

  const byKey = new Set<string>();
  for (const row of snapshot.rows) {
    const identityParts = buildPostingIdentityParts(row, snapshot);
    for (const [field, value] of Object.entries(row)) {
      if (!shouldTreatAsMetricField(field)) {
        continue;
      }

      if (parseAmount(value) === null) {
        continue;
      }

      byKey.add(buildMappingKey(snapshot.reportType, field, identityParts));
    }
  }

  return byKey.size;
}

function buildRecommendation(snapshot: ReportSnapshot): AuditRecommendation {
  const rowsWithoutMetadata = snapshot.rows.filter((row) => !isMetadataLikeRow(row));

  switch (snapshot.reportType) {
    case "all_transaction_rows":
      return {
        notes: [
          "custom grouping already exists, but many rows still shift merchant or description text into amount",
          "fix parser alignment before adding more collapse rules"
        ]
      };
    case "closed_folio_balance_rows":
      return {
        suggestedMappingCount: countCollapsedMappings(rowsWithoutMetadata, (row, amountField) => [
          snapshot.reportType,
          normalizeWhitespace(row.section) || "All",
          normalizeWhitespace(row.row_kind) || "detail",
          normalizeWhitespace(row.summary_label) || normalizeWhitespace(row.reservation_status) || "All",
          amountField
        ]),
        suggestedStrategy: "section + row_kind + summary_label_or_reservation_status + amount_field",
        notes: [
          "detail rows repeat the same reservation_status values and already ship totals and balance metrics"
        ]
      };
    case "direct_bill_aging_rows":
      return {
        suggestedMappingCount: countCollapsedMappings(rowsWithoutMetadata, (row, amountField) => [
          snapshot.reportType,
          normalizeWhitespace(row.section) || "All",
          amountField
        ]),
        suggestedStrategy: "section + aging_bucket",
        notes: [
          "current grouping preserves company_name and company_code, which turns aging buckets into per-company mappings"
        ]
      };
    case "final_audit_metric_rows":
      return {
        notes: [
          "drop metadata rows first",
          "wrapped metric_name text is carrying multiple charge lines into one row",
          "name or whitelist the value_* columns before using this report in NetSuite"
        ]
      };
    case "hotel_statistics_metric_rows":
      return {
        notes: [
          "drop metadata rows first",
          "value_1 through value_5 are still unnamed, so every metric becomes five separate mappings"
        ]
      };
    case "in_house_guest_folio_balance_rows":
      return {
        suggestedMappingCount: countCollapsedMappings(rowsWithoutMetadata, (row, amountField) => [
          snapshot.reportType,
          normalizeWhitespace(row.section) || "All",
          normalizeWhitespace(row.row_kind) || "detail",
          normalizeWhitespace(row.summary_label)
            || normalizeWhitespace(row.reservation_status)
            || normalizeWhitespace(row.payment_method)
            || "All",
          amountField
        ]),
        suggestedStrategy: "section + row_kind + summary_label_or_reservation_status_or_payment_method + amount_field",
        notes: [
          "current grouping preserves guest_name, confirmation_no, dates, and room_number for each folio row"
        ]
      };
    case "tax_report_rows":
      return {
        suggestedMappingCount: countCollapsedMappings(rowsWithoutMetadata, (row, amountField) => [
          snapshot.reportType,
          normalizeWhitespace(row.section) || "All",
          normalizeWhitespace(row.tax_name) || "All Taxes",
          amountField
        ]),
        suggestedStrategy: "section + tax_name + amount_field",
        notes: [
          "prefer Summary rows over Exempted Tax Details and Non Exempted Tax Details",
          "detail rows currently preserve transaction_number and guest-level context"
        ]
      };
    case "trial_balance_report_rows":
      return {
        suggestedMappingCount: countSpecificMetricMappings(rowsWithoutMetadata, ["net_change"]),
        suggestedStrategy: "account_name + net_change only",
        notes: [
          "keeping opening_balance, debit_amount, credit_amount, net_change, and closing_balance multiplies each account into five mappings"
        ]
      };
    case "all_night_audit_report_rows":
      return {
        notes: [
          "latest Holiday Inn Express samples are mostly visible-title rows and do not currently produce numeric mappings"
        ]
      };
    default:
      return {
        notes: []
      };
  }
}

function countCollapsedMappings(
  rows: ParsedRow[],
  keyBuilder: (row: ParsedRow, amountField: string) => string[]
): number {
  const byKey = new Set<string>();
  for (const row of rows) {
    for (const [field, value] of Object.entries(row)) {
      if (!shouldTreatAsMetricField(field)) {
        continue;
      }

      if (parseAmount(value) === null) {
        continue;
      }

      byKey.add(keyBuilder(row, field).map(normalizeMappingPart).filter(Boolean).join(":"));
    }
  }

  return byKey.size;
}

function countSpecificMetricMappings(rows: ParsedRow[], allowedFields: string[]): number {
  const allowed = new Set(allowedFields);
  const byKey = new Set<string>();

  for (const row of rows) {
    for (const field of allowed) {
      if (parseAmount(row[field]) === null) {
        continue;
      }

      byKey.add([
        normalizeMappingPart(normalizeWhitespace(row.account_type) || "all"),
        normalizeMappingPart(normalizeWhitespace(row.account_name) || "all"),
        normalizeMappingPart(field)
      ].join(":"));
    }
  }

  return byKey.size;
}

function buildPostingIdentityParts(row: ParsedRow, snapshot: ReportSnapshot): string[] {
  const parts = Object.entries(row)
    .filter(([field]) => !COMMON_EXPORT_COLUMNS.has(field))
    .map(([field, value]) => {
      if (shouldTreatAsMetricField(field)) {
        return "";
      }
      return formatContextValue(field, value);
    })
    .filter(Boolean);

  return parts.length > 0 ? parts : [snapshot.reportTitle || snapshot.reportType];
}

function buildAllTransactionCategoryLabel(row: ParsedRow, snapshot: ReportSnapshot): string {
  const transactionType = normalizeWhitespace(row.transaction_type);
  const chargeType = normalizeWhitespace(row.charge_type);
  if (transactionType === "CHARGE" && chargeType) {
    return `${humanizeCategoryValue(chargeType)} Charge`;
  }
  if (transactionType === "TAX" && chargeType) {
    return `${humanizeCategoryValue(chargeType)} Tax`;
  }
  if (transactionType && chargeType) {
    return `${humanizeCategoryValue(chargeType)} ${humanizeCategoryValue(transactionType)}`;
  }
  if (transactionType) {
    return humanizeCategoryValue(transactionType);
  }
  if (chargeType) {
    return humanizeCategoryValue(chargeType);
  }

  const description = normalizeWhitespace(row.transaction_description)
    .replace(/\s+\d{1,4}-[A-Za-z]$/g, "")
    .replace(/\s+\d{1,4}$/g, "")
    .trim();

  return description || normalizeWhitespace(row.transaction_code) || snapshot.reportTitle;
}

function shouldTreatAsMetricField(field: string): boolean {
  if (COMMON_EXPORT_COLUMNS.has(field) || METRIC_SKIP_FIELDS.has(field)) {
    return false;
  }
  if (/_date$|_time$|_name$|_code$|_type$|_status$|_method$|_plan$|_flag$|_user$|_by$/.test(field)) {
    return false;
  }
  if (/(^|_)(id|no|number|fragment)$/.test(field)) {
    return false;
  }
  return true;
}

function formatContextValue(field: string, value: unknown): string {
  const text = normalizeWhitespace(value);
  if (!text || COMMON_EXPORT_COLUMNS.has(field)) {
    return "";
  }
  if (["section", "subsection", "group_name", "report_name", "metric_name", "summary_label"].includes(field)) {
    return text;
  }
  return `${humanizeFieldLabel(field)}: ${text}`;
}

function buildMappingKey(reportType: string, amountField: string, parts: string[]): string {
  return [
    reportType,
    amountField,
    ...parts.map(normalizeMappingPart).filter(Boolean)
  ].join(":");
}

function isMetadataLikeRow(row: ParsedRow): boolean {
  const texts = Object.values(row).map((value) => normalizeWhitespace(value)).filter(Boolean);
  return texts.some((text) => /^(report run date|report run time|date:|user:|[^a-z0-9]*\?\?\? date:)/i.test(text))
    || texts.some((text) => /^(ELNWA|PDTOR) Report run date:/i.test(text));
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? roundMoney(value) : null;
  }

  const raw = normalizeWhitespace(value);
  if (!raw) {
    return null;
  }

  const negative = raw.startsWith("(") && raw.endsWith(")");
  const cleaned = raw
    .replace(/[$,%]/g, "")
    .replace(/[()]/g, "")
    .replace(/^\+/, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
    return null;
  }

  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return roundMoney(negative ? -Math.abs(amount) : amount);
}

function humanizeCategoryValue(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\b(ar|gl|db|adr|ooo)\b/g, (match) => match.toUpperCase())
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function humanizeFieldLabel(field: string): string {
  return field
    .replace(/_/g, " ")
    .replace(/\bpct\b/gi, "Pct")
    .replace(/\badr\b/g, "ADR")
    .replace(/\booo\b/gi, "OOO")
    .replace(/\bytd\b/gi, "YTD")
    .replace(/\bmtd\b/gi, "MTD")
    .replace(/\bdb\b/gi, "DB")
    .replace(/\b(ar|gl)\b/gi, (match) => match.toUpperCase())
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeWhitespace(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : (value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim());
}

function normalizeMappingPart(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeTsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

void main();

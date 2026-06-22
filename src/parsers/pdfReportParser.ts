import { extractPdfText, type PdfDocumentText, type PdfLine } from "../pdf/PdfTextExtractor.js";
import { parseLongDate, parseShortDate } from "../utils/dates.js";
import type { ParsedReport, ReportType } from "../types.js";
import { REPORT_TITLES } from "../reports.js";
import { normalizeDetectedPropertyName, normalizePropertyName, slugifyPropertyName } from "../utils/properties.js";

export class UnsupportedReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedReportError";
  }
}

export interface PdfAnalysis {
  propertyName: string | null;
  propertySlug: string | null;
  reportDate: string | null;
  reportTitle: string | null;
  parsedReport: ParsedReport | null;
  error: Error | null;
}

export class PdfReportParser {
  async parse(bytes: Buffer): Promise<ParsedReport> {
    const analysis = await this.analyze(bytes);
    if (analysis.parsedReport) {
      return analysis.parsedReport;
    }

    throw analysis.error ?? new UnsupportedReportError("The PDF title does not match any known report family.");
  }

  async analyze(bytes: Buffer): Promise<PdfAnalysis> {
    const document = await extractPdfText(bytes);
    const propertyName = extractPropertyName(document);
    const propertySlug = slugifyPropertyName(propertyName);
    const reportDate = extractReportDate(document);
    const reportTitle = extractVisibleReportTitle(document);

    try {
      return {
        propertyName,
        propertySlug,
        reportDate,
        reportTitle,
        parsedReport: buildParsedReport(document, propertyName, propertySlug, reportDate),
        error: null
      };
    } catch (error) {
      if (!(error instanceof UnsupportedReportError)) {
        throw error;
      }

      return {
        propertyName,
        propertySlug,
        reportDate,
        reportTitle,
        parsedReport: null,
        error
      };
    }
  }
}

function buildParsedReport(
  document: PdfDocumentText,
  propertyName: string | null,
  propertySlug: string | null,
  reportDate: string | null
): ParsedReport {
  const reportType = detectReportType(document);

  switch (reportType) {
    case "history_forecast_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseHistoryAndForecast(document)
      };
    case "manager_flash_metric_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseManagerFlash(document)
      };
    case "reservations_made_yesterday_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseReservationsMadeYesterday(document)
      };
    case "zero_rate_room_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseZeroRateRooms(document)
      };
    case "ar_detailed_aging_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseArDetailedAging(document)
      };
    case "rate_change_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseRateChangeReport(document)
      };
    case "all_night_audit_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractAllNightAuditBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseAllNightAuditReport(document)
      };
    case "choice_audit_packet_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractChoiceAuditPacketBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseChoiceAuditPacket(document)
      };
    case "best_western_daily_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractBestWesternBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseBestWesternDailyReport(document)
      };
    case "adjustment_refund_activity_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseAdjustmentRefundActivity(document)
      };
    case "all_transaction_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseAllTransactions(document)
      };
    case "room_tax_listing_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractBestWesternBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseRoomTaxListing(document, extractBestWesternBusinessDate(document) ?? reportDate)
      };
    case "daily_transaction_log_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractBestWesternBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseDailyTransactionLog(document, extractBestWesternBusinessDate(document) ?? reportDate)
      };
    case "credit_card_transaction_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractBestWesternBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseCreditCardTransactions(document)
      };
    case "closed_folio_balance_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseClosedFolioBalances(document)
      };
    case "operator_transaction_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate: extractBestWesternBusinessDate(document) ?? reportDate,
        propertyName,
        propertySlug,
        rows: parseOperatorTransactions(document, extractBestWesternBusinessDate(document) ?? reportDate)
      };
    case "advance_deposit_activity_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseAdvanceDepositActivity(document)
      };
    case "booked_reservations_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseBookedReservations(document)
      };
    case "direct_bill_aging_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseDirectBillAging(document)
      };
    case "direct_bill_ledger_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseDirectBillLedger(document)
      };
    case "final_audit_metric_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseFinalAudit(document)
      };
    case "high_balance_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseHighBalanceReport(document)
      };
    case "hotel_statistics_metric_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseHotelStatistics(document)
      };
    case "in_house_guest_folio_balance_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseInHouseGuestFolioBalances(document)
      };
    case "maintenance_summary_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseMaintenanceSummary(document)
      };
    case "occupancy_forecast_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseOccupancyForecast(document)
      };
    case "rate_override_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseRateOverride(document)
      };
    case "rate_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseRateReport(document)
      };
    case "reservation_listing_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseReservationListing(document)
      };
    case "tax_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseTaxReport(document)
      };
    case "trial_balance_report_rows":
      return {
        reportType,
        reportTitle: REPORT_TITLES[reportType],
        reportDate,
        propertyName,
        propertySlug,
        rows: parseTrialBalanceReport(document)
      };
    default:
      throw new UnsupportedReportError(`Unsupported report type: ${String(reportType)}`);
  }
}

const ALL_NIGHT_AUDIT_STANDALONE_TITLES = [
  "Authorized Payments Report",
  "Breakfast And Packages",
  "Departures List",
  "House Account Folio Balances",
  "Maintenance Activity",
  "No Show & Late Cancel",
  "Room Count Summary"
] as const;

const ALL_NIGHT_AUDIT_PACKET_TITLES = [
  "Business on The Books",
  "Cancellation List",
  "Hotel Statistics",
  "No Show Report",
  "Rate Discrepancy Report",
  "Reservation Activity Report"
] as const;

const CHOICE_AUDIT_PACKET_PAGE_TITLES = [
  "A/R Aging",
  "Advance Deposit Ledger",
  "Cancellation List",
  "City Tax Report",
  "Complimentary Rooms Report",
  "Final Transaction Closeout",
  "Guest Ledger",
  "Hotel Journal Detail",
  "Hotel Journal Summary",
  "Hotel Statistics",
  "Ledger Summary",
  "Revenue by Rate Code",
  "Tax Exempt Report"
] as const;

function detectReportType(document: PdfDocumentText): ReportType {
  const firstPageText = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 12)
    .map((line) => line.text)
    .join("\n");

  if (firstPageText.includes("History and Forecast")) {
    return "history_forecast_rows";
  }
  if (firstPageText.includes("Manager - Flash Last Day")) {
    return "manager_flash_metric_rows";
  }
  if (firstPageText.includes("Reservations - made Yesterday")) {
    return "reservations_made_yesterday_rows";
  }
  if (firstPageText.includes("Zero Rate Rooms")) {
    return "zero_rate_room_rows";
  }
  if (firstPageText.includes("AR Detailed Aging")) {
    return "ar_detailed_aging_rows";
  }
  if (firstPageText.includes("Rate Change Report")) {
    return "rate_change_rows";
  }
  if (isChoiceAuditPacket(document)) {
    return "choice_audit_packet_rows";
  }
  if (isAllNightAuditPacket(document)) {
    return "all_night_audit_report_rows";
  }
  if (ALL_NIGHT_AUDIT_STANDALONE_TITLES.some((title) => firstPageText.includes(title))) {
    return "all_night_audit_report_rows";
  }
  if (firstPageText.includes("Daily Report") && firstPageText.includes("Statistical Recap")) {
    return "best_western_daily_report_rows";
  }
  if (firstPageText.includes("Adjustments and Refunds Activity")) {
    return "adjustment_refund_activity_rows";
  }
  if (firstPageText.includes("All Transactions")) {
    return "all_transaction_rows";
  }
  if (firstPageText.includes("Room & Tax Listing")) {
    return "room_tax_listing_rows";
  }
  if (firstPageText.includes("Daily Transaction Log")) {
    return "daily_transaction_log_rows";
  }
  if (firstPageText.includes("Credit Card Transactions")) {
    return "credit_card_transaction_rows";
  }
  if (firstPageText.includes("Closed Folio Balances")) {
    return "closed_folio_balance_rows";
  }
  if (firstPageText.includes("Operator Transactions")) {
    return "operator_transaction_rows";
  }
  if (firstPageText.includes("Advance Deposit Activity")) {
    return "advance_deposit_activity_rows";
  }
  if (firstPageText.includes("Booked Reservations")) {
    return "booked_reservations_rows";
  }
  if (firstPageText.includes("Direct Bill Aging")) {
    return "direct_bill_aging_rows";
  }
  if (firstPageText.includes("Direct Bill Ledger Details")) {
    return "direct_bill_ledger_rows";
  }
  if (firstPageText.includes("Final Audit")) {
    return "final_audit_metric_rows";
  }
  if (firstPageText.includes("High Balance Report")) {
    return "high_balance_report_rows";
  }
  if (firstPageText.includes("Hotel Statistics")) {
    return "hotel_statistics_metric_rows";
  }
  if (firstPageText.includes("In House Guest Folio Balances")) {
    return "in_house_guest_folio_balance_rows";
  }
  if (firstPageText.includes("Maintenance Summary")) {
    return "maintenance_summary_rows";
  }
  if (firstPageText.includes("Occupancy Forecast")) {
    return "occupancy_forecast_rows";
  }
  if (firstPageText.includes("Rate Override")) {
    return "rate_override_rows";
  }
  if (firstPageText.includes("Rate Report")) {
    return "rate_report_rows";
  }
  if (firstPageText.includes("Reservations")) {
    return "reservation_listing_rows";
  }
  if (firstPageText.includes("Tax Report")) {
    return "tax_report_rows";
  }
  if (firstPageText.includes("Trial Balance Report")) {
    return "trial_balance_report_rows";
  }

  throw new UnsupportedReportError("The PDF title does not match any known report family.");
}

function isChoiceAuditPacket(document: PdfDocumentText): boolean {
  const titles = new Set(
    document.lines
      .map((line) => line.text.trim())
      .filter((text): text is (typeof CHOICE_AUDIT_PACKET_PAGE_TITLES)[number] => (
        CHOICE_AUDIT_PACKET_PAGE_TITLES.includes(text as (typeof CHOICE_AUDIT_PACKET_PAGE_TITLES)[number])
      ))
  );

  return titles.has("A/R Aging")
    && (titles.has("Advance Deposit Ledger") || titles.has("Hotel Journal Detail") || titles.has("Final Transaction Closeout"));
}

function isAllNightAuditPacket(document: PdfDocumentText): boolean {
  const titles = new Set(
    document.lines
      .map((line) => line.text.trim())
      .filter((text): text is (typeof ALL_NIGHT_AUDIT_PACKET_TITLES)[number] => (
        ALL_NIGHT_AUDIT_PACKET_TITLES.includes(text as (typeof ALL_NIGHT_AUDIT_PACKET_TITLES)[number])
      ))
  );

  return titles.has("Reservation Activity Report") && titles.size >= 2;
}

function extractReportDate(document: PdfDocumentText): string | null {
  const candidates = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 30)
    .map((line) => line.text.trim())
    .filter(Boolean);

  for (const text of candidates) {
    if (/report run date:/i.test(text) || /report run time:/i.test(text) || /^user:/i.test(text)) {
      continue;
    }

    const labeled = text.match(/\b(?:Business Date|Current Business Day|Date)\s*:\s*(.+)$/i);
    if (labeled) {
      const parsedLabeled = parseDateToken(labeled[1]);
      if (parsedLabeled) {
        return parsedLabeled;
      }
    }

    const dateRange = text.match(/\bDate Range\s*:\s*(.+)$/i);
    if (dateRange) {
      const rangeStart = String(dateRange[1]).split("-")[0] ?? "";
      const parsedRangeStart = parseDateToken(rangeStart);
      if (parsedRangeStart) {
        return parsedRangeStart;
      }
    }

    const parsedLoose = parseDateToken(text);
    if (parsedLoose) {
      return parsedLoose;
    }
  }

  return null;
}

function parseDateToken(value: string): string | null {
  const shortMatch = value.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/);
  if (shortMatch) {
    return parseShortDate(shortMatch[0]);
  }

  const longMatch = value.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
  if (longMatch) {
    return parseLongDate(longMatch[0]);
  }

  return null;
}

function parseMonthDayWithReferenceYear(value: string | null | undefined, referenceDate: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const direct = parseShortDate(normalized);
  if (direct) {
    return direct;
  }

  const monthDay = normalized.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!monthDay || !referenceDate) {
    return null;
  }

  const [, rawMonth, rawDay] = monthDay;
  const year = referenceDate.slice(0, 4);
  return parseShortDate(`${rawMonth.padStart(2, "0")}/${rawDay.padStart(2, "0")}/${year}`);
}

function extractPropertyName(document: PdfDocumentText): string | null {
  const propertyHeader = extractNamedPropertyHeader(document);
  if (propertyHeader) {
    return propertyHeader;
  }

  const candidates = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 8);

  for (let index = 0; index < candidates.length; index += 1) {
    const line = candidates[index].text;
    const nextLine = candidates[index + 1]?.text ?? null;
    const stripped = normalizeDetectedPropertyName(
      line
        .replace(/\s+\d{2}-\d{2}-\d{2}$/, "")
        .replace(/\s+\d{2}:\d{2}$/, "")
        .trim(),
      nextLine
    );
    if (!stripped || isNonPropertyHeader(stripped)) {
      continue;
    }
    if (/\bHotel\b/i.test(stripped) || /\bInn\b/i.test(stripped) || /\bSuites\b/i.test(stripped) || /\bResort\b/i.test(stripped)) {
      return normalizePropertyName(stripped);
    }
  }

  return null;
}

function extractVisibleReportTitle(document: PdfDocumentText): string | null {
  const candidates = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 12)
    .map((line) => line.text.trim())
    .filter(Boolean);

  for (const line of candidates) {
    if (isNonPropertyHeader(line) || shouldSkipVisibleTitleLine(line)) {
      continue;
    }
    if (/\bHotel\b/i.test(line) || /\bInn\b/i.test(line) || /\bSuites\b/i.test(line) || /\bResort\b/i.test(line)) {
      continue;
    }
    return normalizePropertyName(line);
  }

  return null;
}

function extractNamedPropertyHeader(document: PdfDocumentText): string | null {
  const propertyLine = document.lines.find((line) => /^Property Name:/i.test(line.text.trim()));
  if (!propertyLine) {
    return null;
  }

  const name = normalizePropertyName(propertyLine.text.replace(/^Property Name:\s*/i, ""));
  if (!name) {
    return null;
  }

  const codeLine = document.lines.find((line) => /Property Code:/i.test(line.text));
  const codeMatch = codeLine?.text.match(/Property Code:\s*([A-Z0-9-]+)/i) ?? null;
  const code = codeMatch?.[1] ? codeMatch[1].toUpperCase() : null;
  return normalizePropertyName(code ? `${name} ${code}` : name);
}

const ALL_NIGHT_AUDIT_VALUE_NOTE = [
  "value_1=primary_rooms",
  "value_2=primary_people",
  "value_3=secondary_rooms",
  "value_4=secondary_people",
  "value_5=tertiary_rooms",
  "value_6=tertiary_people",
  "value_7=tentative_rooms",
  "value_8=tentative_people",
  "value_9=total_occupied_rooms",
  "value_10=total_people",
  "value_11=restriction_rooms",
  "value_12=occupancy_pct",
  "value_13=comps",
  "value_14=room_revenue",
  "value_15=revpar",
  "value_16=adr"
].join("; ");

function extractAllNightAuditBusinessDate(document: PdfDocumentText): string | null {
  for (const line of document.lines.slice(0, 30)) {
    const businessDate = line.text.match(/\bBusiness Date:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i);
    if (businessDate) {
      return parseShortDate(businessDate[1]);
    }

    const dateRange = line.text.match(/\bDate Range:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i);
    if (dateRange) {
      return parseShortDate(dateRange[1]);
    }
  }

  return null;
}

function extractChoiceAuditPacketBusinessDate(document: PdfDocumentText): string | null {
  for (const line of document.lines.slice(0, 40)) {
    const businessDate = line.text.match(/\bBusiness Date:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i);
    if (businessDate) {
      return parseShortDate(businessDate[1]);
    }

    const dateRange = line.text.match(/\bDate Range:\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i);
    if (dateRange) {
      return parseShortDate(dateRange[1]);
    }
  }

  return null;
}

type ChoiceAuditRow = Record<string, string | null>;

const CHOICE_AR_AGING_NOTE = [
  "value_1=current_amount",
  "value_2=days_30_amount",
  "value_3=days_60_amount",
  "value_4=days_90_amount",
  "value_5=days_120_amount",
  "value_6=credits_amount",
  "value_7=balance_amount",
  "value_8=limit_amount"
].join("; ");

const CHOICE_CITY_TAX_NOTE_PREFIX = [
  "value_1=month_1_tax",
  "value_2=month_1_adults",
  "value_3=month_2_tax",
  "value_4=month_2_adults",
  "value_5=month_3_tax",
  "value_6=month_3_adults"
].join("; ");

const CHOICE_FINAL_TRANSACTION_NOTE = [
  "value_1=opening_balance",
  "value_2=corrections",
  "value_3=adjustments",
  "value_4=todays_net",
  "value_5=ptd_totals",
  "value_6=ytd_totals"
].join("; ");

const CHOICE_HOTEL_JOURNAL_SUMMARY_NOTE = [
  "value_1=postings",
  "value_2=corrections",
  "value_3=adjustments",
  "value_4=totals",
  "value_5=guest_ledger",
  "value_6=ar_ledger",
  "value_7=advance_deposit_ledger",
  "value_8=transactions",
  "value_9=post_count",
  "value_10=correction_count",
  "value_11=adjustment_count"
].join("; ");

const CHOICE_HOTEL_STATISTICS_NOTE = [
  "value_1=current",
  "value_2=ptd",
  "value_3=last_year_ptd",
  "value_4=ytd",
  "value_5=last_ytd"
].join("; ");

const CHOICE_REVENUE_BY_RATE_CODE_NOTE = [
  "value_1=daily_nights",
  "value_2=daily_room_pct",
  "value_3=daily_revenue",
  "value_4=daily_revenue_pct",
  "value_5=daily_avg",
  "value_6=ptd_nights",
  "value_7=ptd_room_pct",
  "value_8=ptd_revenue",
  "value_9=ptd_revenue_pct",
  "value_10=ptd_avg",
  "value_11=ytd_nights",
  "value_12=ytd_room_pct",
  "value_13=ytd_revenue",
  "value_14=ytd_revenue_pct",
  "value_15=ytd_avg"
].join("; ");

export function parseChoiceAuditPacketDocument(document: PdfDocumentText): Array<Record<string, string | null>> {
  return parseChoiceAuditPacket(document);
}

function parseChoiceAuditPacket(document: PdfDocumentText): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const pages = groupLinesByPage(document.lines);

  for (const page of pages) {
    const reportName = extractChoiceAuditPacketPageTitle(page);
    if (!reportName) {
      continue;
    }

    rows.push(...parseChoiceAuditPacketPage(page, reportName, document));
  }

  return rows;
}

function parseChoiceAuditPacketPage(
  page: PdfLine[],
  reportName: string,
  document: PdfDocumentText
): ChoiceAuditRow[] {
  switch (reportName) {
    case "A/R Aging":
      return parseChoiceArAgingPage(page, reportName);
    case "Advance Deposit Ledger":
      return parseChoiceAdvanceDepositLedgerPage(page, reportName, document);
    case "Cancellation List":
      return parseChoiceCancellationListPage(page, reportName, document);
    case "City Tax Report":
      return parseChoiceCityTaxReportPage(page, reportName);
    case "Complimentary Rooms Report":
      return parseChoiceComplimentaryRoomsPage(page, reportName);
    case "Final Transaction Closeout":
      return parseChoiceFinalTransactionCloseoutPage(page, reportName);
    case "Guest Ledger":
      return parseChoiceGuestLedgerPage(page, reportName, document);
    case "Hotel Journal Detail":
      return parseChoiceHotelJournalDetailPage(page, reportName, document);
    case "Hotel Journal Summary":
      return parseChoiceHotelJournalSummaryPage(page, reportName);
    case "Hotel Statistics":
      return parseChoiceHotelStatisticsPage(page, reportName);
    case "Revenue by Rate Code":
      return parseChoiceRevenueByRateCodePage(page, reportName);
    case "Tax Exempt Report":
      return parseChoiceTaxExemptReportPage(page, reportName);
    default:
      return parseChoiceAuditPacketGenericPage(page, reportName);
  }
}

function parseChoiceAuditPacketGenericPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  let section: string | null = null;

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketHeaderOrFooter(text, reportName)) {
      continue;
    }

    if (isChoiceAuditPacketSectionLine(text)) {
      section = text;
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    rows.push(createChoiceAuditRow(
      line,
      reportName,
      section,
      isChoiceAuditPacketTotalLine(text) ? "total" : "detail",
      text
    ));
  }

  return rows;
}

function parseChoiceArAgingPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName) || text.startsWith("Account Name Current")) {
      continue;
    }

    const rowKind = /^Grand Total:/i.test(text) ? "total" : "detail";
    const row = createChoiceAuditRow(line, reportName, null, rowKind, text);
    row.metric_name = rowKind === "total" ? "Grand Total" : null;
    row.account_number = rowKind === "detail" ? normalizeText(sliceText(line, 37, 99)) : null;
    row.account_name = rowKind === "detail" ? normalizeText(sliceText(line, 99, 301)) : null;
    setChoiceMetricValues(row, [
      normalizeFlexibleNumeric(sliceText(line, 301, 359)),
      normalizeFlexibleNumeric(sliceText(line, 359, 427)),
      normalizeFlexibleNumeric(sliceText(line, 427, 487)),
      normalizeFlexibleNumeric(sliceText(line, 487, 541)),
      normalizeFlexibleNumeric(sliceText(line, 541, 602)),
      normalizeFlexibleNumeric(sliceText(line, 602, 662)),
      normalizeFlexibleNumeric(sliceText(line, 662, 719)),
      normalizeFlexibleNumeric(sliceText(line, 719, 790))
    ]);
    row.balance_amount = row.value_7 ?? null;
    row.note = CHOICE_AR_AGING_NOTE;
    if (rowKind === "detail" && !row.account_number && !row.account_name) {
      continue;
    }
    rows.push(row);
  }

  return rows;
}

function parseChoiceAdvanceDepositLedgerPage(
  page: PdfLine[],
  reportName: string,
  document: PdfDocumentText
): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const referenceDate = extractChoiceAuditPacketBusinessDate(document);
  let section: string | null = null;

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName) || text.startsWith("Status Name Account Arrival Balance")) {
      continue;
    }

    if (text === "Guest Accounts" || text === "Group Master Accounts") {
      section = text;
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    const rowKind = isChoiceAuditPacketTotalLine(text) ? "total" : "detail";
    const row = createChoiceAuditRow(line, reportName, section, rowKind, text);
    row.balance_amount = normalizeFlexibleNumeric(sliceText(line, 518, 620));
    if (rowKind === "total") {
      row.metric_name = normalizeText(text.replace(/:\s*.*$/, ""));
      rows.push(row);
      continue;
    }

    row.status = normalizeText(sliceText(line, 63, 118));
    row.guest_name = normalizeText(sliceText(line, 118, 353));
    row.account_number = normalizeText(sliceText(line, 353, 428));
    row.arrival_date = parseMonthDayWithReferenceYear(sliceText(line, 428, 518), referenceDate);
    if (!row.guest_name && !row.account_number) {
      continue;
    }
    rows.push(row);
  }

  return rows;
}

function parseChoiceCancellationListPage(
  page: PdfLine[],
  reportName: string,
  document: PdfDocumentText
): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const referenceDate = extractChoiceAuditPacketBusinessDate(document);
  const detailLines = page.filter((line) => {
    const text = line.text.trim();
    return Boolean(text)
      && !isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      && text !== "Company Group"
      && !text.startsWith("Account Guest Name Arrival Nights");
  });

  const blocks = collectLineBlocks(
    detailLines,
    (line) => /^\d+$/.test(sliceText(line, 38, 101)),
    (line) => /^Total Cancellations:/i.test(line.text.trim())
  );

  for (const block of blocks) {
    const base = block[0];
    const row = createChoiceAuditRow(base, reportName, null, "detail", formatChoiceBlockText(block));
    row.account_number = normalizeText(sliceText(base, 38, 101));
    row.guest_name = normalizeText(sliceText(base, 101, 266));
    row.arrival_date = parseMonthDayWithReferenceYear(sliceText(base, 266, 345), referenceDate);
    row.nights = normalizeFlexibleNumeric(sliceText(base, 345, 379));
    row.rate_code = normalizeText(sliceText(base, 379, 442));
    row.guarantee_type = normalizeText(sliceText(base, 442, 468));
    row.source_code = normalizeText(sliceText(base, 468, 511));
    row.room_type = normalizeText(sliceText(base, 511, 562));
    row.cancel_code = joinSlices(block, 562, 620);
    row.cancel_date = parseMonthDayWithReferenceYear(sliceText(base, 620, 665), referenceDate);
    row.cancel_clock = joinCompactSlices(block, 665, 730);
    rows.push(row);
  }

  const totalLine = detailLines.find((line) => /^Total Cancellations:/i.test(line.text.trim()));
  if (totalLine) {
    const row = createChoiceAuditRow(totalLine, reportName, null, "total", totalLine.text.trim());
    row.metric_name = "Total Cancellations";
    row.value_1 = normalizeFlexibleNumeric(totalLine.text.split(":")[1] ?? "");
    rows.push(row);
  }

  return rows;
}

function parseChoiceCityTaxReportPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const monthLabels = extractChoiceCityTaxMonthLabels(page);
  const note = monthLabels.length > 0
    ? `${CHOICE_CITY_TAX_NOTE_PREFIX}; month_1=${monthLabels[0] ?? ""}; month_2=${monthLabels[1] ?? ""}; month_3=${monthLabels[2] ?? ""}`
    : CHOICE_CITY_TAX_NOTE_PREFIX;

  for (const line of page) {
    const text = line.text.trim();
    if (!text
      || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      || text === monthLabels.join(" ")
      || text.startsWith("Day Tax Adults")) {
      continue;
    }

    const day = normalizeText(sliceText(line, 38, 75));
    if (!day || !/^\d+$/.test(day)) {
      continue;
    }

    const row = createChoiceAuditRow(line, reportName, null, "detail", text);
    row.metric_name = day;
    setChoiceMetricValues(row, [
      normalizeFlexibleNumeric(sliceText(line, 75, 120)),
      normalizeFlexibleNumeric(sliceText(line, 120, 160)),
      normalizeFlexibleNumeric(sliceText(line, 190, 235)),
      normalizeFlexibleNumeric(sliceText(line, 235, 270)),
      normalizeFlexibleNumeric(sliceText(line, 303, 350)),
      normalizeFlexibleNumeric(sliceText(line, 350, 390))
    ]);
    row.note = note;
    rows.push(row);
  }

  return rows;
}

function parseChoiceComplimentaryRoomsPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName) || text === "Code") {
      continue;
    }

    const rowKind = isChoiceAuditPacketTotalLine(text) ? "total" : "detail";
    const row = createChoiceAuditRow(line, reportName, null, rowKind, text);
    if (rowKind === "total") {
      row.metric_name = "Total Comps";
      row.value_1 = normalizeFlexibleNumeric(text.split(":")[1] ?? "");
    }
    rows.push(row);
  }

  return rows;
}

function parseChoiceFinalTransactionCloseoutPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  let section: string | null = null;
  let pendingLabel: string[] = [];
  let unlabeledCount = 0;

  for (const line of page) {
    const text = line.text.trim();
    if (!text
      || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      || text === "Today's"
      || text === "Today's Totals"
      || text === "Opening (Include Today's"
      || text.startsWith("Description (Transaction Code)")) {
      continue;
    }

    if (/^Transaction Type:/i.test(text)) {
      section = text;
      pendingLabel = [];
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    const metric = extractChoiceFlexibleMetricLine(text, 6);
    if (!metric) {
      pendingLabel.push(text);
      continue;
    }

    const metricName = normalizeText([...pendingLabel, metric.label].filter(Boolean).join(" "));
    const row = createChoiceAuditRow(
      line,
      reportName,
      section,
      metricName && /^Total For /i.test(metricName) ? "total" : "detail",
      buildChoiceMetricLineText(pendingLabel, text)
    );
    pendingLabel = [];
    if (metricName) {
      row.metric_name = metricName;
    } else {
      unlabeledCount += 1;
      row.metric_name = `Row ${unlabeledCount}`;
    }
    const { description, code } = splitChoiceLabelAndCode(row.metric_name);
    row.transaction_description = description;
    row.transaction_code = code;
    setChoiceMetricValues(row, metric.values);
    row.note = CHOICE_FINAL_TRANSACTION_NOTE;
    rows.push(row);
  }

  return rows;
}

function parseChoiceGuestLedgerPage(
  page: PdfLine[],
  reportName: string,
  document: PdfDocumentText
): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const referenceDate = extractChoiceAuditPacketBusinessDate(document);
  let section: string | null = null;

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName) || text.startsWith("Status Name Account Room Arrival Departure Balance")) {
      continue;
    }

    if (text === "Guest Accounts" || text === "Group Master Accounts" || text === "In House Accounts" || text === "Guest Ledger Summary") {
      section = text;
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    if (/^Subtotal\b/i.test(text) || /^Total For /i.test(text)) {
      const row = createChoiceAuditRow(line, reportName, section, "total", text);
      row.metric_name = normalizeText(text.replace(/:\s*.*$/, ""));
      row.balance_amount = normalizeFlexibleNumeric(sliceText(line, 517, 620));
      rows.push(row);
      continue;
    }

    const status = normalizeText(sliceText(line, 42, 112));
    if (!status) {
      continue;
    }

    const row = createChoiceAuditRow(line, reportName, section, "detail", text);
    row.status = status;
    row.guest_name = normalizeText(sliceText(line, 112, 254));
    row.account_number = normalizeText(sliceText(line, 254, 322));
    row.room_number = normalizeText(sliceText(line, 322, 380));
    row.arrival_date = parseMonthDayWithReferenceYear(sliceText(line, 380, 446), referenceDate);
    row.departure_date = parseMonthDayWithReferenceYear(sliceText(line, 446, 522), referenceDate);
    row.balance_amount = normalizeFlexibleNumeric(sliceText(line, 522, 620));
    rows.push(row);
  }

  return rows;
}

function parseChoiceHotelJournalDetailPage(
  page: PdfLine[],
  reportName: string,
  document: PdfDocumentText
): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  const referenceDate = extractChoiceAuditPacketBusinessDate(document);
  const lines = page.filter((line) => {
    const text = line.text.trim();
    return Boolean(text)
      && !isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      && text !== "ID Account Comment"
      && !text.startsWith("Date Posting Date User ID");
  });

  let currentSection: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const text = line.text.trim();

    if (/^Transaction Code:/i.test(text)) {
      currentSection = text;
      rows.push(createChoiceAuditRow(line, reportName, currentSection, "section", text));
      index += 1;
      continue;
    }

    if (/^Total For /i.test(text)) {
      const row = createChoiceAuditRow(line, reportName, currentSection, "total", text);
      row.metric_name = normalizeText(text.replace(/:\s*.*$/, ""));
      row.amount = normalizeFlexibleNumeric(sliceText(line, 613, 664));
      row.adjustment_amount = normalizeFlexibleNumeric(sliceText(line, 664, 730));
      const { description, code } = splitChoiceLabelAndCode(currentSection);
      row.transaction_description = description;
      row.transaction_code = code;
      rows.push(row);
      index += 1;
      continue;
    }

    if (looksLikeChoiceJournalDetailStart(line, referenceDate)) {
      const block = [line];
      index += 1;
      while (index < lines.length
        && !/^Transaction Code:/i.test(lines[index].text.trim())
        && !/^Total For /i.test(lines[index].text.trim())
        && !looksLikeChoiceJournalDetailStart(lines[index], referenceDate)) {
        block.push(lines[index]);
        index += 1;
      }

      rows.push(buildChoiceHotelJournalDetailRow(block, reportName, currentSection, referenceDate));
      continue;
    }

    const row = createChoiceAuditRow(line, reportName, currentSection, "detail", text);
    row.metric_name = text;
    row.note = "journal_subheader";
    const { description, code } = splitChoiceLabelAndCode(currentSection);
    row.transaction_description = description;
    row.transaction_code = code;
    rows.push(row);
    index += 1;
  }

  return rows;
}

function parseChoiceHotelJournalSummaryPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];

  for (const line of page) {
    const text = line.text.trim();
    if (!text
      || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      || text.startsWith("Description (Transaction Code)")
      || text === "*Revenues do not include taxes") {
      continue;
    }

    const metric = extractChoiceFlexibleMetricLine(text, 11);
    if (!metric) {
      continue;
    }

    const row = createChoiceAuditRow(
      line,
      reportName,
      null,
      /^Today's Total:/i.test(text) ? "total" : "detail",
      text
    );
    row.metric_name = metric.label ?? null;
    const { description, code } = splitChoiceLabelAndCode(row.metric_name);
    row.transaction_description = description;
    row.transaction_code = code;
    setChoiceMetricValues(row, metric.values);
    row.note = CHOICE_HOTEL_JOURNAL_SUMMARY_NOTE;
    rows.push(row);
  }

  return rows;
}

function parseChoiceHotelStatisticsPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  let section: string | null = null;

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)) {
      continue;
    }

    const sectionName = extractChoiceHotelStatisticsSection(text);
    if (sectionName) {
      section = sectionName;
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    const metric = extractChoiceFlexibleMetricLine(text, 5);
    if (!metric) {
      continue;
    }

    const row = createChoiceAuditRow(line, reportName, section, "detail", text);
    row.metric_name = metric.label ?? null;
    setChoiceMetricValues(row, metric.values);
    row.note = CHOICE_HOTEL_STATISTICS_NOTE;
    rows.push(row);
  }

  return rows;
}

function parseChoiceRevenueByRateCodePage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];

  for (const line of page) {
    const text = line.text.trim();
    if (!text
      || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
      || text === "YTD"
      || text.startsWith("Room Room Daily PTD Room PTD Room Room YTD Room YTD")
      || text.startsWith("Rate Code Nights % Revenue % AVG")) {
      continue;
    }

    const metric = extractChoiceFlexibleMetricLine(text, 15);
    if (!metric) {
      continue;
    }

    const row = createChoiceAuditRow(
      line,
      reportName,
      null,
      metric.label && /^Total/i.test(metric.label) ? "total" : "detail",
      text
    );
    row.metric_name = metric.label ?? null;
    row.rate_code = metric.label ?? null;
    setChoiceMetricValues(row, metric.values);
    row.note = CHOICE_REVENUE_BY_RATE_CODE_NOTE;
    rows.push(row);
  }

  return rows;
}

function parseChoiceTaxExemptReportPage(page: PdfLine[], reportName: string): ChoiceAuditRow[] {
  const rows: ChoiceAuditRow[] = [];
  let section: string | null = null;

  for (const line of page) {
    const text = line.text.trim();
    if (!text || isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)) {
      continue;
    }

    if (text === "Tax Exempt Revenue Summary - By Tax:"
      || text === "Tax Exempt Revenue Summary - By Transaction Code:"
      || text === "Tax Refund Revenue Summary - By Transaction Code:") {
      section = text;
      rows.push(createChoiceAuditRow(line, reportName, section, "section", text));
      continue;
    }

    if (text === "Tax T1 T2 T3 T4"
      || text === "Transaction Code RM Total Tax Exempt Revenue"
      || text === "Transaction Code RM Total Refund Revenue") {
      continue;
    }

    if (text.startsWith("Current Tax Configuration")) {
      const row = createChoiceAuditRow(line, reportName, section, "detail", text);
      row.metric_name = "Current Tax Configuration";
      setChoiceMetricValues(row, [
        normalizeFlexibleNumeric(sliceText(line, 283, 320)),
        normalizeFlexibleNumeric(sliceText(line, 338, 370)),
        normalizeFlexibleNumeric(sliceText(line, 398, 430)),
        normalizeFlexibleNumeric(sliceText(line, 463, 520))
      ]);
      row.note = "value_1=t1_pct; value_2=t2_pct; value_3=t3_pct; value_4=t4_pct";
      rows.push(row);
      continue;
    }

    if (text === "Total:") {
      rows.push(createChoiceAuditRow(line, reportName, section, "total", text));
      continue;
    }

    const byTaxMatch = text.match(/^(.*?-YTD)\s+(.+)$/);
    if (byTaxMatch) {
      const row = createChoiceAuditRow(line, reportName, section, "detail", text);
      row.metric_name = normalizeText(byTaxMatch[1]);
      if (section === "Tax Exempt Revenue Summary - By Tax:") {
        setChoiceMetricValues(row, [
          normalizeFlexibleNumeric(sliceText(line, 315, 350)),
          normalizeFlexibleNumeric(sliceText(line, 375, 410)),
          normalizeFlexibleNumeric(sliceText(line, 440, 475)),
          normalizeFlexibleNumeric(sliceText(line, 491, 540))
        ]);
        row.note = "value_1=t1; value_2=t2; value_3=t3; value_4=t4";
      } else {
        setChoiceMetricValues(row, [
          normalizeFlexibleNumeric(sliceText(line, 392, 430)),
          normalizeFlexibleNumeric(sliceText(line, 485, 540))
        ]);
        row.note = "value_1=transaction_code_amount; value_2=total_amount";
      }
      rows.push(row);
      continue;
    }

    rows.push(createChoiceAuditRow(line, reportName, section, "detail", text));
  }

  return rows;
}

function buildChoiceHotelJournalDetailRow(
  block: PdfLine[],
  reportName: string,
  section: string | null,
  referenceDate: string | null
): ChoiceAuditRow {
  const base = block[0];
  const row = createChoiceAuditRow(base, reportName, section, "detail", formatChoiceBlockText(block));
  const postingToken = normalizeText(sliceText(base, 93, 180));
  const postingParts = postingToken?.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+)$/) ?? null;
  row.posting_date = postingParts ? parseMonthDayWithReferenceYear(postingParts[1], referenceDate) : null;
  row.posting_time = postingParts ? normalizeText(postingParts[2]) : null;
  row.user_id = joinCompactText([sliceText(base, 180, 246), ...block.slice(1).map((line) => sliceText(line, 180, 246))]);
  row.shift = normalizeText(sliceText(base, 246, 272));
  row.room_number = normalizeText(sliceText(base, 272, 308));
  row.account_type = normalizeText(sliceText(base, 308, 380));
  row.guest_name = normalizeText(sliceText(base, 380, 613));
  row.amount = normalizeFlexibleNumeric(sliceText(base, 613, 664));
  row.adjustment_amount = normalizeFlexibleNumeric(sliceText(base, 664, 730));
  row.reference_id = joinCompactSlices(block.slice(1), 308, 380);
  row.comment = joinSlices(block.slice(1), 380, 640);
  const { description, code } = splitChoiceLabelAndCode(section);
  row.transaction_description = description;
  row.transaction_code = code;
  return row;
}

function createChoiceAuditRow(
  line: PdfLine,
  reportName: string,
  section: string | null,
  rowKind: string,
  lineText: string
): ChoiceAuditRow {
  return {
    page_number: String(line.pageNumber),
    report_name: reportName,
    section,
    row_kind: rowKind,
    line_text: lineText
  };
}

function setChoiceMetricValues(row: ChoiceAuditRow, values: Array<string | null | undefined>): void {
  for (let index = 0; index < values.length; index += 1) {
    row[`value_${index + 1}`] = values[index] ?? null;
  }
}

function extractChoiceFlexibleMetricLine(text: string, maxValues: number): { label: string | null; values: string[] } | null {
  const normalized = text.replace(/(\d)\s+%/g, "$1%");
  const tokenPattern = /(^|\s)(\(?-?(?:USD|\$)?\d[\d,]*(?:\.\d+)?\)?-?%?)/g;
  const tokens = Array.from(normalized.matchAll(tokenPattern)).map((match) => ({
    index: (match.index ?? 0) + match[1].length,
    value: match[2]
  }));
  if (tokens.length === 0 || tokens.length > maxValues) {
    return null;
  }

  const label = normalizeText(normalized.slice(0, tokens[0].index));
  const values = tokens.map((token) => normalizeFlexibleNumeric(token.value) ?? token.value);
  return { label, values };
}

function splitChoiceLabelAndCode(value: string | null | undefined): { description: string | null; code: string | null } {
  const normalized = normalizeText(value);
  if (!normalized) {
    return { description: null, code: null };
  }

  const stripped = normalized.replace(/^Transaction (?:Type|Code):\s*/i, "");
  const match = stripped.match(/^(.*?)(?:\s*\(([A-Za-z0-9/-]+)\))?$/);
  if (!match) {
    return { description: stripped, code: null };
  }

  return {
    description: normalizeText(match[1]),
    code: normalizeText(match[2] ?? null)
  };
}

function extractChoiceCityTaxMonthLabels(page: PdfLine[]): string[] {
  const monthLine = page.find((line) => line.items.length === 3 && line.items.every((item) => /^[A-Z][a-z]+$/.test(item.text)));
  return monthLine?.items.map((item) => item.text) ?? [];
}

function extractChoiceHotelStatisticsSection(text: string): string | null {
  for (const section of HOTEL_STATISTICS_SECTIONS) {
    if (text.startsWith(section)) {
      return section;
    }
  }

  return null;
}

function looksLikeChoiceJournalDetailStart(line: PdfLine, referenceDate: string | null): boolean {
  return Boolean(parseMonthDayWithReferenceYear(sliceText(line, 38, 90), referenceDate));
}

function formatChoiceBlockText(lines: PdfLine[]): string {
  return lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join(" | ");
}

function buildChoiceMetricLineText(pendingLabel: string[], text: string): string {
  return [...pendingLabel, text].filter(Boolean).join(" | ");
}

function isChoiceAuditPacketCommonHeaderOrFooter(text: string, reportName: string): boolean {
  return text === reportName
    || /^Property Name:/i.test(text)
    || /^Business Date:/i.test(text)
    || /^Date Range:/i.test(text)
    || /^Date\/Time of Printing:/i.test(text)
    || /^Data Complete as of:/i.test(text)
    || /^Software Version:/i.test(text)
    || /^Page \d+ of \d+/i.test(text);
}

function parseAllNightAuditReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const pageMap = groupLinesByPage(document.lines);
  const rows: Array<Record<string, string | null>> = [];

  rows.push(...parseAllNightAuditBusinessOnBooks(pageMap.filter((page) => hasPageTitle(page, "Business on The Books"))));
  rows.push(...parseAllNightAuditCancellationList(pageMap.find((page) => hasPageTitle(page, "Cancellation List")) ?? []));
  rows.push(...parseAllNightAuditHotelStatistics(pageMap.find((page) => hasPageTitle(page, "Hotel Statistics")) ?? []));
  rows.push(...parseAllNightAuditNoShow(pageMap.find((page) => hasPageTitle(page, "No Show Report")) ?? []));
  rows.push(...parseAllNightAuditRateDiscrepancy(pageMap.filter((page) => hasPageTitle(page, "Rate Discrepancy Report"))));
  rows.push(...parseAllNightAuditReservationActivity(pageMap.filter((page) => hasPageTitle(page, "Reservation Activity Report"))));

  if (rows.length === 0) {
    rows.push(...parseStandaloneAllNightAuditListing(document));
  }

  return rows;
}

function parseStandaloneAllNightAuditListing(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  const reportName = extractStandaloneAllNightAuditTitle(document) ?? "Operational Listing";

  for (const line of document.lines) {
    const text = normalizeText(line.text);
    if (!text || isAllNightStandaloneHeadingOrMeta(text)) {
      continue;
    }

    const cells = text
      .split(/\s{2,}/)
      .map((cell) => normalizeText(cell))
      .filter((cell): cell is string => Boolean(cell));
    if (cells.length === 0) {
      continue;
    }

    rows.push({
      report_name: reportName,
      section: "Standalone Listing",
      row_kind: "detail",
      date_value: null,
      metric_name: cells[0],
      account_no: null,
      guest_name: null,
      group_name: null,
      room_no: null,
      arrival_date: null,
      departure_date: null,
      nights: null,
      status: null,
      rate_amount: null,
      rate_plan: null,
      room_type: null,
      source: null,
      guarantee_type: null,
      user_name: null,
      cancel_code: null,
      cancel_date: null,
      cancel_clock: null,
      reference_no: null,
      configured_rate: null,
      guest_rate: null,
      difference: null,
      value_1: cells[1] ?? null,
      value_2: cells[2] ?? null,
      value_3: cells[3] ?? null,
      value_4: cells[4] ?? null,
      value_5: cells[5] ?? null,
      value_6: cells[6] ?? null,
      value_7: cells[7] ?? null,
      value_8: cells[8] ?? null,
      value_9: cells[9] ?? null,
      value_10: cells[10] ?? null,
      value_11: cells[11] ?? null,
      value_12: cells[12] ?? null,
      value_13: cells[13] ?? null,
      value_14: cells[14] ?? null,
      value_15: cells[15] ?? null,
      value_16: cells[16] ?? null,
      note: cells.length > 17 ? cells.slice(17).join(" | ") : null
    });
  }

  return rows;
}

function extractStandaloneAllNightAuditTitle(document: PdfDocumentText): string | null {
  const firstPageLines = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 20)
    .map((line) => normalizeText(line.text))
    .filter((line): line is string => Boolean(line));

  for (const line of firstPageLines) {
    if (ALL_NIGHT_AUDIT_STANDALONE_TITLES.includes(line as (typeof ALL_NIGHT_AUDIT_STANDALONE_TITLES)[number])) {
      return line;
    }
  }

  return null;
}

function isAllNightStandaloneHeadingOrMeta(text: string): boolean {
  return isAllNightAuditHeaderOrFooter(text)
    || text === "???"
    || ALL_NIGHT_AUDIT_STANDALONE_TITLES.includes(text as (typeof ALL_NIGHT_AUDIT_STANDALONE_TITLES)[number])
    || /^Date:\s+/i.test(text)
    || /^Date Range:\s+/i.test(text)
    || /^Page\d+\s*\/\s*\d+$/i.test(text)
    || /^Page\s+\d+\s+\/\s+\d+$/i.test(text)
    || /^PDTOR\s+Report run date:/i.test(text)
    || /^PDTOR\s+Report run time:/i.test(text)
    || /^User:/i.test(text)
    || /Confirmatio\s+Additional\s+Room\s+Guest\s+Check In\s+Status/i.test(text)
    || /Transaction\s+Confirmatio\s+Check In\s+Check Out\s+Guest/i.test(text)
    || /House\s+House\s+Type\s+Open Date\s+Close Date\s+Status/i.test(text)
    || /Room\s+Maintenanc\s+Reason\s+Start Date\s+End Date/i.test(text)
    || /Room\s+Number\s+Room\s+Type/i.test(text)
    || text === "Departures List"
    || text === "Authorized Payments"
    || text === "House Account Folio Balances"
    || text === "Maintenance Activity"
    || text === "Room Count Summary";
}

function parseAllNightAuditBusinessOnBooks(pages: PdfLine[][]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];

  for (const page of pages) {
    for (let index = 0; index < page.length; index += 1) {
      const line = page[index];
      const text = line.text;
      if (!text || isAllNightAuditHeaderOrFooter(text)) {
        continue;
      }

      if (/^\d{1,2}\/\d{1,2}\/\d{2}\b/.test(text)) {
        const [value2, value3] = splitAuditCell(sliceText(line, 156, 210));
        const [value5, value6] = splitAuditCell(sliceText(line, 266, 306));
        const [value10, value11] = splitAuditCell(sliceText(line, 448, 482));
        rows.push({
          report_name: "Business on The Books",
          section: null,
          row_kind: "daily",
          date_value: parseShortDate(sliceText(line, 52, 98)),
          metric_name: null,
          account_no: null,
          guest_name: null,
          group_name: null,
          room_no: null,
          arrival_date: null,
          departure_date: null,
          nights: null,
          status: null,
          rate_amount: null,
          rate_plan: null,
          room_type: null,
          source: null,
          guarantee_type: null,
          user_name: null,
          cancel_code: null,
          cancel_date: null,
          cancel_clock: null,
          reference_no: null,
          configured_rate: null,
          guest_rate: null,
          difference: null,
          value_1: normalizeFlexibleNumeric(sliceText(line, 136, 156)),
          value_2: value2,
          value_3: value3,
          value_4: normalizeFlexibleNumeric(sliceText(line, 238, 258)),
          value_5: value5,
          value_6: value6,
          value_7: normalizeFlexibleNumeric(sliceText(line, 328, 348)),
          value_8: normalizeFlexibleNumeric(sliceText(line, 386, 398)),
          value_9: normalizeFlexibleNumeric(sliceText(line, 426, 446)),
          value_10: value10,
          value_11: value11,
          value_12: normalizeFlexibleNumeric(sliceText(line, 486, 520)),
          value_13: normalizeFlexibleNumeric(sliceText(line, 556, 564)),
          value_14: normalizeFlexibleNumeric(sliceText(line, 566, 606)),
          value_15: normalizeFlexibleNumeric(sliceText(line, 620, 650)),
          value_16: normalizeFlexibleNumeric(sliceText(line, 660, 695)),
          note: ALL_NIGHT_AUDIT_VALUE_NOTE
        });
        continue;
      }

      if (text.startsWith("TOTAL/AVG")) {
        const continuation = page[index + 1] && /^\d+(?:\s+\d+)*$/.test(page[index + 1].text.trim())
          ? page[index + 1].text.trim()
          : null;
        rows.push({
          report_name: "Business on The Books",
          section: null,
          row_kind: "total_avg",
          date_value: null,
          metric_name: "TOTAL/AVG",
          account_no: null,
          guest_name: null,
          group_name: null,
          room_no: null,
          arrival_date: null,
          departure_date: null,
          nights: null,
          status: null,
          rate_amount: null,
          rate_plan: null,
          room_type: null,
          source: null,
          guarantee_type: null,
          user_name: null,
          cancel_code: null,
          cancel_date: null,
          cancel_clock: null,
          reference_no: null,
          configured_rate: null,
          guest_rate: null,
          difference: null,
          value_1: normalizeFlexibleNumeric(sliceText(line, 136, 156)),
          value_2: normalizeFlexibleNumeric(sliceText(line, 156, 180)),
          value_3: normalizeFlexibleNumeric(sliceText(line, 180, 210)),
          value_4: normalizeFlexibleNumeric(sliceText(line, 238, 258)),
          value_5: normalizeFlexibleNumeric(sliceText(line, 266, 286)),
          value_6: normalizeFlexibleNumeric(sliceText(line, 286, 306)),
          value_7: normalizeFlexibleNumeric(sliceText(line, 328, 348)),
          value_8: normalizeFlexibleNumeric(sliceText(line, 386, 398)),
          value_9: normalizeFlexibleNumeric(sliceText(line, 426, 446)),
          value_10: normalizeFlexibleNumeric(sliceText(line, 448, 468)),
          value_11: normalizeFlexibleNumeric(sliceText(line, 468, 482)),
          value_12: normalizeFlexibleNumeric(sliceText(line, 486, 520)),
          value_13: normalizeFlexibleNumeric(sliceText(line, 556, 564)),
          value_14: normalizeFlexibleNumeric(sliceText(line, 566, 606)),
          value_15: normalizeFlexibleNumeric(sliceText(line, 620, 650)),
          value_16: normalizeFlexibleNumeric(sliceText(line, 660, 695)),
          note: continuation ? `${ALL_NIGHT_AUDIT_VALUE_NOTE}; continuation=${continuation}` : ALL_NIGHT_AUDIT_VALUE_NOTE
        });
      }
    }
  }

  return rows;
}

function parseAllNightAuditCancellationList(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let block: PdfLine[] = [];

  const flushBlock = () => {
    if (block.length === 0) {
      return;
    }

    const first = block[0];
    const row: Record<string, string | null> = {
      report_name: "Cancellation List",
      section: null,
      row_kind: "reservation",
      date_value: null,
      metric_name: null,
      account_no: normalizeText(sliceText(first, 36, 100)),
      guest_name: normalizeText(sliceText(first, 100, 266)),
      group_name: null,
      room_no: null,
      arrival_date: parseShortDate(sliceText(first, 266, 336)),
      departure_date: null,
      nights: normalizeFlexibleNumeric(sliceText(first, 345, 370)),
      status: null,
      rate_amount: null,
      rate_plan: normalizeText(sliceText(first, 379, 438)),
      room_type: normalizeText(sliceText(first, 510, 560)),
      source: normalizeText(sliceText(first, 468, 510)),
      guarantee_type: normalizeText(sliceText(first, 438, 468)),
      user_name: null,
      cancel_code: normalizeText(sliceText(first, 560, 620)),
      cancel_date: parseShortDate(sliceText(first, 620, 665)),
      cancel_clock: normalizeText(sliceText(first, 665, 760)),
      reference_no: null,
      configured_rate: null,
      guest_rate: null,
      difference: null,
      value_1: null,
      value_2: null,
      value_3: null,
      value_4: null,
      value_5: null,
      value_6: null,
      value_7: null,
      value_8: null,
      value_9: null,
      value_10: null,
      value_11: null,
      value_12: null,
      value_13: null,
      value_14: null,
      value_15: null,
      value_16: null,
      note: null
    };

    for (const extra of block.slice(1)) {
      const firstItemX = extra.items[0]?.x ?? 0;
      if (firstItemX >= 650) {
        row.cancel_clock = joinNote(row.cancel_clock, extra.text).replace(/\s+\|\s+/g, "");
      } else if (firstItemX >= 240 && firstItemX < 360) {
        row.group_name = joinNote(row.group_name, extra.text).replace(/\s+\|\s+/g, " ");
      } else {
        row.note = joinNote(row.note, extra.text);
      }
    }

    rows.push(row);
    block = [];
  };

  for (const line of lines) {
    const text = line.text;
    if (!text || isAllNightAuditHeaderOrFooter(text) || text === "Company Group") {
      continue;
    }

    if (/^Total Cancellations:/i.test(text)) {
      flushBlock();
      rows.push(buildAllNightAuditMetricRow("Cancellation List", null, "Total Cancellations", normalizeFlexibleNumeric(text.replace(/^Total Cancellations:\s*/i, ""))));
      continue;
    }

    if (/^\d{10}\b/.test(text)) {
      flushBlock();
      block = [line];
      continue;
    }

    if (block.length > 0) {
      block.push(line);
    }
  }

  flushBlock();
  return rows;
}

function parseAllNightAuditHotelStatistics(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = null;

  for (const line of lines) {
    const text = line.text;
    if (!text || isAllNightAuditHeaderOrFooter(text) || /^Data Complete as of:/i.test(text)) {
      continue;
    }

    const sectionMatch = text.match(/^(Room Statistics|Performance Statistics|Revenue|Guest Statistics|Today's Activity)\b/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const metric = extractMetricLine(text, 5);
    if (!section || !metric || !metric.label || metric.values.length < 5) {
      continue;
    }

    rows.push({
      report_name: "Hotel Statistics",
      section,
      row_kind: "metric",
      date_value: null,
      metric_name: metric.label,
      account_no: null,
      guest_name: null,
      group_name: null,
      room_no: null,
      arrival_date: null,
      departure_date: null,
      nights: null,
      status: null,
      rate_amount: null,
      rate_plan: null,
      room_type: null,
      source: null,
      guarantee_type: null,
      user_name: null,
      cancel_code: null,
      cancel_date: null,
      cancel_clock: null,
      reference_no: null,
      configured_rate: null,
      guest_rate: null,
      difference: null,
      value_1: metric.values[0] ?? null,
      value_2: metric.values[1] ?? null,
      value_3: metric.values[2] ?? null,
      value_4: metric.values[3] ?? null,
      value_5: metric.values[4] ?? null,
      value_6: null,
      value_7: null,
      value_8: null,
      value_9: null,
      value_10: null,
      value_11: null,
      value_12: null,
      value_13: null,
      value_14: null,
      value_15: null,
      value_16: null,
      note: "value_1=current; value_2=ptd; value_3=last_year_ptd; value_4=current_ytd; value_5=last_ytd"
    });
  }

  return rows;
}

function parseAllNightAuditNoShow(lines: PdfLine[]): Array<Record<string, string | null>> {
  const totalLine = lines.find((line) => /^Total No Shows:/i.test(line.text));
  if (!totalLine) {
    return [];
  }

  return [buildAllNightAuditMetricRow("No Show Report", null, "Total No Shows", normalizeFlexibleNumeric(totalLine.text.replace(/^Total No Shows:\s*/i, "")))];
}

function parseAllNightAuditRateDiscrepancy(pages: PdfLine[][]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let block: PdfLine[] = [];

  const flushBlock = () => {
    if (block.length === 0) {
      return;
    }
    const first = block[0];
    const detail = block.find((line, index) => index > 0 && /^\d{10}\b/.test(line.text)) ?? null;
    const totals = block[0].text.startsWith("Total:");
    if (totals) {
      const metric = extractMetricLine(block[0].text.replace(/^Total:/, "Total"), 3);
      if (metric) {
        rows.push(buildAllNightAuditMetricRow("Rate Discrepancy Report", null, "Total", metric.values[0] ?? null, {
          value_2: metric.values[1] ?? null,
          value_3: metric.values[2] ?? null
        }));
      }
      block = [];
      return;
    }

    const descriptor = detail?.text.match(/^(\d+)\s+(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+([A-Z]+|DIRECT)\s+([0-9.,-]+)\s+([0-9.,-]+)\s+([0-9.,-]+)$/i) ?? null;
    rows.push({
      report_name: "Rate Discrepancy Report",
      section: null,
      row_kind: "reservation",
      date_value: descriptor ? parseShortDate(descriptor[3]) : null,
      metric_name: null,
      account_no: descriptor ? descriptor[1] : null,
      guest_name: descriptor ? normalizePropertyName(descriptor[2]) : null,
      group_name: null,
      room_no: normalizeText(sliceText(first, 36, 88)),
      arrival_date: null,
      departure_date: null,
      nights: null,
      status: null,
      rate_amount: null,
      rate_plan: block[2]?.text?.trim() ?? null,
      room_type: block[3] ? normalizeText(block[3].text.split(/\s+/)[0]) : null,
      source: descriptor ? descriptor[5] : null,
      guarantee_type: null,
      user_name: null,
      cancel_code: null,
      cancel_date: null,
      cancel_clock: null,
      reference_no: null,
      configured_rate: descriptor ? normalizeFlexibleNumeric(descriptor[6]) : null,
      guest_rate: descriptor ? normalizeFlexibleNumeric(descriptor[7]) : null,
      difference: descriptor ? normalizeFlexibleNumeric(descriptor[8]) : null,
      value_1: null,
      value_2: null,
      value_3: null,
      value_4: null,
      value_5: null,
      value_6: null,
      value_7: null,
      value_8: null,
      value_9: null,
      value_10: null,
      value_11: null,
      value_12: null,
      value_13: null,
      value_14: null,
      value_15: null,
      value_16: null,
      note: block.map((line) => line.text).join(" | ")
    });
    block = [];
  };

  for (const page of pages) {
    for (const line of page) {
      const text = line.text;
      if (!text || isAllNightAuditHeaderOrFooter(text)) {
        continue;
      }
      if (text.startsWith("Total:")) {
        flushBlock();
        block = [line];
        flushBlock();
        continue;
      }
      if (/^\d{3}\b/.test(text)) {
        flushBlock();
        block = [line];
        continue;
      }
      if (block.length > 0) {
        block.push(line);
      }
    }
  }

  flushBlock();
  return rows;
}

function parseAllNightAuditReservationActivity(pages: PdfLine[][]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let block: PdfLine[] = [];

  const flushBlock = () => {
    if (block.length === 0) {
      return;
    }

    const first = block[0];
    const match = first.text.match(/^(\d+)\s+(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d+)\s+([A-Z])\s+([0-9.]+)\s+(\S+)\s+(\S+)\s+(\d{3})\s+(\S+)\s+(\d+)\s+(\S+)\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+(\S+)$/);
    if (match) {
      rows.push({
        report_name: "Reservation Activity Report",
        section: null,
        row_kind: "reservation",
        date_value: parseShortDate(match[14]),
        metric_name: null,
        account_no: match[1],
        guest_name: normalizePropertyName(match[2]),
        group_name: null,
        room_no: match[10],
        arrival_date: parseShortDate(match[3]),
        departure_date: parseShortDate(match[4]),
        nights: normalizeFlexibleNumeric(match[5]),
        status: match[6],
        rate_amount: normalizeFlexibleNumeric(match[7]),
        rate_plan: match[8],
        room_type: match[9],
        source: match[11],
        guarantee_type: match[13],
        user_name: match[15],
        cancel_code: null,
        cancel_date: null,
        cancel_clock: null,
        reference_no: match[12],
        configured_rate: null,
        guest_rate: null,
        difference: null,
        value_1: null,
        value_2: null,
        value_3: null,
        value_4: null,
        value_5: null,
        value_6: null,
        value_7: null,
        value_8: null,
        value_9: null,
        value_10: null,
        value_11: null,
        value_12: null,
        value_13: null,
        value_14: null,
        value_15: null,
        value_16: null,
        note: block.slice(1).map((line) => line.text).join(" | ") || null
      });
    }

    block = [];
  };

  for (const page of pages) {
    for (const line of page) {
      const text = line.text;
      if (!text || isAllNightAuditHeaderOrFooter(text)) {
        continue;
      }
      if (/^Total Reservations:/i.test(text)) {
        flushBlock();
        rows.push(buildAllNightAuditMetricRow("Reservation Activity Report", null, "Total Reservations", normalizeFlexibleNumeric(text.replace(/^Total Reservations:\s*/i, ""))));
        continue;
      }
      if (/^Total Room Nights:/i.test(text)) {
        flushBlock();
        rows.push(buildAllNightAuditMetricRow("Reservation Activity Report", null, "Total Room Nights", normalizeFlexibleNumeric(text.replace(/^Total Room Nights:\s*/i, ""))));
        continue;
      }
      if (/^\d{10}\b/.test(text)) {
        flushBlock();
        block = [line];
        continue;
      }
      if (block.length > 0) {
        block.push(line);
      }
    }
  }

  flushBlock();
  return rows;
}

function buildAllNightAuditMetricRow(
  reportName: string,
  section: string | null,
  metricName: string,
  value1: string | null,
  extra?: Partial<Record<`value_${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16}`, string | null>>
): Record<string, string | null> {
  return {
    report_name: reportName,
    section,
    row_kind: "metric",
    date_value: null,
    metric_name: metricName,
    account_no: null,
    guest_name: null,
    group_name: null,
    room_no: null,
    arrival_date: null,
    departure_date: null,
    nights: null,
    status: null,
    rate_amount: null,
    rate_plan: null,
    room_type: null,
    source: null,
    guarantee_type: null,
    user_name: null,
    cancel_code: null,
    cancel_date: null,
    cancel_clock: null,
    reference_no: null,
    configured_rate: null,
    guest_rate: null,
    difference: null,
    value_1: value1,
    value_2: extra?.value_2 ?? null,
    value_3: extra?.value_3 ?? null,
    value_4: extra?.value_4 ?? null,
    value_5: extra?.value_5 ?? null,
    value_6: extra?.value_6 ?? null,
    value_7: extra?.value_7 ?? null,
    value_8: extra?.value_8 ?? null,
    value_9: extra?.value_9 ?? null,
    value_10: extra?.value_10 ?? null,
    value_11: extra?.value_11 ?? null,
    value_12: extra?.value_12 ?? null,
    value_13: extra?.value_13 ?? null,
    value_14: extra?.value_14 ?? null,
    value_15: extra?.value_15 ?? null,
    value_16: extra?.value_16 ?? null,
    note: null
  };
}

function groupLinesByPage(lines: PdfLine[]): PdfLine[][] {
  const pages = new Map<number, PdfLine[]>();
  for (const line of lines) {
    const page = pages.get(line.pageNumber) ?? [];
    page.push(line);
    pages.set(line.pageNumber, page);
  }

  return Array.from(pages.entries())
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1]);
}

function hasPageTitle(lines: PdfLine[], title: string): boolean {
  return lines.some((line) => line.text.trim() === title);
}

function extractChoiceAuditPacketPageTitle(lines: PdfLine[]): string | null {
  for (const line of lines) {
    const text = line.text.trim();
    if (
      CHOICE_AUDIT_PACKET_PAGE_TITLES.includes(text as (typeof CHOICE_AUDIT_PACKET_PAGE_TITLES)[number])
      || text === "Hotel Journal Summary"
      || text === "Revenue by Rate Code"
    ) {
      return text;
    }
  }

  return null;
}

function isChoiceAuditPacketHeaderOrFooter(text: string, reportName: string): boolean {
  return isChoiceAuditPacketCommonHeaderOrFooter(text, reportName)
    || text.startsWith("Account Name Current")
    || text.startsWith("Status Name Account Arrival Balance")
    || text.startsWith("Account Guest Name Arrival Nights")
    || text.startsWith("March April May")
    || text.startsWith("Day Tax Adults")
    || text.startsWith("Date Account Room Status")
    || text.startsWith("Today's Totals")
    || text.startsWith("Description (Transaction Code)")
    || text.startsWith("Status Name Account Room Arrival Departure Balance")
    || text.startsWith("Date Posting Date User ID")
    || text === "ID Account Comment"
    || text.startsWith("Room Statistics ")
    || text.startsWith("Room Room Daily PTD Room PTD Room Room YTD Room YTD")
    || text.startsWith("Rate Code Nights % Revenue % AVG")
    || text === "Exempt Exempt Refund"
    || text.startsWith("Date Account Room Name Company Guest Tax ID Arrival Departure Transaction Code Revenue Revenue")
    || text === "Tax T1 T2 T3"
    || text.startsWith("Current Tax Configuration")
    || text === "*Calculations include Comp rooms";
}

function isChoiceAuditPacketSectionLine(text: string): boolean {
  return text === "Guest Accounts"
    || text === "Group Master Accounts"
    || text === "In House Accounts"
    || text === "Guest Ledger Summary"
    || text === "No Show Revenue"
    || text === "Tax Exempt Revenue Summary - By Tax:"
    || /^Transaction Type:/i.test(text)
    || /^Transaction Code:/i.test(text);
}

function isChoiceAuditPacketTotalLine(text: string): boolean {
  return /^Grand Total:/i.test(text)
    || /^Subtotal:/i.test(text)
    || /^Totals:/i.test(text)
    || /^Totals\b/i.test(text)
    || /^Total Advance Deposits:/i.test(text)
    || /^Total Comps:/i.test(text)
    || /^Total Cancellations:/i.test(text)
    || /^Total For /i.test(text)
    || /^No Show Total:/i.test(text)
    || /^Total:/i.test(text)
    || /^Closing Balance:/i.test(text);
}

function splitAuditCell(value: string): [string | null, string | null] {
  const parts = value.split("/").map((part) => normalizeFlexibleNumeric(part)).filter((part) => part !== null);
  return [parts[0] ?? null, parts[1] ?? null];
}

function isAllNightAuditHeaderOrFooter(text: string): boolean {
  return text === "Business on The Books"
    || text === "Cancellation List"
    || text === "Hotel Statistics"
    || text === "Maintenance Report"
    || text === "No Show Report"
    || text === "Rate Discrepancy Report"
    || text === "Reservation Activity Report"
    || /^Property Name:/i.test(text)
    || /^Business Date:/i.test(text)
    || /^Date Range:/i.test(text)
    || /^Date\/Time of Printing:/i.test(text)
    || /^Data Complete as of:/i.test(text)
    || /^Property Code:/i.test(text)
    || /^Shift:/i.test(text)
    || /^User:/i.test(text)
    || text === "*Calculations include Comp rooms"
    || text.startsWith("Transient Transient")
    || text.startsWith("Rooms PPL Rooms")
    || text === "Rooms"
    || text.startsWith("Account Guest Name Arrival Nights")
    || text.startsWith("Room Statistics ")
    || text.startsWith("Performance Statistics ")
    || text.startsWith("Revenue ")
    || text.startsWith("Guest Statistics ")
    || text.startsWith("Today's Activity ")
    || text.startsWith("Room Rm Type Room Details")
    || text === "Nights"
    || text.startsWith("Account Guest Name Arrival Departure Source")
    || text.startsWith("Room Account Guest Name Adult / Override Start")
    || text.startsWith("Room Type Group Child Override End")
    || text.startsWith("CRS Conf. Reserve")
    || text.startsWith("Account Guest Name Arrive Depart Nights Status")
    || text === "No Date"
    || text === "Company Group";
}

function parseHistoryAndForecast(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: "History" | "Forecast" | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (text === "History" || text === "Forecast") {
      section = text;
      continue;
    }
    if (!section || !/^\d{2}-\d{2}-\d{2}\s+[A-Za-z]{3}\b/.test(text)) {
      continue;
    }

    const headerMatch = text.match(/^(\d{2}-\d{2}-\d{2})\s+([A-Za-z]{3})/);
    if (!headerMatch) {
      continue;
    }

    rows.push({
      business_date: parseShortDate(headerMatch[1]),
      section,
      day_of_week: headerMatch[2],
      total_occ: normalizeNumeric(sliceText(line, 70, 100)),
      arrivals: normalizeNumeric(sliceText(line, 100, 135)),
      comp_rooms: normalizeNumeric(sliceText(line, 135, 170)),
      house_use_rooms: normalizeNumeric(sliceText(line, 170, 200)),
      deduct_indiv_rooms: normalizeNumeric(sliceText(line, 200, 240)),
      non_deduct_indiv_rooms: normalizeNumeric(sliceText(line, 240, 275)),
      deduct_group_rooms: normalizeNumeric(sliceText(line, 275, 310)),
      non_deduct_group_rooms: normalizeNumeric(sliceText(line, 310, 340)),
      occupancy_pct: normalizePercent(sliceText(line, 340, 410)),
      room_revenue: normalizeNumeric(sliceText(line, 410, 495)),
      average_rate: normalizeNumeric(sliceText(line, 495, 540)),
      departures: normalizeNumeric(sliceText(line, 540, 585)),
      day_use_rooms: normalizeNumeric(sliceText(line, 585, 620)),
      no_show_rooms: normalizeNumeric(sliceText(line, 620, 645)),
      ooo_rooms: normalizeNumeric(sliceText(line, 645, 676)),
      in_house_people: normalizeNumeric(sliceText(line, 676, 760))
    });
  }

  return rows;
}

function parseManagerFlash(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text)) {
      continue;
    }
    if (text === "DAY MONTH YEAR") {
      continue;
    }
    if (/^\d{4}\s+\d{4}\s+\d{4}$/.test(text)) {
      continue;
    }

    const tripleMatch = text.match(/^(.*\S)\s+(-?(?:\d[\d,]*\.?\d*))\s+(-?(?:\d[\d,]*\.?\d*))\s+(-?(?:\d[\d,]*\.?\d*))$/);
    if (tripleMatch) {
      const metricName = tripleMatch[1].trim();
      const values = [tripleMatch[2], tripleMatch[3], tripleMatch[4]];
      const periods = ["day", "month", "year"] as const;
      for (let index = 0; index < values.length; index += 1) {
        rows.push({
          metric_name: metricName,
          period: periods[index],
          metric_value: normalizeNumeric(values[index])
        });
      }
      continue;
    }

    const singleMatch = text.match(/^(.*\S)\s+(-?(?:\d[\d,]*\.?\d*))$/);
    if (singleMatch) {
      rows.push({
        metric_name: singleMatch[1].trim(),
        period: "day",
        metric_value: normalizeNumeric(singleMatch[2])
      });
    }
  }

  return rows;
}

function parseReservationsMadeYesterday(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let lastRow: Record<string, string | null> | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text.startsWith("Name Arrival Departure")) {
      continue;
    }

    const arrival = sliceText(line, 188, 229.5);
    const departure = sliceText(line, 229.5, 278);
    const guestName = sliceText(line, 0, 188);

    if (parseShortDate(arrival) && parseShortDate(departure) && guestName) {
      lastRow = {
        guest_name: guestName,
        arrival_date: parseShortDate(arrival),
        departure_date: parseShortDate(departure),
        persons: normalizeNumeric(sliceText(line, 278, 300)),
        rooms: normalizeNumeric(sliceText(line, 300, 335)),
        nights: normalizeNumeric(sliceText(line, 335, 372)),
        rate_amount: normalizeNumeric(sliceText(line, 372, 412)),
        rate_code: sliceText(line, 412, 449.5) || null,
        market_code: sliceText(line, 449.5, 472.5) || null,
        booking_user: sliceText(line, 472.5, 517.5) || null,
        made_on_date: parseShortDate(sliceText(line, 517.5, 609)),
        company_group_note: sliceText(line, 609, 760) || null
      };
      rows.push(lastRow);
      continue;
    }

    if (lastRow && !isFooterNoise(text)) {
      lastRow.company_group_note = joinNote(lastRow.company_group_note, text);
    }
  }

  return rows;
}

function parseZeroRateRooms(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let lastRow: Record<string, string | null> | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text.startsWith("Room Name") || text === "Group") {
      continue;
    }

    const roomAccountNo = sliceText(line, 0, 47);
    const arrival = sliceText(line, 344, 389.68);
    const departure = sliceText(line, 389.68, 475);

    if (/^\d{4,}$/.test(roomAccountNo) && parseShortDate(arrival) && parseShortDate(departure)) {
      const noteParts = [
        sliceText(line, 552.64, 692.12)
      ].filter(Boolean);

      lastRow = {
        room_account_no: roomAccountNo,
        guest_or_group_name: sliceText(line, 47, 217) || null,
        persons: normalizeNumeric(sliceText(line, 217, 233)),
        rate_code: sliceText(line, 233, 267) || null,
        block_code: sliceText(line, 267, 300.4) || null,
        market_code: sliceText(line, 300.4, 344.88) || null,
        arrival_date: parseShortDate(arrival),
        departure_date: parseShortDate(departure),
        balance_amount: normalizeNumeric(sliceText(line, 475, 514.25)),
        room_type: sliceText(line, 514.25, 552.64) || null,
        payment_method: sliceText(line, 692.12, 720.2) || null,
        tax_code: sliceText(line, 720.2, 760) || null,
        note: noteParts.length > 0 ? noteParts.join(" ") : null
      };
      rows.push(lastRow);
      continue;
    }

    if (lastRow && (/^Comments\b/.test(text) || /^Routed from\b/.test(text) || !isFooterNoise(text))) {
      lastRow.note = joinNote(lastRow.note, text);
    }
  }

  return rows;
}

function parseArDetailedAging(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let currentAccountName: string | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text.startsWith("Guest Name Invoice No.")) {
      continue;
    }
    if (text === "A/R Ledger") {
      continue;
    }

    const postDate = sliceText(line, 222.79, 311.659);
    const accountHeaderName = sliceText(line, 0, 116.2);
    const accountHeaderNo = sliceText(line, 116.2, 222.79);

    if (!parseShortDate(postDate) && accountHeaderName && accountHeaderNo) {
      currentAccountName = `${accountHeaderName} ${accountHeaderNo}`.trim();
      continue;
    }

    if (!parseShortDate(postDate)) {
      continue;
    }

    rows.push({
      account_name: currentAccountName,
      guest_name: sliceText(line, 0, 116.2) || null,
      invoice_no: sliceText(line, 116.2, 168.88) || null,
      folio_no: sliceText(line, 168.88, 222.79) || null,
      post_date: parseShortDate(postDate),
      up_to_30: normalizeNumeric(sliceText(line, 311.659, 385.08)),
      days_31_60: normalizeNumeric(sliceText(line, 385.08, 454.36)),
      days_61_90: normalizeNumeric(sliceText(line, 454.36, 518.87)),
      days_91_120: normalizeNumeric(sliceText(line, 518.87, 583.97)),
      days_121_150: normalizeNumeric(sliceText(line, 583.97, 640.37)),
      days_151_plus: normalizeNumeric(sliceText(line, 640.37, 720.35)),
      total_amount: normalizeNumeric(sliceText(line, 720.35, 760))
    });
  }

  return rows;
}

function parseRateChangeReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text.startsWith("Conf. No. Room Name")) {
      continue;
    }

    const confirmationNo = sliceText(line, 0, 76.72);
    const changedAt = sliceText(line, 682.4, 760);

    if (!/^\d+$/.test(confirmationNo) || !/\d{2}-\d{2}-\d{2}/.test(changedAt)) {
      continue;
    }

    const rawAccount = sliceText(line, 225.35, 321.52);
    const prefixed = rawAccount.match(/^([A-Z])-+\s*(.*)$/);

    rows.push({
      confirmation_no: confirmationNo,
      room_no: sliceText(line, 76.72, 110.64) || null,
      guest_name: sliceText(line, 110.64, 225.35) || null,
      account_kind: prefixed ? prefixed[1] : rawAccount || null,
      company_or_agent: prefixed ? prefixed[2] || null : rawAccount || null,
      old_rate_code: sliceText(line, 321.52, 376) || null,
      new_rate_code: sliceText(line, 376, 451.23) || null,
      old_rate_amount: normalizeNumeric(sliceText(line, 451.23, 502.14)),
      new_rate_amount: normalizeNumeric(sliceText(line, 502.14, 540.51)),
      block_code: sliceText(line, 540.51, 614.16) || null,
      changed_by: sliceText(line, 614.16, 682.4) || null,
      changed_at: normalizeDateTime(changedAt)
    });
  }

  return rows;
}

function parseBestWesternDailyReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const pages = new Map<number, PdfLine[]>();
  for (const line of document.lines) {
    const bucket = pages.get(line.pageNumber) ?? [];
    bucket.push(line);
    pages.set(line.pageNumber, bucket);
  }

  const rows: Array<Record<string, string | null>> = [];
  const firstPage = pages.get(1) ?? [];
  rows.push(...parseBestWesternStatisticalRecap(firstPage));
  rows.push(...parseBestWesternDepositTotals(firstPage));
  rows.push(...parseBestWesternLedgerSummary(firstPage));

  for (const [pageNumber, lines] of pages.entries()) {
    if (pageNumber >= 2 && pageNumber <= 6) {
      rows.push(...parseBestWesternDetailListing(lines));
    }
    if (pageNumber === 7) {
      rows.push(...parseBestWesternDetailSummary(lines));
    }
  }

  return rows;
}

function extractBestWesternBusinessDate(document: PdfDocumentText): string | null {
  for (const line of document.lines.filter((entry) => entry.pageNumber === 1).slice(0, 12)) {
    const text = line.text.trim();
    const namedShortDate = text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/i);
    if (namedShortDate) {
      return parseShortDate(namedShortDate[1]);
    }
    if (
      /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)
      && !/\d{1,2}:\d{2}/.test(text)
    ) {
      return parseShortDate(text);
    }
  }
  return null;
}

function parseBestWesternStatisticalRecap(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let inSection = false;

  for (const line of lines) {
    const text = line.text;
    if (text === "Statistical Recap") {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (text.startsWith("Deposit Totals")) {
      break;
    }
    if (!text || text === "Daily Report" || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text) || text.startsWith("Category Today MTD")) {
      continue;
    }

    const metricName = normalizeText(sliceText(line, 20, 170));
    const todayValue = normalizeFlexibleNumeric(sliceText(line, 180, 225));
    const ytdVariance = normalizeFlexibleNumeric(sliceText(line, 726, 772));
    if (!metricName || !todayValue || !ytdVariance) {
      continue;
    }

    rows.push({
      section: "Statistical Recap",
      subsection: null,
      group_name: null,
      row_kind: "metric",
      metric_name: metricName,
      posting_code: null,
      posting_description: null,
      transaction_count: null,
      today_value: todayValue,
      mtd_value: normalizeFlexibleNumeric(sliceText(line, 270, 320)),
      last_year_mtd_value: normalizeFlexibleNumeric(sliceText(line, 378, 426)),
      mtd_variance: normalizeFlexibleNumeric(sliceText(line, 444, 480)),
      ytd_value: normalizeFlexibleNumeric(sliceText(line, 540, 588)),
      last_year_ytd_value: normalizeFlexibleNumeric(sliceText(line, 652, 694)),
      ytd_variance: ytdVariance,
      opening_balance: null,
      debits: null,
      credits: null,
      closing_balance: null
    });
  }

  return rows;
}

function parseBestWesternDepositTotals(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let inSection = false;
  let subsection: string | null = null;

  for (const line of lines) {
    const text = line.text;
    if (text.startsWith("Deposit Totals")) {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (text.startsWith("Ledger Summary")) {
      break;
    }
    if (!text || text === "Daily Report" || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
      continue;
    }

    if (/^[A-Z][A-Z\s/&]+$/.test(text) && !/\$/.test(text)) {
      subsection = text;
      continue;
    }

    const metric = extractBestWesternMetricLine(text, 3);
    if (!metric || !metric.label) {
      continue;
    }

    rows.push({
      section: "Deposit Totals",
      subsection,
      group_name: null,
      row_kind: /^(?:TOTAL|DEPOSIT TOTAL)$/i.test(metric.label) ? "total" : "detail",
      metric_name: metric.label,
      posting_code: null,
      posting_description: null,
      transaction_count: null,
      today_value: metric.values[0] ?? null,
      mtd_value: metric.values[1] ?? null,
      last_year_mtd_value: null,
      mtd_variance: null,
      ytd_value: metric.values[2] ?? null,
      last_year_ytd_value: null,
      ytd_variance: null,
      opening_balance: null,
      debits: null,
      credits: null,
      closing_balance: null
    });
  }

  return rows;
}

function parseBestWesternLedgerSummary(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let inSection = false;

  for (const line of lines) {
    const text = line.text;
    if (text.startsWith("Ledger Summary")) {
      inSection = true;
      continue;
    }
    if (!inSection) {
      continue;
    }
    if (!text || text === "Daily Report" || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
      continue;
    }

    const metric = extractBestWesternMetricLine(text, 4);
    if (!metric) {
      continue;
    }

    rows.push({
      section: "Ledger Summary",
      subsection: null,
      group_name: null,
      row_kind: "balance",
      metric_name: metric.label || "Totals",
      posting_code: null,
      posting_description: null,
      transaction_count: null,
      today_value: null,
      mtd_value: null,
      last_year_mtd_value: null,
      mtd_variance: null,
      ytd_value: null,
      last_year_ytd_value: null,
      ytd_variance: null,
      opening_balance: metric.values[0] ?? null,
      debits: metric.values[1] ?? null,
      credits: metric.values[2] ?? null,
      closing_balance: metric.values[3] ?? null
    });
  }

  return rows;
}

function parseBestWesternDetailListing(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let subsection: string | null = null;
  let currentGroup: string | null = null;
  let lastRow: Record<string, string | null> | null = null;

  for (const line of lines) {
    const text = line.text;
    if (!text || text === "Daily Report" || text === "Detail Listing" || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
      continue;
    }
    if (text === "Guest Ledger" || text === "City Ledger") {
      subsection = text;
      currentGroup = null;
      lastRow = null;
      continue;
    }
    if (text.startsWith("Category Posting # Trans") || text === "or Budget or Budget") {
      continue;
    }

    if (/^\d+$/.test(text) && line.items.length === 1 && line.items[0].x > 740 && lastRow?.ytd_variance) {
      lastRow.ytd_variance = `${lastRow.ytd_variance}${text}`;
      continue;
    }

    if (line.items.length === 1 && line.items[0].x >= 150 && line.items[0].x < 260 && lastRow?.posting_description) {
      lastRow.posting_description = joinNote(lastRow.posting_description, text).replace(/\s+\|\s+/g, " ");
      continue;
    }

    const rowKind = determineBestWesternDetailRowKind(line);
    if (!rowKind) {
      continue;
    }

    const explicitGroup = normalizeText(sliceText(line, 20, 112));
    const postingCode = normalizeText(sliceText(line, 118, 154));
    const postingDescription = normalizeText(sliceText(line, 156, 252));
    const row = {
      section: "Detail Listing",
      subsection,
      group_name: rowKind === "detail" ? (explicitGroup || currentGroup) : currentGroup,
      row_kind: rowKind,
      metric_name: rowKind === "total" ? "Totals" : null,
      posting_code: rowKind === "detail" ? postingCode : null,
      posting_description: rowKind === "detail" ? postingDescription : null,
      transaction_count: normalizeFlexibleNumeric(sliceText(line, 288, 306)),
      today_value: normalizeFlexibleNumeric(sliceText(line, 320, 362)),
      mtd_value: normalizeFlexibleNumeric(sliceText(line, 404, 456)),
      last_year_mtd_value: normalizeFlexibleNumeric(sliceText(line, 486, 530)),
      mtd_variance: normalizeFlexibleNumeric(sliceText(line, 536, 566)),
      ytd_value: normalizeFlexibleNumeric(sliceText(line, 620, 666)),
      last_year_ytd_value: normalizeFlexibleNumeric(sliceText(line, 692, 740)),
      ytd_variance: normalizeFlexibleNumeric(sliceText(line, 742, 774)),
      opening_balance: null,
      debits: null,
      credits: null,
      closing_balance: null
    };

    if (rowKind === "detail" && explicitGroup) {
      currentGroup = explicitGroup;
    }
    rows.push(row);
    lastRow = row;
  }

  return rows;
}

function parseBestWesternDetailSummary(lines: PdfLine[]): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let subsection: string | null = null;

  for (const line of lines) {
    const text = line.text;
    if (!text || text === "Daily Report" || text === "Detail Listing Summary" || /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(text)) {
      continue;
    }
    if (text === "GUEST LEDGER" || text === "CITY LEDGER") {
      subsection = text;
      continue;
    }
    if (text.startsWith("Category # Trans") || text === "Budget Budget") {
      continue;
    }

    const metricName = normalizeText(sliceText(line, 20, 180));
    const ytdVariance = normalizeFlexibleNumeric(sliceText(line, 748, 774));
    if (!metricName || !ytdVariance) {
      continue;
    }

    rows.push({
      section: "Detail Listing Summary",
      subsection,
      group_name: null,
      row_kind: metricName === "TOTAL" ? "total" : "summary",
      metric_name: metricName,
      posting_code: null,
      posting_description: null,
      transaction_count: normalizeFlexibleNumeric(sliceText(line, 202, 222)),
      today_value: normalizeFlexibleNumeric(sliceText(line, 248, 294)),
      mtd_value: normalizeFlexibleNumeric(sliceText(line, 346, 394)),
      last_year_mtd_value: normalizeFlexibleNumeric(sliceText(line, 440, 486)),
      mtd_variance: normalizeFlexibleNumeric(sliceText(line, 508, 538)),
      ytd_value: normalizeFlexibleNumeric(sliceText(line, 592, 636)),
      last_year_ytd_value: normalizeFlexibleNumeric(sliceText(line, 670, 716)),
      ytd_variance: ytdVariance,
      opening_balance: null,
      debits: null,
      credits: null,
      closing_balance: null
    });
  }

  return rows;
}

function parseRoomTaxListing(
  document: PdfDocumentText,
  referenceDate: string | null
): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];

  for (const line of document.lines) {
    const text = line.text;
    if (
      !text
      || shouldSkipCommonLine(text)
      || text === "Room & Tax Listing"
      || text === "Revenue Tax Detail Report"
      || text.startsWith("Room Guest Name Conf # Type Arrive Depart Rate Override Tax")
      || text.startsWith("Code RM Trans ID Conf # Guest Name Revenue")
      || text.startsWith("SUMMARY TOTALS")
      || text.startsWith("Exempt Revenue")
      || text.startsWith("Taxable Revenue")
    ) {
      continue;
    }

    const roomNumber = normalizeText(sliceText(line, 16, 48));
    const chargeType = normalizeText(sliceText(line, 190, 244));
    if (!roomNumber || !/^\d{2,4}-[A-Z]$/.test(roomNumber) || chargeType !== "Room And Tax") {
      continue;
    }

    rows.push({
      room_number: roomNumber,
      guest_name: normalizeText(sliceText(line, 50, 146)),
      confirmation_no: normalizeText(sliceText(line, 146, 194)),
      charge_type: chargeType,
      arrival_date: parseMonthDayWithReferenceYear(sliceText(line, 244, 278), referenceDate),
      departure_date: parseMonthDayWithReferenceYear(sliceText(line, 278, 312), referenceDate),
      rate_amount: normalizeAmount(sliceText(line, 364, 406)),
      override_flag: normalizeText(sliceText(line, 424, 450)),
      tax_amount: normalizeAmount(sliceText(line, 488, 530)),
      package_name: normalizeText(sliceText(line, 530, 574)),
      extra_1: normalizeText(sliceText(line, 574, 620)),
      extra_2: normalizeText(sliceText(line, 620, 666)),
      transfer_flag: normalizeText(sliceText(line, 666, 706)),
      payment_method: normalizeText(sliceText(line, 706, 760))
    });
  }

  return rows;
}

function parseDailyTransactionLog(
  document: PdfDocumentText,
  referenceDate: string | null
): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let prefixLine: PdfLine | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (
      !text
      || shouldSkipCommonLine(text)
      || /^Daily Transaction Log Page \d+ of \d+$/.test(text)
      || text === "Referenc"
      || text === "e"
      || text.startsWith("Code RM Trans ID Conf # Guest Name Posted")
    ) {
      prefixLine = null;
      continue;
    }

    if (/^Total\b/.test(text)) {
      prefixLine = null;
      continue;
    }

    if (isDailyTransactionLogDetailLine(line)) {
      rows.push({
        transaction_code: normalizeText(sliceText(line, 18, 40)),
        transaction_description: joinTextParts([
          sliceOptionalText(prefixLine, 46, 132),
          sliceText(line, 46, 132)
        ]),
        room_number: normalizeText(sliceText(line, 132, 166)),
        transaction_id: normalizeText(sliceText(line, 166, 208)),
        confirmation_no: joinCompactText([
          sliceOptionalText(prefixLine, 216, 262),
          sliceText(line, 216, 262)
        ]),
        guest_name: joinTextParts([
          sliceOptionalText(prefixLine, 266, 360),
          sliceText(line, 266, 360)
        ]),
        reference_value: joinTextParts([
          sliceOptionalText(prefixLine, 360, 466),
          sliceText(line, 360, 466)
        ]),
        posted_amount: normalizeFlexibleNumeric(sliceText(line, 464, 500)),
        adjusted_amount: normalizeFlexibleNumeric(sliceText(line, 498, 545)),
        original_id: normalizeText(sliceText(line, 548, 586)),
        original_date: parseMonthDayWithReferenceYear(sliceText(line, 588, 620), referenceDate) ?? normalizeText(sliceText(line, 588, 620)),
        void_from_value: normalizeText(sliceText(line, 626, 686)),
        clerk_name: normalizeText(sliceText(line, 690, 728)),
        transaction_time: normalizeText(sliceText(line, 730, 770))
      });
      prefixLine = null;
      continue;
    }

    prefixLine = line;
  }

  return rows;
}

function parseCreditCardTransactions(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let prefixLine: PdfLine | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (
      !text
      || shouldSkipCommonLine(text)
      || text === "Credit Card Transactions"
      || text.startsWith("* = Not Swiped")
      || text.startsWith("Type CC # Status Code RM Conf # Guest Name")
      || text.startsWith("Batch ID Sales Sales Total Credits Credits Total")
    ) {
      prefixLine = null;
      continue;
    }

    if (/^Total\b/.test(text) || /^Totals\b/.test(text)) {
      prefixLine = null;
      continue;
    }

    if (isCreditCardDetailLine(line)) {
      rows.push({
        card_type: normalizeText(sliceText(line, 14, 34)),
        card_number_fragment: normalizeText(sliceText(line, 42, 78)),
        transaction_status: normalizeText(sliceText(line, 78, 128)),
        payment_code: normalizeText(sliceText(line, 132, 166)),
        room_number: normalizeText(sliceText(line, 166, 208)),
        confirmation_no: joinCompactText([
          sliceOptionalText(prefixLine, 210, 248),
          sliceText(line, 210, 248)
        ]),
        guest_name: joinTextParts([
          sliceOptionalText(prefixLine, 250, 328),
          sliceText(line, 250, 328)
        ]),
        authorization_no: normalizeText(sliceText(line, 328, 362)),
        batch_id: normalizeText(sliceText(line, 364, 402)),
        charge_amount: normalizeFlexibleNumeric(sliceText(line, 456, 498)),
        credit_amount: normalizeFlexibleNumeric(sliceText(line, 522, 552)),
        transaction_id: normalizeText(sliceText(line, 556, 594)),
        void_from_value: normalizeFlexibleNumeric(sliceText(line, 604, 640)) ?? normalizeText(sliceText(line, 604, 640)),
        clerk_name: normalizeText(sliceText(line, 674, 704)),
        transaction_time: normalizeText(sliceText(line, 710, 754))
      });
      prefixLine = null;
      continue;
    }

    prefixLine = line;
  }

  return rows;
}

function parseOperatorTransactions(
  document: PdfDocumentText,
  referenceDate: string | null
): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let prefixLine: PdfLine | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (
      !text
      || shouldSkipCommonLine(text)
      || /^Operator Transactions Page \d+ of \d+$/.test(text)
      || text === "Operator Totals"
      || text.startsWith("Code RM Trans ID Conf # Guest Name Reference")
      || text.startsWith("Category Code Description AMT Adj Total")
    ) {
      prefixLine = null;
      continue;
    }

    if (/^Total\b/.test(text) || /^Totals\b/.test(text)) {
      prefixLine = null;
      continue;
    }

    if (isOperatorTransactionDetailLine(line)) {
      rows.push({
        transaction_code: normalizeText(sliceText(line, 16, 34)),
        transaction_description: joinTextParts([
          sliceOptionalText(prefixLine, 36, 140),
          sliceText(line, 36, 140)
        ]),
        transaction_id: normalizeText(sliceText(line, 140, 184)),
        confirmation_no: joinCompactText([
          sliceOptionalText(prefixLine, 188, 232),
          sliceText(line, 188, 232)
        ]),
        guest_name: joinTextParts([
          sliceOptionalText(prefixLine, 232, 308),
          sliceText(line, 232, 308)
        ]),
        reference_value: joinTextParts([
          sliceOptionalText(prefixLine, 308, 412),
          sliceText(line, 308, 412)
        ]),
        amount: normalizeFlexibleNumeric(sliceText(line, 412, 452)),
        adjustment_amount: normalizeFlexibleNumeric(sliceText(line, 496, 528)),
        original_id: normalizeText(sliceText(line, 528, 586)),
        original_date: parseMonthDayWithReferenceYear(sliceText(line, 588, 628), referenceDate) ?? normalizeText(sliceText(line, 588, 628)),
        void_from_value: normalizeText(sliceText(line, 628, 666)),
        clerk_name: normalizeText(sliceText(line, 666, 714)),
        transaction_time: normalizeText(sliceText(line, 714, 760))
      });
      prefixLine = null;
      continue;
    }

    prefixLine = line;
  }

  return rows;
}

function parseAdjustmentRefundActivity(document: PdfDocumentText): Array<Record<string, string | null>> {
  const detailLines: PdfLine[] = [];
  const summaryLines: PdfLine[] = [];
  let section: "Adjustments" | "Adjustment Summary" | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || shouldSkipVisibleTitleLine(text)) {
      continue;
    }
    if (text === "Adjustments" || text === "Adjustment Summary") {
      section = text;
      continue;
    }
    if (section === "Adjustments") {
      detailLines.push(line);
      continue;
    }
    if (section === "Adjustment Summary") {
      summaryLines.push(line);
    }
  }

  const detailBlocks = collectLineBlocks(
    detailLines.filter((line) => (
      !line.text.startsWith("Date Time Transaction")
      && !line.text.startsWith("Type Name User")
      && line.text !== "Code"
      && !/^Totals\b/.test(line.text)
    )),
    (line) => isNamedDateTimeLine(line.text)
  );

  const rows = detailBlocks.map((block) => ({
    section: "Adjustments",
    row_kind: "detail",
    transaction_date: parseShortDate(firstNonEmptySlice(block, 24, 72)),
    transaction_time: normalizeText(firstNonEmptySlice(block, 84, 128)),
    transaction_scope: joinSlices(block, 140, 196),
    charge_type: joinSlices(block, 198, 248),
    subject_name: joinSlices(block, 250, 320),
    transaction_number: firstNonEmptySlice(block, 314, 356),
    room_number: firstNonEmptySlice(block, 382, 404),
    reason_code: joinSlices(block, 424, 474),
    adjusted_amount: normalizeCurrencyAmount(firstNonEmptySlice(block, 488, 526)),
    adjusted_tax: normalizeCurrencyAmount(firstNonEmptySlice(block, 544, 582)),
    transferred_charge: normalizeCurrencyAmount(firstNonEmptySlice(block, 600, 642)),
    transferred_tax: normalizeCurrencyAmount(firstNonEmptySlice(block, 660, 698)),
    username: joinSlices(block, 708, 764),
    remarks: joinSlices(block, 770, 822),
    note: joinTextParts(block.slice(1).map((line) => line.text))
  }));

  for (const line of detailLines) {
    if (!/^Totals\b/.test(line.text)) {
      continue;
    }
    rows.push({
      section: "Adjustments",
      row_kind: "total",
      transaction_date: null,
      transaction_time: null,
      transaction_scope: "Totals",
      charge_type: null,
      subject_name: null,
      transaction_number: null,
      room_number: null,
      reason_code: null,
      adjusted_amount: normalizeCurrencyAmount(sliceText(line, 488, 526)),
      adjusted_tax: normalizeCurrencyAmount(sliceText(line, 544, 582)),
      transferred_charge: normalizeCurrencyAmount(sliceText(line, 600, 642)),
      transferred_tax: normalizeCurrencyAmount(sliceText(line, 660, 698)),
      username: null,
      remarks: null,
      note: null
    });
  }

  const summaryBlocks = collectLineBlocks(
    summaryLines.filter((line) => !line.text.startsWith("Type Name User")),
    (line) => /^(Charge Type And User|Reason Code)\b/.test(line.text)
  );

  rows.push(...summaryBlocks.map((block) => {
    const firstLine = block[0];
    const scope = /^Charge Type And User/.test(firstLine.text) ? "Charge Type And User" : "Reason Code";
    return {
      section: "Adjustment Summary",
      row_kind: "summary",
      transaction_date: null,
      transaction_time: null,
      transaction_scope: scope,
      charge_type: joinSlices(block, 152, 240),
      subject_name: null,
      transaction_number: null,
      room_number: null,
      reason_code: scope === "Reason Code" ? joinSlices(block, 152, 240) : null,
      adjusted_amount: normalizeCurrencyAmount(firstNonEmptySlice(block, 398, 442)),
      adjusted_tax: normalizeCurrencyAmount(firstNonEmptySlice(block, 516, 554)),
      transferred_charge: normalizeCurrencyAmount(firstNonEmptySlice(block, 630, 668)),
      transferred_tax: normalizeCurrencyAmount(firstNonEmptySlice(block, 744, 782)),
      username: joinSlices(block, 272, 340),
      remarks: null,
      note: joinTextParts(block.slice(1).map((line) => line.text))
    };
  }));

  return rows;
}

function parseAllTransactions(document: PdfDocumentText): Array<Record<string, string | null>> {
  let section: string | null = null;
  const dataLines: PdfLine[] = [];

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || shouldSkipVisibleTitleLine(text)) {
      continue;
    }
    if (text === "Reservations") {
      section = text;
      continue;
    }
    if (
      text.startsWith("Date Time Confirmatio")
      || text.startsWith("n Number Name Number Number Code")
      || text.startsWith("Description Category Type")
      || text.startsWith("Date Time Confirmatio Guest Room Group")
      || text.startsWith("n Number Name Number Code Number")
      || text.startsWith("Code Name Description")
    ) {
      continue;
    }

    dataLines.push(line);
  }

  const blocks = collectLineBlocks(dataLines, (line) => isNamedDateTimeLine(line.text));
  return blocks.map((block) => ({
    section,
    transaction_date: parseShortDate(firstNonEmptySlice(block, 24, 72)),
    transaction_time: normalizeText(firstNonEmptySlice(block, 84, 128)),
    confirmation_no: firstNonEmptySlice(block, 130, 176),
    guest_name: joinSlices(block, 180, 248),
    room_number: firstNonEmptySlice(block, 248, 272),
    folio_number: firstNonEmptySlice(block, 296, 332),
    transaction_code: firstNonEmptySlice(block, 348, 380),
    transaction_description: normalizeText(sliceText(block[0], 398, 462)),
    last_four_digits: firstNonEmptySlice(block, 462, 488),
    transaction_type: normalizeText(sliceText(block[0], 498, 550)),
    charge_type: normalizeText(sliceText(block[0], 560, 620)),
    amount: normalizeCurrencyAmount(firstNonEmptySlice(block, 718, 766)),
    username: normalizeText(firstNonEmptySlice(block, 780, 816)),
    note: joinTextParts(block.slice(1).map((line) => joinTextParts([
      sliceText(line, 390, 620),
      sliceText(line, 720, 816)
    ])))
  }));
}

function parseClosedFolioBalances(document: PdfDocumentText): Array<Record<string, string | null>> {
  return parseHolidayFolioBalanceReport(document, "closed");
}

function parseInHouseGuestFolioBalances(document: PdfDocumentText): Array<Record<string, string | null>> {
  return parseHolidayFolioBalanceReport(document, "in-house");
}

function parseHolidayFolioBalanceReport(
  document: PdfDocumentText,
  mode: "closed" | "in-house"
): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: "Reservations" | "Net Totals" | "Balances" | null = null;
  let detailBlock: PdfLine[] = [];
  let totalBlock: PdfLine[] = [];

  const flushDetail = (): void => {
    if (detailBlock.length === 0) {
      return;
    }

    if (mode === "in-house") {
      rows.push({
        section,
        row_kind: "detail",
        summary_label: null,
        confirmation_no: firstNonEmptySlice(detailBlock, 24, 92),
        group_code: firstNonEmptySlice(detailBlock, 96, 138),
        room_number: firstNonEmptySlice(detailBlock, 140, 166),
        guest_name: joinSlices(detailBlock, 182, 248),
        additional_guests: joinSlices(detailBlock, 248, 286),
        company_name: joinSlices(detailBlock, 288, 360),
        check_in_date: parseShortDate(firstNonEmptySlice(detailBlock, 346, 390)),
        check_out_date: parseShortDate(firstNonEmptySlice(detailBlock, 400, 442)),
        rate_plan: firstNonEmptySlice(detailBlock, 456, 490),
        payment_method: joinSlices(detailBlock, 506, 560),
        reservation_status: joinSlices(detailBlock, 560, 620),
        todays_charges: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 612, 658)),
        todays_payments: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 668, 710)),
        opening_balance: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 718, 766)),
        net_change: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 772, 820)),
        ending_balance: null,
        metric_value: null,
        note: null
      });
    } else {
      rows.push({
        section,
        row_kind: "detail",
        summary_label: null,
        confirmation_no: firstNonEmptySlice(detailBlock, 34, 86),
        group_code: null,
        room_number: null,
        guest_name: joinSlices(detailBlock, 100, 184),
        additional_guests: null,
        company_name: joinSlices(detailBlock, 184, 250),
        check_in_date: parseShortDate(firstNonEmptySlice(detailBlock, 252, 300)),
        check_out_date: parseShortDate(firstNonEmptySlice(detailBlock, 324, 372)),
        rate_plan: null,
        payment_method: null,
        reservation_status: joinSlices(detailBlock, 388, 454),
        todays_charges: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 476, 516)),
        todays_payments: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 548, 586)),
        opening_balance: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 612, 666)),
        net_change: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 692, 730)),
        ending_balance: normalizeCurrencyAmount(joinCompactSlices(detailBlock, 758, 812)),
        metric_value: null,
        note: null
      });
    }

    detailBlock = [];
  };

  const flushReservationTotal = (): void => {
    if (totalBlock.length === 0) {
      return;
    }

    if (mode === "in-house") {
      rows.push({
        section: "Reservations",
        row_kind: "total",
        summary_label: "Totals",
        confirmation_no: null,
        group_code: null,
        room_number: null,
        guest_name: null,
        additional_guests: null,
        company_name: null,
        check_in_date: null,
        check_out_date: null,
        rate_plan: null,
        payment_method: null,
        reservation_status: null,
        todays_charges: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 612, 658)),
        todays_payments: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 668, 710)),
        opening_balance: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 718, 766)),
        net_change: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 772, 820)),
        ending_balance: null,
        metric_value: null,
        note: null
      });
    } else {
      rows.push({
        section: "Reservations",
        row_kind: "total",
        summary_label: "Totals",
        confirmation_no: null,
        group_code: null,
        room_number: null,
        guest_name: null,
        additional_guests: null,
        company_name: null,
        check_in_date: null,
        check_out_date: null,
        rate_plan: null,
        payment_method: null,
        reservation_status: null,
        todays_charges: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 476, 516)),
        todays_payments: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 548, 586)),
        opening_balance: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 612, 666)),
        net_change: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 692, 730)),
        ending_balance: normalizeCurrencyAmount(joinCompactSlices(totalBlock, 758, 812)),
        metric_value: null,
        note: null
      });
    }

    totalBlock = [];
  };

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text)) {
      continue;
    }
    if (text === "Reservations" || text === "Net Totals" || text === "Balances") {
      flushDetail();
      flushReservationTotal();
      section = text;
      continue;
    }

    if (
      text.startsWith("Confirmatio Group Room Guest")
      || text.startsWith("n Number Code Number Name")
      || text === "Balance"
      || text.startsWith("Confirmation Guest Name Company Name")
      || text.startsWith("Number Payments Opening Change")
      || text.startsWith("Today's Charges Today's Payments Today's Opening Balance")
    ) {
      continue;
    }

    if (section === "Reservations") {
      if (/^\d{8}\b/.test(text)) {
        flushDetail();
        flushReservationTotal();
        detailBlock = [line];
        continue;
      }
      if (/^Totals\b/.test(text)) {
        flushDetail();
        flushReservationTotal();
        totalBlock = [line];
        continue;
      }
      if (detailBlock.length > 0) {
        detailBlock.push(line);
        continue;
      }
      if (totalBlock.length > 0) {
        totalBlock.push(line);
        continue;
      }
    }

    if (section === "Net Totals") {
      const values = extractCurrencyTokens(text);
      if (values.length >= 4) {
        rows.push({
          section,
          row_kind: /^Totals\b/.test(text) ? "total" : "summary",
          summary_label: normalizeText(text.slice(0, values[0]?.index ?? 0)),
          confirmation_no: null,
          group_code: null,
          room_number: null,
          guest_name: null,
          additional_guests: null,
          company_name: null,
          check_in_date: null,
          check_out_date: null,
          rate_plan: null,
          payment_method: null,
          reservation_status: null,
          todays_charges: values[0]?.value ?? null,
          todays_payments: values[1]?.value ?? null,
          opening_balance: values[2]?.value ?? null,
          net_change: values[3]?.value ?? null,
          ending_balance: values[4]?.value ?? null,
          metric_value: null,
          note: null
        });
      }
      continue;
    }

    if (section === "Balances") {
      const values = extractCurrencyTokens(text);
      if (values.length > 0) {
        rows.push({
          section,
          row_kind: "metric",
          summary_label: normalizeText(text.slice(0, values[0]?.index ?? 0)),
          confirmation_no: null,
          group_code: null,
          room_number: null,
          guest_name: null,
          additional_guests: null,
          company_name: null,
          check_in_date: null,
          check_out_date: null,
          rate_plan: null,
          payment_method: null,
          reservation_status: null,
          todays_charges: null,
          todays_payments: null,
          opening_balance: null,
          net_change: null,
          ending_balance: null,
          metric_value: values[0]?.value ?? null,
          note: null
        });
      }
    }
  }

  flushDetail();
  flushReservationTotal();
  return rows;
}

function parseRateReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = document.lines.filter((line) => {
    const text = line.text;
    return Boolean(text)
      && !shouldSkipCommonLine(text)
      && text !== "Rate Report"
      && !text.startsWith("Room Room Guest Adults Children")
      && text !== "Balance";
  });

  const blocks = collectLineBlocks(lines, (line) => /^\d+\s+[A-Z0-9]{3,4}\b/.test(line.text));
  return blocks.map((block) => ({
    room_number: firstNonEmptySlice(block, 30, 58),
    room_type: firstNonEmptySlice(block, 70, 106),
    guest_name: joinSlices(block, 114, 170),
    adults: firstNonEmptySlice(block, 176, 192),
    children: firstNonEmptySlice(block, 220, 238),
    reservation_status: joinSlices(block, 258, 318),
    nights: firstNonEmptySlice(block, 314, 334),
    check_in_date: parseShortDate(firstNonEmptySlice(block, 344, 390)),
    check_out_date: parseShortDate(firstNonEmptySlice(block, 392, 438)),
    room_rate: normalizeCurrencyAmount(joinCompactSlices(block, 440, 478)),
    room_fees: normalizeCurrencyAmount(joinCompactSlices(block, 486, 524)),
    total_guest_balance: normalizeCurrencyAmount(joinCompactSlices(block, 532, 572)),
    note: null
  }));
}

function parseReservationListing(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = null;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || shouldSkipVisibleTitleLine(text)) {
      continue;
    }
    if (text === "Reservations" || text === "In House" || text === "No Show" || text === "Cancelled") {
      section = text;
      continue;
    }
    if (
      text.startsWith("Market Local Market Confirmation")
      || text.startsWith("Segment Segment Number")
      || text.startsWith("Code Code Number")
    ) {
      continue;
    }
    if (/^Totals\b/.test(text)) {
      rows.push({
        section,
        row_kind: "total",
        summary_label: "Totals",
        market_segment_code: null,
        local_segment_code: null,
        confirmation_no: null,
        group_number: null,
        group_code: null,
        external_confirmation_no: null,
        external_cancellation_no: null,
        po_number: null,
        ota_booking_number: null,
        package_number: null,
        note: null
      });
      continue;
    }

    const tokens = text.split(/\s+/);
    if (tokens.length < 3) {
      continue;
    }

    const hasLocalSegment = tokens[1] != null && /^[A-Z]$/.test(tokens[1]) && tokens.length >= 4;
    const marketSegmentCode = tokens[0] ?? null;
    const localSegmentCode = hasLocalSegment ? tokens[1] ?? null : null;
    const baseIndex = hasLocalSegment ? 2 : 1;
    const extras = tokens.slice(baseIndex + 2);

    rows.push({
      section,
      row_kind: "detail",
      summary_label: null,
      market_segment_code: marketSegmentCode,
      local_segment_code: localSegmentCode,
      confirmation_no: tokens[baseIndex] ?? null,
      group_number: tokens[baseIndex + 1] ?? null,
      group_code: extras[0] ?? null,
      external_confirmation_no: extras[1] ?? null,
      external_cancellation_no: section === "Cancelled" ? (extras[2] ?? null) : null,
      po_number: section === "Cancelled" ? (extras[3] ?? null) : (extras[2] ?? null),
      ota_booking_number: section === "Cancelled" ? (extras[4] ?? null) : (extras[3] ?? null),
      package_number: section === "Cancelled" ? (extras[5] ?? null) : (extras[4] ?? null),
      note: null
    });
  }

  return rows;
}

function parseTrialBalanceReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = document.lines.filter((line) => {
    const text = line.text;
    return Boolean(text)
      && !shouldSkipCommonLine(text)
      && text !== "Trial Balance Report"
      && !text.startsWith("Type Account Name")
      && text !== "Code Balance Balance";
  });

  const blocks = collectLineBlocks(lines, (line) => (
    /^(?:ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE)\b/.test(line.text)
    || /^(?:Total|Grand Total)\b/.test(line.text)
  ));

  return blocks.map((block) => ({
    row_kind: /^(?:Total|Grand Total)\b/.test(block[0]?.text ?? "") ? "total" : "detail",
    account_type: firstNonEmptySlice(block, 34, 80),
    account_name: joinSlices(block, 80, 176),
    transaction_code: firstNonEmptySlice(block, 176, 214),
    opening_balance: normalizeCurrencyAmount(joinCompactSlices(block, 232, 298)),
    debit_amount: normalizeCurrencyAmount(joinCompactSlices(block, 314, 352)),
    credit_amount: normalizeCurrencyAmount(joinCompactSlices(block, 374, 430)),
    net_change: normalizeCurrencyAmount(joinCompactSlices(block, 444, 502)),
    closing_balance: normalizeCurrencyAmount(joinCompactSlices(block, 510, 574)),
    note: null
  }));
}

function parseAdvanceDepositActivity(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = filterDataLines(document, new Set([
    "Advance Deposit Activity",
    "Reservations",
    "Confirmation",
    "Number",
    "Guest Name Check In Date Rate Plan Name Payment Method Due Date Deposit Posted"
  ]));

  const blocks = collectLineBlocks(
    lines,
    (line) => /^\d{8}$/.test(sliceText(line, 40, 80)) && Boolean(parseShortDate(sliceText(line, 190, 240))),
    (line) => /^Totals\b/.test(line.text)
  );

  return blocks.map((block) => ({
    confirmation_no: firstNonEmptySlice(block, 40, 80),
    guest_name: joinSlices(block, 105, 170),
    check_in_date: parseShortDate(firstNonEmptySlice(block, 190, 240)),
    rate_plan_name: joinSlices(block, 265, 330),
    payment_method: joinSlices(block, 345, 410),
    due_date: parseShortDate(firstNonEmptySlice(block, 435, 480)),
    deposit_posted: normalizeAmount(firstNonEmptySlice(block, 505, 565))
  }));
}

function parseBookedReservations(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = filterDataLines(document, new Set([
    "Booked Reservations",
    "Confirmation Guarantee",
    "Number Method",
    "Booking Date Guest Name Company Name Arrival Date Nights Rate Plan Total Room Rate ADR Booked By"
  ]));

  const blocks = collectLineBlocks(
    lines,
    (line) => Boolean(parseShortDate(sliceText(line, 30, 82))) && /^\d{8}$/.test(sliceText(line, 108, 150)),
    (line) => /^Totals\b/.test(line.text)
  );

  return blocks.map((block) => ({
    booking_date: parseShortDate(firstNonEmptySlice(block, 30, 82)),
    confirmation_no: firstNonEmptySlice(block, 108, 150),
    guest_name: joinSlices(block, 170, 235),
    company_name: joinSlices(block, 240, 315),
    arrival_date: parseShortDate(firstNonEmptySlice(block, 322, 372)),
    nights: normalizeAmount(firstNonEmptySlice(block, 408, 434)),
    rate_plan: joinSlices(block, 475, 515),
    total_room_rate: normalizeAmount(firstNonEmptySlice(block, 535, 600)),
    adr: normalizeAmount(firstNonEmptySlice(block, 620, 655)),
    booked_by: joinSlices(block, 685, 738),
    guarantee_method: joinSlices(block, 756, 814)
  }));
}

function parseDirectBillAging(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = null;
  let pendingCompany: string[] = [];

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text)) {
      continue;
    }
    if (text === "Direct Bill Aging" || text === "Accounts Receivables" || text === "Invoices" || text === "Settlements" || text === "Totals") {
      section = text;
      pendingCompany = [];
      continue;
    }
    if (text.startsWith("Company Name Company Code") || text.startsWith("Current Over7 Over14")) {
      continue;
    }

    const currentAmount = normalizeAmount(sliceText(line, 220, 260));
    const totalAmount = normalizeAmount(sliceText(line, 756, 798));
    if (currentAmount || totalAmount) {
      const inlineCompany = normalizeText(sliceText(line, 24, 104));
      rows.push({
        section,
        company_name: inlineCompany || (pendingCompany.length > 0 ? pendingCompany.join(" ") : (text.startsWith("Totals") ? "Totals" : null)),
        company_code: normalizeText(sliceText(line, 128, 182)),
        current_amount: currentAmount,
        over_30_amount: normalizeAmount(sliceText(line, 315, 348)),
        over_60_amount: normalizeAmount(sliceText(line, 404, 437)),
        over_90_amount: normalizeAmount(sliceText(line, 493, 526)),
        over_120_amount: normalizeAmount(sliceText(line, 584, 612)),
        over_150_amount: normalizeAmount(sliceText(line, 675, 701)),
        total_amount: totalAmount
      });
      pendingCompany = [];
      continue;
    }

    const companyFragment = normalizeText(sliceText(line, 24, 104));
    if (companyFragment && !isDirectBillAgingHeader(companyFragment)) {
      pendingCompany.push(companyFragment);
    }
  }

  return rows;
}

function parseDirectBillLedger(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = filterDataLines(document, new Set([
    "Direct Bill Ledger Details",
    "Accounts Receivables",
    "Company Confirmatio Check In Check Out Over 120",
    "Guest Name Current Over7 Over14 Over 30 Over 60 Over 90 Over 150 Total",
    "Name n Number Date Date Days"
  ]));

  const blocks = collectLineBlocks(
    lines,
    (line) => /^\d{8}$/.test(sliceText(line, 86, 126)) && Boolean(parseShortDate(sliceText(line, 198, 242))),
    (line) => /^Totals\b/.test(line.text)
  );

  return blocks.map((block) => ({
    company_name: joinSlices(block, 24, 74),
    confirmation_no: firstNonEmptySlice(block, 86, 126),
    guest_name: joinSlices(block, 140, 188),
    check_in_date: parseShortDate(firstNonEmptySlice(block, 198, 242)),
    check_out_date: parseShortDate(firstNonEmptySlice(block, 255, 300)),
    current_amount: normalizeAmount(firstNonEmptySlice(block, 318, 352)),
    over_7_amount: normalizeAmount(firstNonEmptySlice(block, 378, 405)),
    over_14_amount: normalizeAmount(firstNonEmptySlice(block, 435, 463)),
    over_30_amount: normalizeAmount(firstNonEmptySlice(block, 492, 520)),
    over_60_amount: normalizeAmount(firstNonEmptySlice(block, 548, 577)),
    over_90_amount: normalizeAmount(firstNonEmptySlice(block, 605, 634)),
    over_120_days_amount: normalizeAmount(firstNonEmptySlice(block, 664, 691)),
    over_150_amount: normalizeAmount(firstNonEmptySlice(block, 722, 748)),
    total_amount: normalizeAmount(firstNonEmptySlice(block, 775, 810))
  }));
}

function parseFinalAudit(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = null;
  let pendingLabel: string[] = [];
  let unlabeledCount = 0;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || isFinalAuditHeader(text)) {
      continue;
    }

    const sectionFromHeader = getFinalAuditSectionHeader(text);
    if (sectionFromHeader) {
      section = sectionFromHeader;
      pendingLabel = [];
      unlabeledCount = 0;
      continue;
    }

    const valueLimit = getFinalAuditValueLimit(section);
    const metric = extractMetricLine(text, valueLimit);
    if (!metric) {
      pendingLabel.push(text);
      continue;
    }

    const labelPieces = metric.label ? [metric.label] : [];
    if (pendingLabel.length > 0) {
      labelPieces.unshift(...pendingLabel);
    }
    pendingLabel = [];
    let metricName = normalizeText(labelPieces.join(" "));
    if (!metricName) {
      unlabeledCount += 1;
      metricName = `Row ${unlabeledCount}`;
    }

    rows.push({
      section,
      metric_name: metricName,
      value_1: metric.values[0] ?? null,
      value_2: metric.values[1] ?? null,
      value_3: metric.values[2] ?? null,
      value_4: metric.values[3] ?? null,
      value_5: metric.values[4] ?? null,
      value_6: metric.values[5] ?? null,
      value_7: metric.values[6] ?? null,
      value_8: metric.values[7] ?? null,
      value_9: metric.values[8] ?? null,
      value_10: metric.values[9] ?? null
    });
  }

  return rows;
}

function parseHighBalanceReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = filterDataLines(document, new Set([
    "High Balance Report",
    "Room Departure Credit Outstanding Payment Available Auto Top Off",
    "Guest Name Guest Tier Arrival Date Room Rate Folio Name Folio Balance",
    "Number Date Balance Balance Method Credit Limit Status"
  ]));

  const blocks = collectLineBlocks(
    lines,
    (line) => /^\d+$/.test(sliceText(line, 40, 60)) && Boolean(parseShortDate(sliceText(line, 212, 258))),
    (line) => /^Totals\b/.test(line.text)
  );

  return blocks.map((block) => ({
    room_number: firstNonEmptySlice(block, 40, 60),
    guest_name: joinSlices(block, 84, 140),
    guest_tier: joinSlices(block, 150, 196),
    arrival_date: parseShortDate(firstNonEmptySlice(block, 212, 258)),
    departure_date: parseShortDate(firstNonEmptySlice(block, 274, 320)),
    room_rate: normalizeAmount(firstNonEmptySlice(block, 340, 382)),
    folio_name: joinSlices(block, 398, 442),
    folio_balance: normalizeAmount(firstNonEmptySlice(block, 456, 510)),
    credit_balance: normalizeAmount(firstNonEmptySlice(block, 528, 562)),
    outstanding_balance: normalizeAmount(firstNonEmptySlice(block, 586, 624)),
    payment_method: joinSlices(block, 640, 695),
    available_credit_limit: normalizeAmount(firstNonEmptySlice(block, 706, 752)),
    auto_top_off_status: joinSlices(block, 776, 806)
  }));
}

function parseHotelStatistics(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = null;
  let pendingLabel: string[] = [];
  let unlabeledCount = 0;

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || isHotelStatisticsHeader(text)) {
      continue;
    }

    if (HOTEL_STATISTICS_SECTIONS.has(text)) {
      section = text;
      pendingLabel = [];
      unlabeledCount = 0;
      continue;
    }

    const metric = extractMetricLine(text, 5);
    if (!metric) {
      pendingLabel.push(text);
      continue;
    }

    const labelPieces = metric.label ? [metric.label] : [];
    if (pendingLabel.length > 0) {
      labelPieces.unshift(...pendingLabel);
    }
    pendingLabel = [];
    let metricName = normalizeText(labelPieces.join(" "));
    if (!metricName) {
      unlabeledCount += 1;
      metricName = `Row ${unlabeledCount}`;
    }

    rows.push({
      section,
      metric_name: metricName,
      value_1: metric.values[0] ?? null,
      value_2: metric.values[1] ?? null,
      value_3: metric.values[2] ?? null,
      value_4: metric.values[3] ?? null,
      value_5: metric.values[4] ?? null
    });
  }

  return rows;
}

function parseMaintenanceSummary(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let pendingReason: string[] = [];

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text === "Maintenance Summary" || text.startsWith("Date Day of week")) {
      continue;
    }
    if (/^Totals\b/.test(text)) {
      rows.push({
        business_date: null,
        day_of_week: null,
        maintenance_type: "Totals",
        reason: null,
        open_issues: normalizeAmount(sliceText(line, 525, 545)),
        closed_issues: normalizeAmount(sliceText(line, 640, 660)),
        cancelled_issues: normalizeAmount(sliceText(line, 756, 772))
      });
      pendingReason = [];
      continue;
    }

    const businessDate = parseShortDate(sliceText(line, 55, 98));
    if (businessDate) {
      rows.push({
        business_date: businessDate,
        day_of_week: normalizeText(sliceText(line, 170, 210)),
        maintenance_type: normalizeText(sliceText(line, 270, 340)),
        reason: normalizeText([sliceText(line, 385, 458), ...pendingReason].filter(Boolean).join(" ")) || null,
        open_issues: normalizeAmount(sliceText(line, 525, 545)),
        closed_issues: normalizeAmount(sliceText(line, 640, 660)),
        cancelled_issues: normalizeAmount(sliceText(line, 756, 772))
      });
      pendingReason = [];
      continue;
    }

    const reasonFragment = normalizeText(sliceText(line, 385, 458)) || normalizeText(text);
    if (reasonFragment) {
      pendingReason.push(reasonFragment);
    }
  }

  return rows;
}

function parseOccupancyForecast(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];

  for (const line of document.lines) {
    const date = parseShortDate(sliceText(line, 28, 72));
    if (!date) {
      continue;
    }

    rows.push({
      business_date: date,
      day_of_week: normalizeText(sliceText(line, 88, 138)),
      group_confirmed_revenue: normalizeAmount(sliceText(line, 150, 196)),
      transient_confirmed_revenue: normalizeAmount(sliceText(line, 218, 248)),
      total_confirmed_revenue: normalizeAmount(sliceText(line, 274, 320)),
      allocation_revenue: normalizeAmount(sliceText(line, 345, 372)),
      total_available_revenue: normalizeAmount(sliceText(line, 398, 444)),
      total_rooms: normalizeAmount(sliceText(line, 474, 490)),
      ooo_rooms: normalizeAmount(sliceText(line, 536, 550)),
      available_rooms: normalizeAmount(sliceText(line, 596, 614)),
      arrivals: normalizeAmount(sliceText(line, 660, 676)),
      stay_overs: normalizeAmount(sliceText(line, 720, 738)),
      departures: normalizeAmount(sliceText(line, 782, 798))
    });
  }

  return rows;
}

function parseRateOverride(document: PdfDocumentText): Array<Record<string, string | null>> {
  const lines = filterDataLines(document, new Set([
    "Rate Override",
    "Modificatio Confirmatio Check In Check Out Guest Room Override Override",
    "Stay Date Time Room Type Sold Rate New Rate Rate Plan Username",
    "n Date n Number Date Date Name Nights Amount Reason"
  ]));

  const blocks = collectLineBlocks(
    lines,
    (line) => Boolean(parseShortDate(sliceText(line, 26, 68))) && /^\d{8}$/.test(sliceText(line, 186, 226)),
    (line) => /^Totals\b/.test(line.text)
  );

  return blocks.map((block) => ({
    modification_date: parseShortDate(firstNonEmptySlice(block, 26, 68)),
    stay_date: parseShortDate(firstNonEmptySlice(block, 78, 122)),
    modification_time: normalizeText(firstNonEmptySlice(block, 134, 172)),
    confirmation_no: firstNonEmptySlice(block, 186, 226),
    check_in_date: parseShortDate(firstNonEmptySlice(block, 238, 282)),
    check_out_date: parseShortDate(firstNonEmptySlice(block, 292, 336)),
    guest_name: joinSlices(block, 350, 435),
    stay_nights: normalizeAmount(firstNonEmptySlice(block, 408, 434)),
    room_type: joinSlices(block, 450, 500),
    sold_rate: normalizeAmount(firstNonEmptySlice(block, 508, 548)),
    new_rate: normalizeAmount(firstNonEmptySlice(block, 562, 602)),
    rate_plan: joinSlices(block, 616, 654),
    override_amount: normalizeAmount(firstNonEmptySlice(block, 670, 706)),
    username: joinSlices(block, 720, 762),
    reason: joinSlices(block, 772, 818)
  }));
}

function parseTaxReport(document: PdfDocumentText): Array<Record<string, string | null>> {
  const rows: Array<Record<string, string | null>> = [];
  let section: string | null = "Summary";
  let detailBuffer: PdfLine[] = [];

  const flushDetailBuffer = (): void => {
    if (detailBuffer.length === 0) {
      return;
    }
    rows.push({
      section,
      tax_name: null,
      total_revenue: null,
      exempted_revenue: null,
      taxable_payable: null,
      payable_tax: null,
      exempted_tax: null,
      transaction_number: firstNonEmptySlice(detailBuffer, 40, 80),
      folio_number: firstNonEmptySlice(detailBuffer, 122, 156),
      transaction_type: joinSlices(detailBuffer, 190, 244),
      room_number: firstNonEmptySlice(detailBuffer, 290, 312),
      guest_name: joinSlices(detailBuffer, 344, 418),
      company_name: joinSlices(detailBuffer, 424, 498),
      check_in_date: parseShortDate(firstNonEmptySlice(detailBuffer, 598, 642)),
      check_out_date: parseShortDate(firstNonEmptySlice(detailBuffer, 678, 724)),
      exemption_category: joinSlices(detailBuffer, 516, 570),
      revenue: normalizeAmount(firstNonEmptySlice(detailBuffer, 764, 800))
    });
    detailBuffer = [];
  };

  for (const line of document.lines) {
    const text = line.text;
    if (!text || shouldSkipCommonLine(text) || text === "Tax Report") {
      continue;
    }
    if (text === "Summary" || text === "Exempted Tax Details" || text === "Non Exempted Tax Details") {
      flushDetailBuffer();
      section = text;
      continue;
    }
    if (
      text.startsWith("Tax Name Total Revenue")
      || text.startsWith("Transaction Tax Exemption Exempted")
      || text.startsWith("Folio Number Transaction Type")
      || text.startsWith("Number Category Revenue")
      || text.startsWith("Transaction Number Folio Number Transaction Type")
    ) {
      continue;
    }

    if (section === "Summary") {
      const payableTax = normalizeAmount(sliceText(line, 600, 642));
      const exemptedTax = normalizeAmount(sliceText(line, 740, 768));
      if (!payableTax && !exemptedTax) {
        continue;
      }
      rows.push({
        section,
        tax_name: normalizeText(sliceText(line, 50, 122)) || (text.startsWith("Totals") ? "Totals" : null),
        total_revenue: normalizeAmount(sliceText(line, 198, 242)),
        exempted_revenue: normalizeAmount(sliceText(line, 334, 372)),
        taxable_payable: normalizeAmount(sliceText(line, 464, 510)),
        payable_tax: payableTax,
        exempted_tax: exemptedTax,
        transaction_number: null,
        folio_number: null,
        transaction_type: null,
        room_number: null,
        guest_name: null,
        company_name: null,
        check_in_date: null,
        check_out_date: null,
        exemption_category: null,
        revenue: null
      });
      continue;
    }

    const transactionNumber = firstNonEmptySlice([line], 40, 80);
    const detailStart = /^\d+$/.test(transactionNumber ?? "");
    if (detailStart) {
      flushDetailBuffer();
      detailBuffer = [line];
      continue;
    }
    if (detailBuffer.length > 0) {
      detailBuffer.push(line);
    }
  }

  flushDetailBuffer();
  return rows;
}

const HOTEL_STATISTICS_SECTIONS = new Set([
  "Room Statistics",
  "Performance Statistics",
  "Revenue Performance",
  "Taxes",
  "Payments",
  "Guest Statistics",
  "Guest Performance Statistics",
  "Today's Activity",
  "Forecast Guest Statistics",
  "Forecast Performance Statistics"
]);

function filterDataLines(document: PdfDocumentText, extraSkips: Set<string>): PdfLine[] {
  return document.lines.filter((line) => {
    const text = line.text;
    return Boolean(text) && !shouldSkipCommonLine(text) && !extraSkips.has(text);
  });
}

function collectLineBlocks(
  lines: PdfLine[],
  isStart: (line: PdfLine) => boolean,
  isStop?: (line: PdfLine) => boolean
): PdfLine[][] {
  const blocks: PdfLine[][] = [];
  let current: PdfLine[] = [];

  for (const line of lines) {
    if (isStop?.(line)) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }

    if (isStart(line)) {
      if (current.length > 0) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }

    if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function firstNonEmptySlice(lines: PdfLine[], minX: number, maxX: number): string | null {
  for (const line of lines) {
    const value = normalizeText(sliceText(line, minX, maxX));
    if (value) {
      return value;
    }
  }
  return null;
}

function joinSlices(lines: PdfLine[], minX: number, maxX: number): string | null {
  const parts = lines
    .map((line) => normalizeText(sliceText(line, minX, maxX)))
    .filter((value): value is string => Boolean(value));

  if (parts.length === 0) {
    return null;
  }

  return normalizeText(parts.join(" "));
}

function joinCompactSlices(lines: PdfLine[], minX: number, maxX: number): string | null {
  return joinCompactText(lines.map((line) => sliceText(line, minX, maxX)));
}

function isNamedDateTimeLine(text: string): boolean {
  return /^\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}\b/.test(text);
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function normalizeCurrencyAmount(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let cleaned = value.trim().replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }

  let negative = false;
  if (cleaned.startsWith("(") && cleaned.endsWith(")")) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("-")) {
    negative = true;
    cleaned = cleaned.slice(1);
  }
  if (cleaned.endsWith("-")) {
    negative = true;
    cleaned = cleaned.slice(0, -1);
  }

  cleaned = cleaned
    .replace(/USD/gi, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/%/g, "");

  if (!cleaned) {
    return null;
  }

  return /^\d+(?:\.\d+)?$/.test(cleaned) ? `${negative ? "-" : ""}${cleaned}` : value.trim();
}

function normalizeAmount(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value
    .replace(/,/g, "")
    .replace(/USD/gi, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, "")
    .replace(/%/g, "");

  if (!cleaned) {
    return null;
  }

  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? cleaned : value.trim();
}

function normalizeFlexibleNumeric(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  let cleaned = value.trim().replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }

  const isWrappedNegative = cleaned.startsWith("(") && cleaned.endsWith(")");
  if (isWrappedNegative) {
    cleaned = `-${cleaned.slice(1, -1)}`;
  }
  if (cleaned.endsWith("-")) {
    cleaned = `-${cleaned.slice(0, -1)}`;
  }

  cleaned = cleaned.replace(/USD/gi, "").replace(/\$/g, "").replace(/,/g, "").replace(/%/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? cleaned : value.trim();
}

function extractCurrencyTokens(text: string): Array<{ index: number; value: string }> {
  const matches = Array.from(text.matchAll(/\(?-?(?:USD|\$)?\d[\d,]*(?:\.\d+)?\)?-?/gi));
  return matches.map((match) => ({
    index: match.index ?? 0,
    value: normalizeCurrencyAmount(match[0]) ?? match[0]
  }));
}

function extractBestWesternMetricLine(text: string, maxValues: number): { label: string | null; values: string[] } | null {
  const tokenPattern = /\(?-?\$?\d[\d,]*(?:\.\d+)?\)?-?/g;
  const tokens = Array.from(text.matchAll(tokenPattern));
  if (tokens.length === 0 || tokens.length > maxValues) {
    return null;
  }

  const label = normalizeText(text.slice(0, tokens[0].index ?? 0));
  return {
    label,
    values: tokens.map((token) => normalizeFlexibleNumeric(token[0]) ?? token[0])
  };
}

function extractMetricLine(text: string, maxValues: number): { label: string | null; values: string[] } | null {
  const normalized = text.replace(/(\d)\s+%/g, "$1%");
  const tokenPattern = /-?\$?\d[\d,]*(?:\.\d+)?%?/g;
  const tokens = Array.from(normalized.matchAll(tokenPattern));
  if (tokens.length === 0 || tokens.length > maxValues) {
    return null;
  }

  const lastToken = tokens[tokens.length - 1];
  if (!lastToken.index && lastToken.index !== 0) {
    return null;
  }

  const label = normalizeText(normalized.slice(0, tokens[0].index ?? 0));
  const values = tokens.map((token) => normalizeAmount(token[0]) ?? token[0]);
  return { label, values };
}

function isDirectBillAgingHeader(text: string): boolean {
  return text === "Company Name"
    || text === "Company Code"
    || text === "Current"
    || text.startsWith("Over ");
}

function getFinalAuditSectionHeader(text: string): string | null {
  if (text === "Room Revenue" || text === "Other Room Revenue" || text === "Charges" || text === "Revenue & Charges" || text === "Taxes" || text === "Balance Information" || text === "Turn Away Information" || text === "Cash Deposit And Cash Drop" || text === "Statistical Counts") {
    return text;
  }
  if (text === "Payments") {
    return "Payments";
  }
  if (text.startsWith("Cash Actual Today")) {
    return "Payments / Cash";
  }
  if (text.startsWith("Card Actual Today")) {
    return "Payments / Card";
  }
  if (text.startsWith("Other Actual Today")) {
    return "Payments / Other";
  }
  if (text.startsWith("DIRECT BILL Actual Today")) {
    return "Payments / Direct Bill";
  }
  return null;
}

function getFinalAuditValueLimit(section: string | null): number {
  if (section === "Balance Information") {
    return 3;
  }
  if (section === "Turn Away Information") {
    return 2;
  }
  if (section === "Cash Deposit And Cash Drop") {
    return 4;
  }
  if (section === "Statistical Counts") {
    return 5;
  }
  return 10;
}

function isFinalAuditHeader(text: string): boolean {
  return text === "Adjusted"
    || text === "Transferred"
    || text.startsWith("Charge Type Actual Today")
    || text.startsWith("Cash Actual Today")
    || text.startsWith("Card Actual Today")
    || text.startsWith("Other Actual Today")
    || text.startsWith("DIRECT BILL Actual Today")
    || text.startsWith("Tax Type Actual Today")
    || text.startsWith("Actual Today Adjusted Net Today")
    || text.startsWith("Type Actual Today Adjusted Net Today")
    || text.startsWith("Type Actual Today M-T-D");
}

function isHotelStatisticsHeader(text: string): boolean {
  return text === "Hotel Statistics"
    || text.startsWith("Description Actual Today");
}

function isDailyTransactionLogDetailLine(line: PdfLine): boolean {
  const code = normalizeText(sliceText(line, 18, 40));
  const transactionId = normalizeText(sliceText(line, 166, 208));
  return Boolean(code && /^[A-Z0-9]{2}$/.test(code) && transactionId && /^\d+$/.test(transactionId));
}

function isCreditCardDetailLine(line: PdfLine): boolean {
  const cardType = normalizeText(sliceText(line, 14, 34));
  const cardNumberFragment = normalizeText(sliceText(line, 42, 78));
  const transactionId = normalizeText(sliceText(line, 556, 594));
  return Boolean(cardType && /^[A-Z]{2}$/.test(cardType) && cardNumberFragment && transactionId && /^\d+$/.test(transactionId));
}

function isOperatorTransactionDetailLine(line: PdfLine): boolean {
  const code = normalizeText(sliceText(line, 16, 34));
  const transactionId = normalizeText(sliceText(line, 140, 184));
  return Boolean(code && /^[A-Z0-9]{2}$/.test(code) && transactionId && /^\d+$/.test(transactionId));
}

function sliceText(line: PdfLine, minX: number, maxX: number): string {
  const items = line.items.filter((item) => {
    const center = item.x + item.width / 2;
    return center >= minX && center < maxX;
  });
  return items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
}

function sliceOptionalText(line: PdfLine | null, minX: number, maxX: number): string {
  return line ? sliceText(line, minX, maxX) : "";
}

function normalizeNumeric(value: string): string | null {
  const cleaned = value.replace(/,/g, "").replace(/\s+/g, "");
  if (!cleaned) {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) {
    return cleaned;
  }
  return value.trim() || null;
}

function normalizePercent(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\s+/g, "") : null;
}

function normalizeDateTime(value: string): string | null {
  const match = value.match(/^(\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!match) {
    return value.trim() || null;
  }

  const date = parseShortDate(match[1]);
  return date ? `${date}T${match[2]}:00` : value.trim();
}

function determineBestWesternDetailRowKind(line: PdfLine): "detail" | "total" | null {
  const text = line.text;
  if (!text) {
    return null;
  }

  if (normalizeText(sliceText(line, 118, 156)) === "Totals") {
    return "total";
  }

  const transactionCount = normalizeFlexibleNumeric(sliceText(line, 288, 306));
  if (!transactionCount) {
    return null;
  }

  const postingCode = normalizeText(sliceText(line, 118, 156));
  return postingCode ? "detail" : null;
}

function shouldSkipCommonLine(text: string): boolean {
  return text.startsWith("Red Lion Hotel")
    || /^\d{2}-\d{2}-\d{2}$/.test(text)
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)
    || /^\d{2}:\d{2}$/.test(text)
    || /^Page \d+ of \d+/.test(text)
    || /^Page\d+\s*\/\s*\d+$/i.test(text)
    || /^Page\s+\d+\s*\/\s*\d+$/i.test(text)
    || /^Filter\b/.test(text)
    || /^Sort Order\b/.test(text)
    || /^Resv\. Status\b/.test(text)
    || /^history_forecast\b/.test(text)
    || /^res_rate_compare\b/.test(text)
    || text === "History and Forecast"
    || text === "Manager - Flash Last Day"
    || text === "Reservations - made Yesterday"
    || text === "Zero Rate Rooms"
    || text === "AR Detailed Aging"
    || text === "Rate Change Report"
    || text === "A/R Aging"
    || text === "All Transactions"
    || text === "Adjustments and Refunds Activity"
    || text === "Closed Folio Balances"
    || text === "Daily Report"
    || text === "Daily Audit Packet"
    || text === "Room & Tax Listing"
    || text === "Daily Transaction Log"
    || text === "Credit Card Transactions"
    || text === "Operator Transactions"
    || text === "Advance Deposit Activity"
    || text === "Booked Reservations"
    || text === "Direct Bill Aging"
    || text === "Direct Bill Ledger Details"
    || text === "Final Audit"
    || text === "High Balance Report"
    || text === "Hotel Statistics"
    || text === "In House Guest Folio Balances"
    || text === "Maintenance Summary"
    || text === "Rate Report"
    || text === "Trial Balance Report"
    || text === "Authorized Payments Report"
    || text === "Breakfast And Packages"
    || text === "Departures List"
    || text === "House Account Folio Balances"
    || text === "Maintenance Activity"
    || text === "No Show & Late Cancel"
    || text === "Room Count Summary"
    || text === "Occupancy Forecast"
    || text === "Rate Override"
    || text === "Tax Report";
}

function isNonPropertyHeader(text: string): boolean {
  return /^\d{2}-\d{2}-\d{2}$/.test(text)
    || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(text)
    || /^\d{2}:\d{2}$/.test(text)
    || /^Page \d+ of \d+/.test(text)
    || /^Page\d+\s*\/\s*\d+$/i.test(text)
    || /^Page\s+\d+\s*\/\s*\d+$/i.test(text)
    || text === "History and Forecast"
    || text === "Manager - Flash Last Day"
    || text === "Reservations - made Yesterday"
    || text === "Zero Rate Rooms"
    || text === "AR Detailed Aging"
    || text === "Rate Change Report"
    || text === "A/R Aging"
    || text === "All Transactions"
    || text === "Adjustments and Refunds Activity"
    || text === "Closed Folio Balances"
    || text === "Daily Report"
    || text === "Daily Audit Packet"
    || text === "Room & Tax Listing"
    || text === "Daily Transaction Log"
    || text === "Credit Card Transactions"
    || text === "Operator Transactions"
    || text === "Advance Deposit Activity"
    || text === "Booked Reservations"
    || text === "Direct Bill Aging"
    || text === "Direct Bill Ledger Details"
    || text === "Final Audit"
    || text === "High Balance Report"
    || text === "Hotel Statistics"
    || text === "In House Guest Folio Balances"
    || text === "Maintenance Summary"
    || text === "Rate Report"
    || text === "Trial Balance Report"
    || text === "Authorized Payments Report"
    || text === "Breakfast And Packages"
    || text === "Departures List"
    || text === "House Account Folio Balances"
    || text === "Maintenance Activity"
    || text === "No Show & Late Cancel"
    || text === "Room Count Summary"
    || text === "Occupancy Forecast"
    || text === "Rate Override"
    || text === "Tax Report";
}

function shouldSkipVisibleTitleLine(text: string): boolean {
  return /^User:/i.test(text)
    || /^Report run date:/i.test(text)
    || /^Report run time:/i.test(text)
    || /^\?{3}\s+Date(?: Range)?:/i.test(text)
    || /^[A-Z0-9]{2,}\s+Report run date:/i.test(text)
    || /^[A-Z0-9]{2,}\s+Report run time:/i.test(text)
    || /^Page \d+ of \d+/.test(text)
    || /^Page\d+\s*\/\s*\d+$/i.test(text)
    || /^Page\s+\d+\s*\/\s*\d+$/i.test(text);
}

function isFooterNoise(text: string): boolean {
  return /^Filter\b/.test(text) || /^Sort Order\b/.test(text) || /^Resv\. Status\b/.test(text) || /^Page \d+ of \d+/.test(text);
}

function joinNote(existing: string | null | undefined, addition: string): string {
  const trimmed = addition.trim();
  if (!existing) {
    return trimmed;
  }
  return `${existing} | ${trimmed}`;
}

function joinTextParts(parts: Array<string | null | undefined>): string | null {
  const normalized = parts
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part));

  if (normalized.length === 0) {
    return null;
  }

  return normalizeText(normalized.join(" "));
}

function joinCompactText(parts: Array<string | null | undefined>): string | null {
  const normalized = parts
    .map((part) => normalizeText(part))
    .filter((part): part is string => Boolean(part));

  if (normalized.length === 0) {
    return null;
  }

  return normalized.join("");
}

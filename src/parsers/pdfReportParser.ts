import { extractPdfText, type PdfDocumentText, type PdfLine } from "../pdf/PdfTextExtractor.js";
import { parseShortDate } from "../utils/dates.js";
import type { ParsedReport, ReportType } from "../types.js";
import { REPORT_TITLES } from "../reports.js";
import { normalizePropertyName, slugifyPropertyName } from "../utils/properties.js";

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

    try {
      return {
        propertyName,
        propertySlug,
        reportDate,
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
    default:
      throw new UnsupportedReportError(`Unsupported report type: ${String(reportType)}`);
  }
}

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

  throw new UnsupportedReportError("The PDF title does not match any known report family.");
}

function extractReportDate(document: PdfDocumentText): string | null {
  for (const line of document.lines.slice(0, 6)) {
    const match = line.text.match(/\b\d{2}-\d{2}-\d{2}\b/);
    if (match) {
      return parseShortDate(match[0]);
    }
  }

  return null;
}

function extractPropertyName(document: PdfDocumentText): string | null {
  const candidates = document.lines
    .filter((line) => line.pageNumber === 1)
    .slice(0, 8)
    .map((line) => line.text);

  for (const line of candidates) {
    const stripped = line
      .replace(/\s+\d{2}-\d{2}-\d{2}$/, "")
      .replace(/\s+\d{2}:\d{2}$/, "")
      .trim();
    if (!stripped || isNonPropertyHeader(stripped)) {
      continue;
    }
    if (/\bHotel\b/i.test(stripped) || /\bInn\b/i.test(stripped) || /\bSuites\b/i.test(stripped) || /\bResort\b/i.test(stripped)) {
      return normalizePropertyName(stripped);
    }
  }

  return null;
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

function sliceText(line: PdfLine, minX: number, maxX: number): string {
  const items = line.items.filter((item) => {
    const center = item.x + item.width / 2;
    return center >= minX && center < maxX;
  });
  return items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
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

function shouldSkipCommonLine(text: string): boolean {
  return text.startsWith("Red Lion Hotel")
    || /^\d{2}-\d{2}-\d{2}$/.test(text)
    || /^\d{2}:\d{2}$/.test(text)
    || /^Page \d+ of \d+/.test(text)
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
    || text === "Rate Change Report";
}

function isNonPropertyHeader(text: string): boolean {
  return /^\d{2}-\d{2}-\d{2}$/.test(text)
    || /^\d{2}:\d{2}$/.test(text)
    || /^Page \d+ of \d+/.test(text)
    || text === "History and Forecast"
    || text === "Manager - Flash Last Day"
    || text === "Reservations - made Yesterday"
    || text === "Zero Rate Rooms"
    || text === "AR Detailed Aging"
    || text === "Rate Change Report";
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

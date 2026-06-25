import XLSX from "xlsx";
import { REPORT_TITLES } from "../reports.js";
import { parseLongDate, parseShortDate } from "../utils/dates.js";
import { normalizeDetectedPropertyName, normalizePropertyName, slugifyPropertyName } from "../utils/properties.js";
import { UnsupportedReportError } from "./pdfReportParser.js";
const WORKBOOK_REPORT_TYPES = new Map([
    ["adjustments and refunds activity", "adjustment_refund_activity_rows"],
    ["all transactions", "all_transaction_rows"],
    ["tax report", "tax_report_rows"],
    ["advance deposit activity", "advance_deposit_activity_rows"],
    ["in house guest folio balances", "in_house_guest_folio_balance_rows"]
]);
const ADJUSTMENT_SECTIONS = new Set([
    "Adjustments",
    "Manager Charge Adjustments",
    "Refunds",
    "Manager Refund",
    "Adjustment Summary",
    "Refund Summary"
]);
const ALL_TRANSACTION_SECTIONS = new Set([
    "Reservations",
    "Groups",
    "House Accounts",
    "Settlement Payments",
    "Summary All Sections"
]);
const TAX_SECTIONS = new Set([
    "Summary",
    "Exempted Tax Details",
    "Non Exempted Tax Details",
    "Revenue Reconciliation"
]);
const ADVANCE_DEPOSIT_SECTIONS = new Set([
    "Reservations",
    "Groups",
    "House Accounts",
    "Net Totals",
    "Balances",
    "Payment Types Summary"
]);
const IN_HOUSE_SECTIONS = new Set([
    "Reservations",
    "Groups",
    "Net Totals",
    "Balances"
]);
export class WorkbookReportParser {
    async parse(bytes) {
        const analysis = await this.analyze(bytes);
        if (analysis.parsedReport) {
            return analysis.parsedReport;
        }
        throw analysis.error ?? new UnsupportedReportError("The workbook title does not match any known report family.");
    }
    async analyze(bytes) {
        const rows = extractWorkbookRows(bytes);
        const propertyName = extractWorkbookPropertyName(rows);
        const propertySlug = slugifyPropertyName(propertyName);
        const reportDate = extractWorkbookReportDate(rows);
        const reportTitle = extractWorkbookReportTitle(rows);
        try {
            return {
                propertyName,
                propertySlug,
                reportDate,
                reportTitle,
                parsedReport: buildParsedWorkbookReport(rows, propertyName, propertySlug, reportDate),
                error: null
            };
        }
        catch (error) {
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
function extractWorkbookRows(bytes) {
    const workbook = XLSX.read(bytes, { type: "buffer", cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
        throw new UnsupportedReportError("Workbook does not contain a readable worksheet.");
    }
    const worksheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        raw: false,
        blankrows: false,
        defval: null
    });
    return rawRows.map((row) => row.map(normalizeCellValue));
}
function buildParsedWorkbookReport(rows, propertyName, propertySlug, reportDate) {
    const reportType = detectWorkbookReportType(rows);
    switch (reportType) {
        case "adjustment_refund_activity_rows":
            return {
                reportType,
                reportTitle: REPORT_TITLES[reportType],
                reportDate,
                propertyName,
                propertySlug,
                rows: parseAdjustmentWorkbook(rows)
            };
        case "all_transaction_rows":
            return {
                reportType,
                reportTitle: REPORT_TITLES[reportType],
                reportDate,
                propertyName,
                propertySlug,
                rows: parseAllTransactionsWorkbook(rows)
            };
        case "tax_report_rows":
            return {
                reportType,
                reportTitle: REPORT_TITLES[reportType],
                reportDate,
                propertyName,
                propertySlug,
                rows: parseTaxWorkbook(rows)
            };
        case "advance_deposit_activity_rows":
            return {
                reportType,
                reportTitle: REPORT_TITLES[reportType],
                reportDate,
                propertyName,
                propertySlug,
                rows: parseAdvanceDepositWorkbook(rows)
            };
        case "in_house_guest_folio_balance_rows":
            return {
                reportType,
                reportTitle: REPORT_TITLES[reportType],
                reportDate,
                propertyName,
                propertySlug,
                rows: parseInHouseWorkbook(rows)
            };
        default:
            throw new UnsupportedReportError("The workbook title does not match any known report family.");
    }
}
function detectWorkbookReportType(rows) {
    const title = extractWorkbookReportTitle(rows);
    if (!title) {
        throw new UnsupportedReportError("The workbook title does not match any known report family.");
    }
    const reportType = WORKBOOK_REPORT_TYPES.get(title.toLowerCase());
    if (!reportType) {
        throw new UnsupportedReportError("The workbook title does not match any known report family.");
    }
    return reportType;
}
function extractWorkbookPropertyName(rows) {
    return normalizeDetectedPropertyName(cell(rows[0], 0), cell(rows[1], 0));
}
function extractWorkbookReportTitle(rows) {
    for (const row of rows.slice(0, 12)) {
        const value = normalizePropertyName(cell(row, 0));
        if (value && WORKBOOK_REPORT_TYPES.has(value.toLowerCase())) {
            return value;
        }
    }
    return null;
}
function extractWorkbookReportDate(rows) {
    for (const row of rows.slice(0, 6)) {
        for (const value of row) {
            if (!value) {
                continue;
            }
            const dateRangeMatch = value.match(/^Date Range:\s*(.+?)\s*-\s*(.+)$/i);
            if (dateRangeMatch) {
                return parseLongDate(dateRangeMatch[2]) ?? parseLongDate(dateRangeMatch[1]);
            }
            const dateMatch = value.match(/^Date:\s*(.+)$/i);
            if (dateMatch) {
                return parseLongDate(dateMatch[1]) ?? parseShortDate(dateMatch[1]);
            }
        }
    }
    return null;
}
function parseAdjustmentWorkbook(rows) {
    const parsed = [];
    let section = null;
    for (const row of rows) {
        const label = firstNonEmptyCell(row);
        if (label === "END OF REPORT") {
            break;
        }
        if (label && ADJUSTMENT_SECTIONS.has(label)) {
            section = label;
            continue;
        }
        if (!section || isAdjustmentHeaderRow(row, section)) {
            continue;
        }
        if (isNumericCell(cell(row, 0))) {
            if (section === "Adjustment Summary") {
                parsed.push({
                    section,
                    row_kind: "summary",
                    transaction_date: null,
                    transaction_time: null,
                    transaction_scope: cell(row, 1),
                    charge_type: cell(row, 1) === "Charge Type And User" ? cell(row, 2) : null,
                    subject_name: null,
                    transaction_number: null,
                    room_number: null,
                    reason_code: cell(row, 1) === "Reason Code" ? cell(row, 2) : null,
                    adjusted_amount: normalizeCurrencyAmount(cell(row, 4)),
                    adjusted_tax: normalizeCurrencyAmount(cell(row, 5)),
                    transferred_charge: normalizeCurrencyAmount(cell(row, 6)),
                    transferred_tax: normalizeCurrencyAmount(cell(row, 7)),
                    username: cell(row, 3),
                    remarks: null,
                    note: null
                });
                continue;
            }
            if (section === "Refund Summary") {
                parsed.push({
                    section,
                    row_kind: "summary",
                    transaction_date: null,
                    transaction_time: null,
                    transaction_scope: cell(row, 1),
                    charge_type: cell(row, 1) === "Payment Type" ? cell(row, 2) : null,
                    subject_name: null,
                    transaction_number: null,
                    room_number: null,
                    reason_code: cell(row, 1) === "Reason Code" ? cell(row, 2) : null,
                    adjusted_amount: normalizeCurrencyAmount(cell(row, 3)),
                    adjusted_tax: null,
                    transferred_charge: null,
                    transferred_tax: null,
                    username: null,
                    remarks: null,
                    note: null
                });
                continue;
            }
            if (section === "Refunds" || section === "Manager Refund") {
                parsed.push({
                    section,
                    row_kind: "detail",
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    transaction_scope: cell(row, 3),
                    charge_type: cell(row, 7),
                    subject_name: cell(row, 4),
                    transaction_number: cell(row, 5),
                    room_number: cell(row, 6),
                    reason_code: cell(row, 8),
                    adjusted_amount: normalizeCurrencyAmount(cell(row, 10)),
                    adjusted_tax: null,
                    transferred_charge: null,
                    transferred_tax: null,
                    username: cell(row, 11),
                    remarks: cell(row, 12),
                    note: buildNote([
                        ["payment_type_refunded", cell(row, 9)]
                    ])
                });
                continue;
            }
            const hasReasonCode = section === "Adjustments";
            parsed.push({
                section,
                row_kind: "detail",
                transaction_date: parseWorkbookDate(cell(row, 1)),
                transaction_time: normalizePropertyName(cell(row, 2)),
                transaction_scope: cell(row, 3),
                charge_type: cell(row, 4),
                subject_name: cell(row, 5),
                transaction_number: cell(row, 6),
                room_number: cell(row, 7),
                reason_code: hasReasonCode ? cell(row, 8) : null,
                adjusted_amount: normalizeCurrencyAmount(cell(row, hasReasonCode ? 9 : 8)),
                adjusted_tax: normalizeCurrencyAmount(cell(row, hasReasonCode ? 10 : 9)),
                transferred_charge: hasReasonCode ? normalizeCurrencyAmount(cell(row, 11)) : null,
                transferred_tax: hasReasonCode ? normalizeCurrencyAmount(cell(row, 12)) : null,
                username: cell(row, hasReasonCode ? 13 : 10),
                remarks: cell(row, hasReasonCode ? 14 : 11),
                note: null
            });
            continue;
        }
        if (!hasAnyCurrencyCells(row)) {
            continue;
        }
        if (section === "Refunds" || section === "Manager Refund") {
            parsed.push({
                section,
                row_kind: "total",
                transaction_date: null,
                transaction_time: null,
                transaction_scope: "Totals",
                charge_type: null,
                subject_name: null,
                transaction_number: null,
                room_number: null,
                reason_code: null,
                adjusted_amount: normalizeCurrencyAmount(cell(row, 10)),
                adjusted_tax: null,
                transferred_charge: null,
                transferred_tax: null,
                username: null,
                remarks: null,
                note: null
            });
            continue;
        }
        if (section === "Adjustments" || section === "Manager Charge Adjustments") {
            const hasReasonCode = section === "Adjustments";
            parsed.push({
                section,
                row_kind: "total",
                transaction_date: null,
                transaction_time: null,
                transaction_scope: "Totals",
                charge_type: null,
                subject_name: null,
                transaction_number: null,
                room_number: null,
                reason_code: null,
                adjusted_amount: normalizeCurrencyAmount(cell(row, hasReasonCode ? 9 : 8)),
                adjusted_tax: normalizeCurrencyAmount(cell(row, hasReasonCode ? 10 : 9)),
                transferred_charge: hasReasonCode ? normalizeCurrencyAmount(cell(row, 11)) : null,
                transferred_tax: hasReasonCode ? normalizeCurrencyAmount(cell(row, 12)) : null,
                username: null,
                remarks: null,
                note: null
            });
        }
    }
    return parsed;
}
function parseAllTransactionsWorkbook(rows) {
    const parsed = [];
    let section = null;
    for (const row of rows) {
        const label = firstNonEmptyCell(row);
        if (label === "END OF REPORT") {
            break;
        }
        if (label && ALL_TRANSACTION_SECTIONS.has(label)) {
            section = label;
            continue;
        }
        if (!section || isAllTransactionsHeaderRow(row)) {
            continue;
        }
        if (!isNumericCell(cell(row, 0))) {
            continue;
        }
        switch (section) {
            case "Reservations":
                parsed.push({
                    section,
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    confirmation_no: cell(row, 3),
                    guest_name: cell(row, 4),
                    room_number: cell(row, 5),
                    folio_number: cell(row, 6),
                    transaction_code: cell(row, 7),
                    transaction_description: cell(row, 8),
                    last_four_digits: cell(row, 9),
                    transaction_type: cell(row, 10),
                    charge_type: cell(row, 11),
                    amount: normalizeCurrencyAmount(cell(row, 14)),
                    username: cell(row, 15),
                    note: buildNote([
                        ["remarks", cell(row, 16)],
                        ["charge_remarks", cell(row, 17)],
                        ["transferred_transactions", cell(row, 18)],
                        ["pos_check_number", cell(row, 19)],
                        ["company_name", cell(row, 23)],
                        ["refund_reason", cell(row, 24)]
                    ])
                });
                break;
            case "Groups":
                parsed.push({
                    section,
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    confirmation_no: cell(row, 3),
                    guest_name: cell(row, 5),
                    room_number: null,
                    folio_number: cell(row, 6),
                    transaction_code: cell(row, 7),
                    transaction_description: cell(row, 8),
                    last_four_digits: cell(row, 9),
                    transaction_type: cell(row, 10),
                    charge_type: cell(row, 11),
                    amount: normalizeCurrencyAmount(cell(row, 14)),
                    username: cell(row, 15),
                    note: buildNote([
                        ["rate_plan", cell(row, 4)],
                        ["remarks", cell(row, 16)],
                        ["charge_remarks", cell(row, 17)],
                        ["transferred_transactions", cell(row, 18)],
                        ["pos_check_number", cell(row, 19)],
                        ["company_name", cell(row, 20)],
                        ["refund_reason", cell(row, 24)]
                    ])
                });
                break;
            case "House Accounts":
                parsed.push({
                    section,
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    confirmation_no: cell(row, 3),
                    guest_name: cell(row, 4),
                    room_number: null,
                    folio_number: cell(row, 6),
                    transaction_code: cell(row, 7),
                    transaction_description: cell(row, 8),
                    last_four_digits: cell(row, 9),
                    transaction_type: cell(row, 10),
                    charge_type: cell(row, 11),
                    amount: normalizeCurrencyAmount(cell(row, 14)),
                    username: cell(row, 15),
                    note: buildNote([
                        ["account_type", cell(row, 5)],
                        ["remarks", cell(row, 16)],
                        ["charge_remarks", cell(row, 17)],
                        ["transferred_transactions", cell(row, 18)],
                        ["pos_check_number", cell(row, 19)],
                        ["refund_reason", cell(row, 24)]
                    ])
                });
                break;
            case "Settlement Payments":
                parsed.push({
                    section,
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    confirmation_no: cell(row, 3),
                    guest_name: cell(row, 4),
                    room_number: null,
                    folio_number: null,
                    transaction_code: cell(row, 5),
                    transaction_description: cell(row, 6),
                    last_four_digits: cell(row, 7),
                    transaction_type: cell(row, 8),
                    charge_type: null,
                    amount: normalizeCurrencyAmount(cell(row, 9)),
                    username: cell(row, 10),
                    note: buildNote([
                        ["remarks", cell(row, 11)],
                        ["refund_reason", cell(row, 12)]
                    ])
                });
                break;
            case "Summary All Sections":
                parsed.push({
                    section,
                    transaction_date: parseWorkbookDate(cell(row, 1)),
                    transaction_time: normalizePropertyName(cell(row, 2)),
                    confirmation_no: firstPopulatedValue([cell(row, 3), cell(row, 6), cell(row, 9)]),
                    guest_name: firstPopulatedValue([cell(row, 4), cell(row, 8), cell(row, 10), cell(row, 29)]),
                    room_number: cell(row, 5),
                    folio_number: cell(row, 12),
                    transaction_code: cell(row, 13),
                    transaction_description: cell(row, 14),
                    last_four_digits: cell(row, 15),
                    transaction_type: cell(row, 16),
                    charge_type: cell(row, 17),
                    amount: normalizeCurrencyAmount(cell(row, 20)),
                    username: cell(row, 21),
                    note: buildNote([
                        ["rate_plan", cell(row, 7)],
                        ["account_type", cell(row, 11)],
                        ["remarks", cell(row, 22)],
                        ["charge_remarks", cell(row, 23)],
                        ["transferred_transactions", cell(row, 24)],
                        ["pos_check_number", cell(row, 25)],
                        ["tax_invoice_number", cell(row, 26)],
                        ["fiscal_invoice_number", cell(row, 27)],
                        ["external_bill_number", cell(row, 28)],
                        ["refund_reason", cell(row, 30)]
                    ])
                });
                break;
            default:
                break;
        }
    }
    return parsed;
}
function parseTaxWorkbook(rows) {
    const parsed = [];
    let section = null;
    for (const row of rows) {
        const label = firstNonEmptyCell(row);
        if (label === "END OF REPORT") {
            break;
        }
        if (label && TAX_SECTIONS.has(label)) {
            section = label;
            continue;
        }
        if (!section || section === "Revenue Reconciliation" || isTaxHeaderRow(row)) {
            continue;
        }
        if (section === "Summary") {
            if (isNumericCell(cell(row, 0))) {
                parsed.push({
                    section,
                    tax_name: cell(row, 1),
                    total_revenue: normalizeCurrencyAmount(cell(row, 2)),
                    exempted_revenue: normalizeCurrencyAmount(cell(row, 3)),
                    taxable_payable: normalizeCurrencyAmount(cell(row, 4)),
                    payable_tax: normalizeCurrencyAmount(cell(row, 5)),
                    exempted_tax: normalizeCurrencyAmount(cell(row, 6)),
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
            if (hasAnyCurrencyCells(row)) {
                parsed.push({
                    section,
                    tax_name: "Totals",
                    total_revenue: null,
                    exempted_revenue: null,
                    taxable_payable: null,
                    payable_tax: normalizeCurrencyAmount(cell(row, 5)),
                    exempted_tax: normalizeCurrencyAmount(cell(row, 6)),
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
            }
            continue;
        }
        if (!isNumericCell(cell(row, 0))) {
            continue;
        }
        const exempted = section === "Exempted Tax Details";
        parsed.push({
            section,
            tax_name: null,
            total_revenue: null,
            exempted_revenue: null,
            taxable_payable: null,
            payable_tax: null,
            exempted_tax: null,
            transaction_number: cell(row, 1),
            folio_number: cell(row, 2),
            transaction_type: cell(row, 3),
            room_number: cell(row, 4),
            guest_name: cell(row, 5),
            company_name: cell(row, 6),
            check_in_date: parseWorkbookDate(cell(row, exempted ? 13 : 12)),
            check_out_date: parseWorkbookDate(cell(row, exempted ? 14 : 13)),
            exemption_category: exempted ? cell(row, 12) : null,
            revenue: normalizeCurrencyAmount(cell(row, exempted ? 15 : 14))
        });
    }
    return parsed;
}
function parseAdvanceDepositWorkbook(rows) {
    const parsed = [];
    let section = null;
    for (const row of rows) {
        const label = firstNonEmptyCell(row);
        if (label === "END OF REPORT") {
            break;
        }
        if (label && ADVANCE_DEPOSIT_SECTIONS.has(label)) {
            section = label;
            continue;
        }
        if (!section || section === "Net Totals" || section === "Balances" || section === "Payment Types Summary" || isAdvanceHeaderRow(row)) {
            continue;
        }
        if (!isNumericCell(cell(row, 0))) {
            continue;
        }
        switch (section) {
            case "Reservations":
                parsed.push({
                    confirmation_no: cell(row, 1),
                    guest_name: cell(row, 2),
                    check_in_date: parseWorkbookDate(cell(row, 6)),
                    rate_plan_name: cell(row, 9),
                    payment_method: cell(row, 10),
                    due_date: parseWorkbookDate(cell(row, 12)),
                    deposit_posted: normalizeCurrencyAmount(cell(row, 15))
                });
                break;
            case "Groups":
                parsed.push({
                    confirmation_no: cell(row, 1),
                    guest_name: firstPopulatedValue([cell(row, 2), cell(row, 5)]),
                    check_in_date: parseWorkbookDate(cell(row, 6)),
                    rate_plan_name: cell(row, 9),
                    payment_method: cell(row, 10),
                    due_date: parseWorkbookDate(cell(row, 12)),
                    deposit_posted: normalizeCurrencyAmount(cell(row, 15))
                });
                break;
            case "House Accounts":
                parsed.push({
                    confirmation_no: cell(row, 1),
                    guest_name: firstPopulatedValue([cell(row, 2), cell(row, 3)]),
                    check_in_date: parseWorkbookDate(cell(row, 4)),
                    rate_plan_name: null,
                    payment_method: null,
                    due_date: null,
                    deposit_posted: normalizeCurrencyAmount(cell(row, 8))
                });
                break;
            default:
                break;
        }
    }
    return parsed;
}
function parseInHouseWorkbook(rows) {
    const parsed = [];
    let section = null;
    for (const row of rows) {
        const label = firstNonEmptyCell(row);
        if (label === "END OF REPORT") {
            break;
        }
        if (label && IN_HOUSE_SECTIONS.has(label)) {
            section = label;
            continue;
        }
        if (!section || isInHouseHeaderRow(row, section)) {
            continue;
        }
        if (section === "Net Totals") {
            if (!isNumericCell(cell(row, 0))) {
                continue;
            }
            parsed.push({
                section,
                row_kind: "summary",
                summary_label: cell(row, 1),
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
                todays_charges: normalizeCurrencyAmount(cell(row, 2)),
                todays_payments: normalizeCurrencyAmount(cell(row, 3)),
                opening_balance: normalizeCurrencyAmount(cell(row, 4)),
                net_change: normalizeCurrencyAmount(cell(row, 5)),
                ending_balance: normalizeCurrencyAmount(cell(row, 6)),
                metric_value: null,
                note: null
            });
            continue;
        }
        if (section === "Balances") {
            if (!isNumericCell(cell(row, 0))) {
                continue;
            }
            parsed.push({
                section,
                row_kind: "metric",
                summary_label: cell(row, 1),
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
                metric_value: normalizeCurrencyAmount(cell(row, 2)),
                note: null
            });
            continue;
        }
        if (isNumericCell(cell(row, 0))) {
            if (section === "Reservations") {
                parsed.push({
                    section,
                    row_kind: "detail",
                    summary_label: null,
                    confirmation_no: cell(row, 1),
                    group_code: cell(row, 2),
                    room_number: cell(row, 3),
                    guest_name: cell(row, 4),
                    additional_guests: cell(row, 5),
                    company_name: cell(row, 6),
                    check_in_date: parseWorkbookDate(cell(row, 7)),
                    check_out_date: parseWorkbookDate(cell(row, 8)),
                    rate_plan: cell(row, 9),
                    payment_method: cell(row, 10),
                    reservation_status: cell(row, 11),
                    todays_charges: normalizeCurrencyAmount(cell(row, 12)),
                    todays_payments: normalizeCurrencyAmount(cell(row, 13)),
                    opening_balance: normalizeCurrencyAmount(cell(row, 14)),
                    net_change: normalizeCurrencyAmount(cell(row, 15)),
                    ending_balance: normalizeCurrencyAmount(cell(row, 16)),
                    metric_value: null,
                    note: null
                });
                continue;
            }
            if (section === "Groups") {
                parsed.push({
                    section,
                    row_kind: "detail",
                    summary_label: null,
                    confirmation_no: cell(row, 1),
                    group_code: cell(row, 2),
                    room_number: null,
                    guest_name: cell(row, 3),
                    additional_guests: null,
                    company_name: cell(row, 5),
                    check_in_date: parseWorkbookDate(cell(row, 6)),
                    check_out_date: parseWorkbookDate(cell(row, 7)),
                    rate_plan: cell(row, 8),
                    payment_method: cell(row, 9),
                    reservation_status: null,
                    todays_charges: normalizeCurrencyAmount(cell(row, 10)),
                    todays_payments: normalizeCurrencyAmount(cell(row, 11)),
                    opening_balance: normalizeCurrencyAmount(cell(row, 12)),
                    net_change: normalizeCurrencyAmount(cell(row, 13)),
                    ending_balance: normalizeCurrencyAmount(cell(row, 14)),
                    metric_value: null,
                    note: buildNote([
                        ["group_contact_name", cell(row, 4)]
                    ])
                });
            }
            continue;
        }
        if (section === "Reservations" && hasAnyCurrencyCells(row)) {
            parsed.push({
                section,
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
                todays_charges: normalizeCurrencyAmount(cell(row, 12)),
                todays_payments: normalizeCurrencyAmount(cell(row, 13)),
                opening_balance: normalizeCurrencyAmount(cell(row, 14)),
                net_change: normalizeCurrencyAmount(cell(row, 15)),
                ending_balance: normalizeCurrencyAmount(cell(row, 16)),
                metric_value: null,
                note: null
            });
            continue;
        }
        if (section === "Groups" && hasAnyCurrencyCells(row)) {
            parsed.push({
                section,
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
                todays_charges: normalizeCurrencyAmount(cell(row, 10)),
                todays_payments: normalizeCurrencyAmount(cell(row, 11)),
                opening_balance: normalizeCurrencyAmount(cell(row, 12)),
                net_change: normalizeCurrencyAmount(cell(row, 13)),
                ending_balance: normalizeCurrencyAmount(cell(row, 14)),
                metric_value: null,
                note: null
            });
        }
    }
    return parsed;
}
function isAdjustmentHeaderRow(row, section) {
    const first = cell(row, 1);
    if (!first) {
        return false;
    }
    if (section === "Adjustment Summary") {
        return first === "Type";
    }
    if (section === "Refund Summary") {
        return first === "Type";
    }
    return first === "Date";
}
function isAllTransactionsHeaderRow(row) {
    const first = cell(row, 1);
    return first === "Date";
}
function isTaxHeaderRow(row) {
    const first = cell(row, 1);
    return first === "Tax Name" || first === "Transaction Number" || first === "Charge Type Code";
}
function isAdvanceHeaderRow(row) {
    const first = cell(row, 1);
    return first === "Confirmation Number"
        || first === "Group Number"
        || first === "House Account Code"
        || first === "Balances"
        || first === "Payment Type";
}
function isInHouseHeaderRow(row, section) {
    const first = cell(row, 1);
    if (!first) {
        return false;
    }
    if (section === "Net Totals") {
        return first === "Today's Charges";
    }
    return first === "Confirmation Number" || first === "Group Number";
}
function normalizeCellValue(value) {
    if (value === null || typeof value === "undefined") {
        return null;
    }
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
}
function cell(row, index) {
    return row?.[index] ?? null;
}
function firstNonEmptyCell(row) {
    for (const value of row) {
        if (value) {
            return value;
        }
    }
    return null;
}
function hasAnyCurrencyCells(row) {
    return row.some((value) => Boolean(normalizeCurrencyAmount(value)));
}
function parseWorkbookDate(value) {
    return parseShortDate(value) ?? parseLongDate(value);
}
function firstPopulatedValue(values) {
    return values.find((value) => Boolean(value)) ?? null;
}
function isNumericCell(value) {
    return Boolean(value && /^\d+$/.test(value));
}
function buildNote(entries) {
    const parts = entries
        .filter(([, value]) => Boolean(value))
        .map(([label, value]) => `${label}=${value}`);
    return parts.length > 0 ? parts.join("; ") : null;
}
function normalizeCurrencyAmount(value) {
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

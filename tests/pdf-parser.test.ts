import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PdfDocumentText, PdfLine, PdfWord } from "../src/pdf/PdfTextExtractor.js";
import {
  PdfReportParser,
  UnsupportedReportError,
  parseAdvanceDepositActivityDocument,
  parseChoiceAuditPacketDocument
} from "../src/parsers/pdfReportParser.js";
import { normalizeDetectedPropertyName } from "../src/utils/properties.js";
import { parseLongDate, parseShortDate } from "../src/utils/dates.js";

const parser = new PdfReportParser();
const expectations = JSON.parse(
  await readFile(path.resolve("tests", "fixtures", "parser-expectations.json"), "utf8")
) as Record<string, {
  reportType: string;
  rowCount: number;
  firstRow: Record<string, string>;
}>;

test("sample PDFs parse into expected report types and row counts", async () => {
  for (const [fileName, expected] of Object.entries(expectations)) {
    const bytes = await readFile(path.resolve("ExampleData", fileName));
    const parsed = await parser.parse(bytes);

    assert.equal(parsed.reportType, expected.reportType, `${fileName} reportType`);
    assert.equal(parsed.rows.length, expected.rowCount, `${fileName} rowCount`);
    assert.deepEqual(parsed.rows[0], { ...parsed.rows[0], ...expected.firstRow }, `${fileName} first row partial match`);
  }
});

test("known continuation lines are folded into reservation notes", async () => {
  const bytes = await readFile(path.resolve("ExampleData", "Reservations Made Yesterday.PDF"));
  const parsed = await parser.parse(bytes);
  assert.equal(parsed.reportType, "reservations_made_yesterday_rows");
  assert.equal(parsed.propertySlug, "red-lion-hotel-pasco-airport-and-conference-center");
  assert.equal(parsed.propertyName, "Red Lion Hotel Pasco Airport & Conference Center");

  const target = parsed.rows.find((row) => row.guest_name === "bilardello,david");
  assert.ok(target);
  assert.match(String(target.company_group_note), /Sonesta Travel Pass/i);
  assert.match(String(target.company_group_note), /Member Rate/i);
});

test("unsupported but valid PDFs are rejected explicitly", async () => {
  const bytes = createMinimalPdf("Unknown Report");
  await assert.rejects(() => parser.parse(bytes), UnsupportedReportError);
});

test("analysis still surfaces property metadata for unsupported PDFs", async () => {
  const bytes = createMinimalPdf("Red Lion Hotel Pasco Airport & Conference Center 05-19-26");
  const analysis = await parser.analyze(bytes);
  assert.equal(analysis.propertyName, "Red Lion Hotel Pasco Airport & Conference Center");
  assert.equal(analysis.propertySlug, "red-lion-hotel-pasco-airport-and-conference-center");
  assert.equal(analysis.parsedReport, null);
  assert.ok(analysis.error instanceof UnsupportedReportError);
});

test("detected property names strip trailing report context", () => {
  assert.equal(
    normalizeDetectedPropertyName("Hampton Inn and Suites by Hilton - La Grande, OR Date Range: May 19, 2026 - Jun 18, 2026"),
    "Hampton Inn and Suites by Hilton - La Grande, OR"
  );
  assert.equal(
    normalizeDetectedPropertyName("Hampton Inn and Suites by Hilton - La Grande, OR Current Business Day: May 19, 2026"),
    "Hampton Inn and Suites by Hilton - La Grande, OR"
  );
});

test("detected property names can recover a wrapped state code", () => {
  assert.equal(
    normalizeDetectedPropertyName(
      "Hampton Inn and Suites by Hilton - La Grande, Date: May 18, 2026",
      "OR Report run date: May 19, 2026"
    ),
    "Hampton Inn and Suites by Hilton - La Grande, OR"
  );
});

test("long-form month dates normalize to ISO", () => {
  assert.equal(parseLongDate("May 18, 2026"), "2026-05-18");
});

test("named short dates normalize to ISO", () => {
  assert.equal(parseShortDate("18-May-26"), "2026-05-18");
});

test("corrupted PDFs bubble a parsing failure", async () => {
  await assert.rejects(() => parser.parse(Buffer.from("not-a-pdf")));
});

test("choice audit packet pages extract structured fields from wrapped WA184-style lines", () => {
  const document: PdfDocumentText = {
    pageCount: 5,
    lines: [
      makeLine(1, 700, [[37, "A/R Aging"]]),
      makeLine(1, 680, [[37, "Property Name: Comfort Inn & Suites"]]),
      makeLine(1, 660, [[37, "Business Date: 5/26/2026"], [246, "Property Code: WA184"]]),
      makeLine(1, 640, [[37, "Account"], [99, "Name"], [303, "Current"], [367, "30Days"], [427, "60Days"], [488, "90Days"], [543, "120Days"], [610, "Credits"], [667, "Balance"], [736, "Limit"]]),
      makeLine(1, 620, [[37, "543966"], [99, "CHOICE PRIVILEGES"], [301, "1,434.18"], [362, "1,109.46"], [430, "290.64"], [490, "435.96"], [544, "(594.21)"], [605, "(594.21)"], [665, "2,676.03"], [739, "0.00"]]),
      makeLine(1, 600, [[224, "Grand Total:"], [299, "2,050.34"], [359, "1,249.72"], [427, "419.76"], [487, "435.96"], [541, "(633.22)"], [602, "(633.22)"], [662, "3,522.56"], [719, "1,000.00"]]),

      makeLine(2, 700, [[38, "Cancellation List"]]),
      makeLine(2, 680, [[37, "Property Name: Comfort Inn & Suites"]]),
      makeLine(2, 660, [[37, "Business Date: 5/26/2026"], [246, "Property Code: WA184"]]),
      makeLine(2, 640, [[38, "Account"], [101, "Guest Name"], [266, "Arrival"], [345, "Nights"], [379, "Rate Plan"], [439, "GTD"], [468, "Source"], [511, "Rm Type"], [562, "Cxl Code"], [620, "Cxl Date"], [665, "Cxl Clk"]]),
      makeLine(2, 620, [[101, "Company"], [266, "Group"]]),
      makeLine(2, 600, [[38, "1047818555"], [101, "ORTEGA, REYNALDO"], [266, "5/26/26"], [356, "1"], [379, "LWALK1"], [442, "CC"], [468, "DIRECT"], [511, "NQQ"], [562, "CHANGE"], [620, "5/26/26"], [665, "mmccle.wa"]]),
      makeLine(2, 580, [[562, "OF PLANS"], [665, "184"]]),
      makeLine(2, 560, [[581, "Total Cancellations:"], [665, "3"]]),

      makeLine(3, 700, [[38, "Hotel Journal Detail"]]),
      makeLine(3, 680, [[38, "Date Range: 5/26/2026-5/26/2026"], [292, "Property Code: WA184"]]),
      makeLine(3, 660, [[38, "Transaction Code: City / County Tax (T2)"]]),
      makeLine(3, 640, [[38, "Date"], [93, "Posting Date"], [180, "User ID"], [246, "Shift"], [272, "Room"], [308, "Account Type"], [380, "Name"], [507, "Type"], [606, "Amount"], [664, "Adjustment"]]),
      makeLine(3, 620, [[252, "ID"], [308, "Account"], [380, "Comment"]]),
      makeLine(3, 600, [[308, "Shift4 Invoice"]]),
      makeLine(3, 580, [[38, "5/26/26"], [93, "05/26/26 07:38 AM"], [180, "swatso2.wa18"], [254, "1"], [272, "320"], [308, "Guest Account"], [380, "STARR, JAMMIE"], [507, "A"], [619, "0.00"], [685, "(0.78)"]]),
      makeLine(3, 560, [[180, "4"]]),
      makeLine(3, 540, [[308, "1033219342"], [380, "Adjustment"]]),
      makeLine(3, 520, [[479, "Total For City / County Tax (T2):"], [613, "50.78"], [691, "(2.08)"]]),

      makeLine(4, 700, [[37, "Hotel Statistics"]]),
      makeLine(4, 680, [[37, "Property Name: Comfort Inn & Suites"]]),
      makeLine(4, 660, [[38, "Room Statistics"], [222, "5/26/2026"], [318, "PTD"], [353, "Last Year PTD"], [460, "YTD"], [514, "Last YTD"]]),
      makeLine(4, 640, [[38, "Total Rooms"], [251, "76"], [313, "1,976"], [384, "1,976"], [450, "11,096"], [522, "11,096"]]),

      makeLine(5, 700, [[38, "Revenue by Rate Code"]]),
      makeLine(5, 680, [[38, "Business Date: 5/26/2026"], [259, "Property Code: WA184"]]),
      makeLine(5, 660, [[40, "Rate Code"], [132, "Nights"], [184, "%"], [204, "Revenue"], [267, "%"], [295, "AVG"], [330, "Nights"], [383, "%"], [415, "Revenue"], [475, "%"], [492, "PTD AVG"], [541, "Nights"], [593, "%"], [628, "Revenue"], [691, "%"], [721, "AVG"]]),
      makeLine(5, 640, [[40, "SP3BK"], [138, "1"], [176, "4.35"], [211, "117.85"], [258, "5.84"], [288, "117.85"], [333, "22"], [375, "2.70"], [414, "3,238.50"], [466, "3.04"], [494, "147.20"], [553, "47"], [585, "1.32"], [629, "5,877.94"], [683, "1.55"], [713, "125.06"]])
    ]
  };

  const rows = parseChoiceAuditPacketDocument(document);

  const agingRow = rows.find((row) => row.report_name === "A/R Aging" && row.account_number === "543966");
  assert.ok(agingRow);
  assert.equal(agingRow.account_name, "CHOICE PRIVILEGES");
  assert.equal(agingRow.value_7, "2676.03");
  assert.match(String(agingRow.note), /balance_amount/);

  const cancellationRow = rows.find((row) => row.report_name === "Cancellation List" && row.account_number === "1047818555");
  assert.ok(cancellationRow);
  assert.equal(cancellationRow.cancel_code, "CHANGE OF PLANS");
  assert.equal(cancellationRow.cancel_clock, "mmccle.wa184");

  const journalRow = rows.find((row) => row.report_name === "Hotel Journal Detail" && row.reference_id === "1033219342");
  assert.ok(journalRow);
  assert.equal(journalRow.user_id, "swatso2.wa184");
  assert.equal(journalRow.transaction_code, "T2");
  assert.equal(journalRow.guest_name, "STARR, JAMMIE A");
  assert.equal(journalRow.adjustment_amount, "-0.78");
  assert.equal(journalRow.comment, "Adjustment");

  const hotelStatsRow = rows.find((row) => row.report_name === "Hotel Statistics" && row.metric_name === "Total Rooms");
  assert.ok(hotelStatsRow);
  assert.equal(hotelStatsRow.section, "Room Statistics");
  assert.equal(hotelStatsRow.value_4, "11096");

  const rateCodeRow = rows.find((row) => row.report_name === "Revenue by Rate Code" && row.rate_code === "SP3BK");
  assert.ok(rateCodeRow);
  assert.equal(rateCodeRow.value_13, "5877.94");
  assert.match(String(rateCodeRow.note), /ytd_revenue/);
});

test("advance deposit PDFs parse ellensburg-style wrapped rows", () => {
  const document: PdfDocumentText = {
    pageCount: 2,
    lines: [
      makeLine(1, 700, [[301, "Advance Deposit Activity"]]),
      makeLine(1, 660, [[24, "Reservations"]]),
      makeLine(1, 640, [
        [24.3, "Confirmatio"],
        [88.9, "Guest"],
        [133, "First Name"],
        [186.9, "Last Name"],
        [242.3, "Company"],
        [297.4, "Check In"],
        [347.5, "Check Out"],
        [402.7, "Rate Plan"],
        [456.2, "Rate Plan"],
        [508.3, "PAYMENT"],
        [569.8, "Last 4"],
        [617.4, "Due Date"],
        [673.6, "Deposit"],
        [727, "Deposit"],
        [780.5, "Deposit"]
      ]),
      makeLine(1, 628, [
        [28.1, "n Number"],
        [89.3, "Name"],
        [249.7, "Name"],
        [305.4, "Date"],
        [358.8, "Date"],
        [410.9, "Code"],
        [463.5, "Name"],
        [509.2, "METHOD:"],
        [570.2, "Digits"],
        [670.2, "Collected"],
        [723.7, "Collected"],
        [785.4, "Used"]
      ]),
      makeLine(1, 616, [
        [669.6, "Until Date"],
        [729.9, "Today"]
      ]),
      makeLine(1, 590, [
        [28.9, "81460423"],
        [80.6, "JOHNSON"],
        [140.3, "LAURA"],
        [187.6, "JOHNSON"],
        [296, "12-Jun-26"],
        [349.5, "14-Jun-26"],
        [409.6, "IDU00"],
        [460, "TPI 00P"],
        [511.2, "MASTER"],
        [572.4, "9503"],
        [667.6, "USD639.28"],
        [725.5, "USD0.00"],
        [778.9, "USD0.00"]
      ]),
      makeLine(1, 578, [
        [86.9, "LAURA"],
        [465.3, "LOW"]
      ]),
      makeLine(1, 566, [[460.8, "FENCE"]]),
      makeLine(1, 540, [
        [28.9, "61207964"],
        [88, "RAINS"],
        [136.5, "AMANDA"],
        [194.9, "RAINS"],
        [294.9, "31-May-26"],
        [349.5, "01-Jun-26"],
        [409.6, "IDU13"],
        [456.6, "TPI 13.5P"],
        [511.2, "MASTER"],
        [572.4, "0243"],
        [672, "USD0.00"],
        [725.5, "USD0.00"],
        [774.5, "USD171.25"]
      ]),
      makeLine(1, 528, [
        [83.1, "AMANDA"],
        [465.3, "LOW"]
      ]),
      makeLine(1, 516, [[460.8, "FENCE"]]),
      makeLine(2, 700, [
        [24, "Totals"],
        [667.6, "USD6,824.60"],
        [725.5, "USD0.00"],
        [778.9, "USD336.70"]
      ])
    ]
  };

  const rows = parseAdvanceDepositActivityDocument(document);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    confirmation_no: "81460423",
    guest_name: "JOHNSON LAURA",
    check_in_date: "2026-06-12",
    rate_plan_name: "IDU00 TPI 00P LOW FENCE",
    payment_method: "MASTER",
    due_date: null,
    deposit_posted: "0.00"
  });
  assert.deepEqual(rows[1], {
    confirmation_no: "61207964",
    guest_name: "RAINS AMANDA",
    check_in_date: "2026-05-31",
    rate_plan_name: "IDU13 TPI 13.5P LOW FENCE",
    payment_method: "MASTER",
    due_date: null,
    deposit_posted: "171.25"
  });
});

function createMinimalPdf(title: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(`BT\n/F1 18 Tf\n72 72 Td\n(${title}) Tj\nET\n`, "utf8")} >>\nstream\nBT\n/F1 18 Tf\n72 72 Td\n(${title}) Tj\nET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(output, "utf8");
}

function makeLine(pageNumber: number, y: number, specs: Array<[number, string]>): PdfLine {
  const items: PdfWord[] = specs.map(([x, text]) => ({
    text,
    x,
    y,
    width: Math.max(text.length * 5, 8),
    height: 10
  }));

  return {
    pageNumber,
    y,
    items,
    text: specs.map(([, text]) => text).join(" ")
  };
}

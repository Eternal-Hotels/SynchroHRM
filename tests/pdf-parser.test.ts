import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PdfReportParser, UnsupportedReportError } from "../src/parsers/pdfReportParser.js";
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

function createMinimalPdf(title: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(`BT\n/F1 24 Tf\n72 72 Td\n(${title}) Tj\nET\n`, "utf8")} >>\nstream\nBT\n/F1 24 Tf\n72 72 Td\n(${title}) Tj\nET\nendstream`,
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

import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { PdfReportParser } from "../src/parsers/pdfReportParser.js";

const parser = new PdfReportParser();
const fixtureDir = path.resolve("storage", "raw", "hampton-inn-and-suites-by-hilton-la-grande-or", "2026-05-19");

const expectedFamilies = [
  ["advance-deposit-activity", "advance_deposit_activity_rows"],
  ["booked-reservations", "booked_reservations_rows"],
  ["direct-bill-aging", "direct_bill_aging_rows"],
  ["direct-bill-ledger", "direct_bill_ledger_rows"],
  ["final-audit", "final_audit_metric_rows"],
  ["high-balance-reports", "high_balance_report_rows"],
  ["hotel-statistics", "hotel_statistics_metric_rows"],
  ["maintenance-summary", "maintenance_summary_rows"],
  ["occupancy", "occupancy_forecast_rows"],
  ["rate-override", "rate_override_rows"],
  ["tax-report", "tax_report_rows"]
] as const;

test("hampton la grande report bundle parses into supported families", async () => {
  if (!(await pathExists(fixtureDir))) {
    return;
  }

  const files = await readdir(fixtureDir);

  for (const [needle, reportType] of expectedFamilies) {
    const fileName = files.find((name) => name.includes(needle));
    assert.ok(fileName, `fixture present for ${needle}`);

    const parsed = await parser.parse(await readFile(path.join(fixtureDir, fileName)));
    assert.equal(parsed.reportType, reportType, `${needle} reportType`);
    assert.equal(parsed.propertySlug, "hampton-inn-and-suites-by-hilton-la-grande-or", `${needle} propertySlug`);
    assert.ok(parsed.rows.length > 0, `${needle} has parsed rows`);
  }
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

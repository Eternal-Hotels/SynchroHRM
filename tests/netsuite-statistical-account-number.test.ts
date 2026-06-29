import test from "node:test";
import assert from "node:assert/strict";
import { generateDeterministicStatisticalAccountNumber } from "../src/netsuite/statisticalAccountNumber.js";

test("statistical account number generation is stable for the same mapping", () => {
  const first = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "best_western_daily_report_rows:today_value:occupied"
  });
  const second = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "best_western_daily_report_rows:today_value:occupied"
  });

  assert.equal(first, second);
});

test("statistical account number generation separates different mappings", () => {
  const occupied = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "occupied"
  });
  const noShow = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "no_show"
  });

  assert.notEqual(occupied, noShow);
});

test("statistical account number generation respects length limits", () => {
  const value = generateDeterministicStatisticalAccountNumber({
    propertySlug: "very-long-property-name-for-testing",
    reportType: "very_long_report_type_name_for_testing",
    mappingKey: "very-long-mapping-key-for-testing",
    maxLength: 20
  });

  assert.ok(value.length <= 20);
});

test("statistical account number generation resolves collisions deterministically", () => {
  const base = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "occupied"
  });
  const collided = generateDeterministicStatisticalAccountNumber({
    propertySlug: "bw-plus-dayton-hotel-and-suites",
    reportType: "best_western_daily_report_rows",
    mappingKey: "occupied",
    takenNumbers: [base]
  });

  assert.notEqual(base, collided);
  assert.match(collided, /^[A-Z0-9-]+$/);
});

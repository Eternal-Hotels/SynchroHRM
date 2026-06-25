import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { AppDatabase } from "../src/db/Database.js";
import { WorkbookReportParser } from "../src/parsers/workbookReportParser.js";
import { IngestionService } from "../src/services/IngestionService.js";

const parser = new WorkbookReportParser();

const workbookFixtures = [
  {
    label: "ellensburg adjustment activity",
    path: path.resolve(
      "storage",
      "raw",
      "holiday-inn-express-ellensburg",
      "2026-05-27",
      "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tg_May_27_2026-ELNWA-Holiday_Inn_ExpressEllensburg-adjustment-a_eb13713d9174..xlsx"
    ),
    attachmentName: "May 27, 2026-ELNWA-Holiday Inn ExpressEllensburg-adjustment-activity.xlsx",
    reportType: "adjustment_refund_activity_rows",
    propertySlug: "holiday-inn-express-ellensburg",
    reportDate: "2026-05-26",
    assertParsed: (rows: Array<Record<string, unknown>>) => {
      const row = rows[0] ?? {};
      assert.equal(row.section, "Adjustments");
      assert.equal(row.row_kind, "total");
      assert.ok(row.adjusted_amount !== null);
    }
  },
  {
    label: "ellensburg all transactions",
    path: path.resolve(
      "storage",
      "raw",
      "holiday-inn-express-ellensburg",
      "2026-05-27",
      "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tg_May_27_2026-ELNWA-Holiday_Inn_ExpressEllensburg-all-transact_a9dadd162f6a..xlsx"
    ),
    attachmentName: "May 27, 2026-ELNWA-Holiday Inn ExpressEllensburg-all-transactions.xlsx",
    reportType: "all_transaction_rows",
    propertySlug: "holiday-inn-express-ellensburg",
    reportDate: "2026-05-26",
    assertParsed: (rows: Array<Record<string, unknown>>) => {
      const row = rows[0] ?? {};
      assert.equal(row.section, "Reservations");
      assert.equal(typeof row.confirmation_no, "string");
      assert.equal(typeof row.amount, "string");
    }
  },
  {
    label: "ellensburg tax report",
    path: path.resolve(
      "storage",
      "raw",
      "holiday-inn-express-ellensburg",
      "2026-05-27",
      "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tg_May_27_2026-ELNWA-Holiday_Inn_ExpressEllensburg-tax-report_15724b397b7a..xlsx"
    ),
    attachmentName: "May 27, 2026-ELNWA-Holiday Inn ExpressEllensburg-tax-report.xlsx",
    reportType: "tax_report_rows",
    propertySlug: "holiday-inn-express-ellensburg",
    reportDate: "2026-05-26",
    assertParsed: (rows: Array<Record<string, unknown>>) => {
      const row = rows[0] ?? {};
      assert.equal(row.section, "Summary");
      assert.ok(row.tax_name !== null);
    }
  },
  {
    label: "pendleton advance deposit",
    path: path.resolve(
      "storage",
      "raw",
      "holiday-inn-express-ellensburg",
      "2026-05-27",
      "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tg_May_27_2026-PDTOR-Holiday_Inn_ExpressPendleton-advance-depos_05901bc061aa..xlsx"
    ),
    attachmentName: "May 27, 2026-PDTOR-Holiday Inn ExpressPendleton-advance-deposit-activity.xlsx",
    reportType: "advance_deposit_activity_rows",
    propertySlug: "holiday-inn-express-pendleton",
    reportDate: "2026-05-26",
    assertParsed: (rows: Array<Record<string, unknown>>) => {
      const row = rows[0] ?? {};
      assert.equal(typeof row.confirmation_no, "string");
      assert.equal(typeof row.deposit_posted, "string");
    }
  },
  {
    label: "pendleton in-house folio balances",
    path: path.resolve(
      "storage",
      "raw",
      "holiday-inn-express-ellensburg",
      "2026-05-27",
      "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tg_May_27_2026-PDTOR-Holiday_Inn_ExpressPendleton-in-house-gues_e35e6df440cc..xlsx"
    ),
    attachmentName: "May 27, 2026-PDTOR-Holiday Inn ExpressPendleton-in-house-guest-folio-balances.xlsx",
    reportType: "in_house_guest_folio_balance_rows",
    propertySlug: "holiday-inn-express-pendleton",
    reportDate: "2026-05-26",
    assertParsed: (rows: Array<Record<string, unknown>>) => {
      const row = rows.find((candidate) => candidate.row_kind === "detail") ?? {};
      assert.equal(row.section, "Reservations");
      assert.equal(row.row_kind, "detail");
      assert.ok(row.ending_balance !== null);
    }
  }
] as const;

test("holiday inn express deferred workbook families parse into supported report types", async () => {
  for (const fixture of workbookFixtures) {
    if (!(await pathExists(fixture.path))) {
      return;
    }

    const parsed = await parser.parse(await readFile(fixture.path));
    assert.equal(parsed.reportType, fixture.reportType, `${fixture.label} reportType`);
    assert.equal(parsed.propertySlug, fixture.propertySlug, `${fixture.label} propertySlug`);
    assert.equal(parsed.reportDate, fixture.reportDate, `${fixture.label} reportDate`);
    assert.ok(parsed.rows.length > 0, `${fixture.label} has parsed rows`);
    fixture.assertParsed(parsed.rows as Array<Record<string, unknown>>);
  }
});

test("supported workbook families ingest as parsed instead of deferred", async () => {
  for (const fixture of workbookFixtures) {
    if (!(await pathExists(fixture.path))) {
      return;
    }
  }

  const root = await mkdtemp(path.join(tmpdir(), "synchro-workbook-ingest-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));

  try {
    const attachments = await Promise.all(workbookFixtures.map(async (fixture, index) => ({
      sourceMailbox: "auditor@eternalhotels.com",
      message: {
        graphMessageId: `xlsx-message-${index + 1}`,
        internetMessageId: `<xlsx-message-${index + 1}@test>`,
        subject: fixture.label,
        senderEmail: "auditor@eternalhotels.com",
        receivedAt: `2026-05-27T0${index}:00:00Z`,
        webLink: null
      },
      attachmentId: `xlsx-attachment-${index + 1}`,
      attachmentName: fixture.attachmentName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: await readFile(fixture.path)
    })));

    const service = new IngestionService(database, {
      async pullAttachments() {
        return {
          attachments,
          nextDeltaToken: "xlsx-delta",
          deltaWasReset: false,
          messagesSeen: attachments.length
        };
      }
    }, dataDir);

    const result = await service.run("test");
    assert.equal(result.status, "completed");
    assert.equal(result.summary.attachmentsSeen, workbookFixtures.length);
    assert.equal(result.summary.attachmentsArchived, workbookFixtures.length);
    assert.equal(result.summary.attachmentsParsed, workbookFixtures.length);
    assert.equal(result.summary.attachmentsDeferred, 0);
    assert.equal(result.summary.attachmentsFailed, 0);

    const run = database.getRun(result.runId);
    assert.ok(run);
    const savedAttachments = run.attachments as Array<{ status: string; property_slug: string; report_type: string }>;
    assert.equal(savedAttachments.length, workbookFixtures.length);
    assert.ok(savedAttachments.every((attachment) => attachment.status === "parsed"));
    assert.equal(
      savedAttachments.filter((attachment) => attachment.property_slug === "holiday-inn-express-ellensburg").length,
      3
    );
    assert.equal(
      savedAttachments.filter((attachment) => attachment.property_slug === "holiday-inn-express-pendleton").length,
      2
    );
    assert.deepEqual(
      new Set(savedAttachments.map((attachment) => attachment.report_type)),
      new Set(workbookFixtures.map((fixture) => fixture.reportType))
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stored workbook repair restores misbucketed holiday inn express workbook attachments", async () => {
  for (const fixture of workbookFixtures) {
    if (!(await pathExists(fixture.path))) {
      return;
    }
  }

  const root = await mkdtemp(path.join(tmpdir(), "synchro-workbook-repair-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));

  try {
    const attachments = await Promise.all(workbookFixtures.map(async (fixture, index) => ({
      sourceMailbox: "auditor@eternalhotels.com",
      message: {
        graphMessageId: `repair-message-${index + 1}`,
        internetMessageId: `<repair-message-${index + 1}@test>`,
        subject: fixture.label,
        senderEmail: "auditor@eternalhotels.com",
        receivedAt: `2026-05-28T0${index}:00:00Z`,
        webLink: null
      },
      attachmentId: `repair-attachment-${index + 1}`,
      attachmentName: fixture.attachmentName,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: await readFile(fixture.path)
    })));

    const service = new IngestionService(database, {
      async pullAttachments() {
        return {
          attachments,
          nextDeltaToken: "repair-delta",
          deltaWasReset: false,
          messagesSeen: attachments.length
        };
      }
    }, dataDir);

    const firstRun = await service.run("test");
    assert.equal(firstRun.status, "completed");

    const initialRun = database.getRun(firstRun.runId);
    assert.ok(initialRun);
    const savedAttachments = initialRun.attachments as Array<{ id: number; archived_path: string }>;
    assert.equal(savedAttachments.length, workbookFixtures.length);

    for (const attachment of savedAttachments) {
      database.updateAttachment(Number(attachment.id), {
        archivedPath: toLegacyWindowsStoragePath(dataDir, String(attachment.archived_path)),
        propertyName: "Hampton Inn and Suites by Hilton - La Grande, OR",
        propertySlug: "hampton-inn-and-suites-by-hilton-la-grande-or",
        status: "deferred",
        reportType: null,
        reportTitle: null,
        parsedJsonPath: null,
        parseError: "stale workbook bucket"
      });
    }

    const staleSummary = database.getPropertySummary("hampton-inn-and-suites-by-hilton-la-grande-or");
    assert.ok(staleSummary);
    assert.equal(staleSummary.attachment_count, workbookFixtures.length);

    const repairRun = await service.repairStoredWorkbookAttachments({
      attachmentNameIncludes: "Holiday Inn Express"
    });
    assert.equal(repairRun.status, "completed");
    assert.equal(repairRun.summary.attachmentsSeen, workbookFixtures.length);
    assert.equal(repairRun.summary.attachmentsParsed, workbookFixtures.length);
    assert.equal(repairRun.summary.attachmentsDeferred, 0);
    assert.equal(repairRun.summary.attachmentsFailed, 0);

    const repairedRunRecord = database.getRun(repairRun.runId);
    assert.ok(repairedRunRecord);
    const repairedAttachments = repairedRunRecord.attachments as Array<{
      archived_path: string;
      status: string;
      property_slug: string;
      report_type: string;
    }>;
    assert.equal(repairedAttachments.length, workbookFixtures.length);
    assert.ok(repairedAttachments.every((attachment) => attachment.status === "parsed"));
    assert.ok(repairedAttachments.every((attachment) => String(attachment.archived_path).startsWith(dataDir)));
    assert.equal(
      repairedAttachments.filter((attachment) => attachment.property_slug === "holiday-inn-express-ellensburg").length,
      3
    );
    assert.equal(
      repairedAttachments.filter((attachment) => attachment.property_slug === "holiday-inn-express-pendleton").length,
      2
    );
    assert.deepEqual(
      new Set(repairedAttachments.map((attachment) => attachment.report_type)),
      new Set(workbookFixtures.map((fixture) => fixture.reportType))
    );

    assert.equal(database.getPropertySummary("hampton-inn-and-suites-by-hilton-la-grande-or"), null);
    assert.ok(database.getPropertySummary("holiday-inn-express-ellensburg"));
    assert.ok(database.getPropertySummary("holiday-inn-express-pendleton"));
    assert.ok(database.getLatestExport("adjustment_refund_activity_rows", "holiday-inn-express-ellensburg"));
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
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

function toLegacyWindowsStoragePath(dataDir: string, storedPath: string): string {
  return storedPath
    .replace(dataDir, "C:\\Scripts\\SynchroHRM\\storage")
    .replace(/\//g, "\\");
}

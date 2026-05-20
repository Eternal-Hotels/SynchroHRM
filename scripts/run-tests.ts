import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/db/Database.js";
import { PdfReportParser, UnsupportedReportError } from "../src/parsers/pdfReportParser.js";
import { ExampleDataAttachmentSource } from "../src/sources/ExampleDataAttachmentSource.js";
import { GraphAttachmentSource } from "../src/sources/GraphAttachmentSource.js";
import type { AppConfig } from "../src/config.js";
import expectations from "../tests/fixtures/parser-expectations.json" with { type: "json" };
import { IngestionService } from "../src/services/IngestionService.js";

const parser = new PdfReportParser();

await run("sample PDFs parse into expected report types and row counts", async () => {
  for (const [fileName, expected] of Object.entries(expectations)) {
    const bytes = await readFile(path.resolve("ExampleData", fileName));
    const parsed = await parser.parse(bytes);

    assert.equal(parsed.reportType, expected.reportType, `${fileName} reportType`);
    assert.equal(parsed.rows.length, expected.rowCount, `${fileName} rowCount`);
    assert.deepEqual(parsed.rows[0], { ...parsed.rows[0], ...expected.firstRow }, `${fileName} first row partial match`);
  }
});

await run("reservation continuation lines are folded into notes", async () => {
  const bytes = await readFile(path.resolve("ExampleData", "Reservations Made Yesterday.PDF"));
  const parsed = await parser.parse(bytes);
  const target = parsed.rows.find((row) => row.guest_name === "bilardello,david");
  assert.ok(target);
  assert.match(String(target.company_group_note), /Sonesta Travel Pass/i);
  assert.match(String(target.company_group_note), /Member Rate/i);
});

await run("unsupported valid PDFs are rejected explicitly", async () => {
  const bytes = createMinimalPdf("Unknown Report");
  await assert.rejects(() => parser.parse(bytes), UnsupportedReportError);
});

await run("corrupted PDFs fail parsing", async () => {
  await assert.rejects(() => parser.parse(Buffer.from("not-a-pdf")));
});

await run("graph source resets stale delta tokens and filters supported attachments", async () => {
  const requests: string[] = [];
  const responses = [
    mockResponse(200, { access_token: "token-1", expires_in: 3600 }),
    mockResponse(410, { error: { message: "Sync state expired" } }),
    mockResponse(200, {
      value: [
        {
          id: "message-1",
          subject: "Daily reports",
          internetMessageId: "<message-1@test>",
          receivedDateTime: "2026-05-19T12:00:00Z",
          hasAttachments: true
        }
      ],
      "@odata.deltaLink": "delta-2"
    }),
    mockResponse(200, {
      value: [
        {
          id: "attachment-pdf",
          name: "sales.pdf",
          "@odata.type": "#microsoft.graph.fileAttachment",
          contentType: "application/pdf",
          contentBytes: Buffer.from("pdf-bytes").toString("base64")
        },
        {
          id: "attachment-inline",
          name: "inline.png",
          "@odata.type": "#microsoft.graph.fileAttachment",
          isInline: true,
          contentType: "image/png",
          contentBytes: Buffer.from("png").toString("base64")
        },
        {
          id: "attachment-text",
          name: "notes.txt",
          "@odata.type": "#microsoft.graph.fileAttachment",
          contentType: "text/plain",
          contentBytes: Buffer.from("notes").toString("base64")
        }
      ]
    })
  ];

  const fetchImpl: typeof fetch = async (input) => {
    requests.push(String(input));
    const next = responses.shift();
    assert.ok(next, `Unexpected request: ${String(input)}`);
    return next as Response;
  };

  const source = new GraphAttachmentSource(mockConfig(), fetchImpl);
  const result = await source.pullAttachments("stale-delta");

  assert.equal(result.deltaWasReset, true);
  assert.equal(result.nextDeltaToken, "delta-2");
  assert.equal(result.messagesSeen, 1);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].attachmentName, "sales.pdf");
  assert.equal(requests.filter((url) => url.includes("/oauth2/v2.0/token")).length, 1);
});

await run("hampton la grande report bundle parses into supported families", async () => {
  const fixtureDir = path.resolve("storage", "raw", "hampton-inn-and-suites-by-hilton-la-grande-or", "2026-05-19");
  if (!(await pathExists(fixtureDir))) {
    return;
  }

  const files = await readdir(fixtureDir);
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

  for (const [needle, reportType] of expectedFamilies) {
    const fileName = files.find((name) => name.includes(needle));
    assert.ok(fileName, `fixture present for ${needle}`);

    const parsed = await parser.parse(await readFile(path.join(fixtureDir, fileName)));
    assert.equal(parsed.reportType, reportType, `${needle} reportType`);
    assert.equal(parsed.propertySlug, "hampton-inn-and-suites-by-hilton-la-grande-or", `${needle} propertySlug`);
    assert.ok(parsed.rows.length > 0, `${needle} has parsed rows`);
  }
});

await run("holiday inn pendleton standalone operational reports parse as supported", async () => {
  const fixtureDir = path.resolve("storage", "raw", "unassigned-property", "2026-05-20");
  if (!(await pathExists(fixtureDir))) {
    return;
  }

  const files = await readdir(fixtureDir);
  const operationalReportSuffixes = [
    "authorized-payments.pdf",
    "breakfast-and-packages.pdf",
    "departures-list.pdf",
    "house-account-balances.pdf",
    "maintenance-activity.pdf",
    "no-show.pdf",
    "room-count-summary.pdf"
  ] as const;

  for (const suffix of operationalReportSuffixes) {
    const fileName = files.find((name) => name.includes("Holiday_Inn_ExpressPendleton") && name.endsWith(suffix));
    assert.ok(fileName, `fixture present for ${suffix}`);

    const parsed = await parser.parse(await readFile(path.join(fixtureDir, fileName)));
    assert.equal(parsed.reportType, "all_night_audit_report_rows", `${suffix} reportType`);
  }
});

await run("best western daily report parses into franchise-specific rows", async () => {
  const fixturePath = path.resolve(
    "storage",
    "raw",
    "bw-plus-dayton-hotel-and-suites-06-01-2025-02-21-lupe-accounting",
    "2026-05-20",
    "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC0FPFxAAA__DailyReport.pdf"
  );
  if (!(await pathExists(fixturePath))) {
    return;
  }

  const parsed = await parser.parse(await readFile(fixturePath));
  assert.equal(parsed.reportType, "best_western_daily_report_rows");
  assert.equal(parsed.propertySlug, "bw-plus-dayton-hotel-and-suites");
  assert.equal(parsed.reportDate, "2025-05-31");
  assert.ok(parsed.rows.length > 40);

  const recapRow = parsed.rows.find((row) => row.section === "Statistical Recap" && row.metric_name === "Occupied");
  assert.ok(recapRow);
  assert.equal(recapRow.today_value, "23");

  const detailRow = parsed.rows.find((row) => row.posting_code === "MC");
  assert.ok(detailRow);
  assert.equal(detailRow.group_name, "GL CREDIT CARDS REV");
  assert.equal(detailRow.posting_description, "PAYMENT MASTERCARD");
});

await run("comfort all night audit packet parses into structured bundle rows", async () => {
  const fixturePath = path.resolve(
    "storage",
    "quarantine",
    "unsupported",
    "unassigned-property",
    "AAMkADY4MjQ5NjFkLTRjZTktNGFiZS05ZDhjLWNiMDAxMWVmZjNhYgBGAAAAAADvcm92xvZDSLd2s0tgIkcIBwA71flkJMjiQK5tdwwB3oCMAAAAAAEMAAA71flkJMjiQK5tdwwB3oCMAAC0FPFzAAA__All_Night_Audit_Reports_WA184_AUDIT_2026-05-18.pdf"
  );
  if (!(await pathExists(fixturePath))) {
    return;
  }

  const parsed = await parser.parse(await readFile(fixturePath));
  assert.equal(parsed.reportType, "all_night_audit_report_rows");
  assert.equal(parsed.reportTitle, "All Night Audit Reports");
  assert.equal(parsed.propertySlug, "comfort-inn-and-suites-wa184");
  assert.equal(parsed.reportDate, "2026-05-18");
  assert.ok(parsed.rows.length > 300);

  const booksRow = parsed.rows.find((row) => row.report_name === "Business on The Books" && row.row_kind === "daily" && row.date_value === "2026-05-18");
  assert.ok(booksRow);
  assert.equal(booksRow.value_9, "30");
  assert.equal(booksRow.value_14, "3272.83");

  const cancellationTotal = parsed.rows.find((row) => row.report_name === "Cancellation List" && row.metric_name === "Total Cancellations");
  assert.ok(cancellationTotal);
  assert.equal(cancellationTotal.value_1, "2");

  const reservationTotal = parsed.rows.find((row) => row.report_name === "Reservation Activity Report" && row.metric_name === "Total Reservations");
  assert.ok(reservationTotal);
  assert.equal(reservationTotal.value_1, "34");
});

await run("example data ingests end to end into sqlite and csv exports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-e2e-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));

  try {
    const source = new ExampleDataAttachmentSource(path.resolve("ExampleData"));
    const service = new IngestionService(database, source, dataDir);
    const firstRun = await service.run("test");

    assert.equal(firstRun.status, "completed");
    assert.equal(firstRun.summary.attachmentsSeen, 8);
    assert.equal(firstRun.summary.attachmentsArchived, 8);
    assert.equal(firstRun.summary.attachmentsParsed, 7);
    assert.equal(firstRun.summary.attachmentsDeferred, 1);
    assert.equal(firstRun.summary.attachmentsFailed, 0);

    const historyExport = firstRun.exports.find((entry) => entry.reportType === "history_forecast_rows");
    assert.ok(historyExport);
    assert.equal(historyExport.rowCount, 61);
    const latestCsv = await readFile(historyExport.latestPath, "utf8");
    assert.match(latestCsv, /business_date,section,day_of_week/);

    const runRecord = database.getRun(firstRun.runId);
    assert.ok(runRecord);
    const attachments = runRecord.attachments as Array<{ id: number; status: string; report_type?: string | null }>;
    assert.equal(attachments.length, 8);
    assert.ok(attachments.some((attachment) => attachment.status === "deferred"));
    const parsedAttachment = attachments.find((attachment) => attachment.status === "parsed" && attachment.report_type === "history_forecast_rows");
    assert.ok(parsedAttachment);
    const attachmentRows = database.getAttachmentExportRows("history_forecast_rows", parsedAttachment.id);
    assert.ok(attachmentRows.length > 0);

    const secondRun = await service.run("test");
    assert.equal(secondRun.status, "completed");
    assert.equal(secondRun.summary.attachmentsSeen, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

await run("failed pdf attachments can be retried into parsed reports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-retry-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));

  try {
    const runId = database.createRun("test");
    const fileName = "History and Forecast June.PDF";
    const archiveBytes = await readFile(path.resolve("ExampleData", fileName));
    const archivedPath = path.join(
      dataDir,
      "raw",
      "red-lion-hotel-pasco-airport-and-conference-center",
      "2026-05-19",
      "message-1_History_and_Forecast_June.PDF"
    );
    await mkdir(path.dirname(archivedPath), { recursive: true });
    await writeFile(archivedPath, archiveBytes);

    database.upsertMessage({
      graphMessageId: "message-1",
      internetMessageId: "<message-1@test>",
      subject: "Daily report retry",
      receivedAt: "2026-05-19T12:00:00Z",
      webLink: null
    });

    const attachmentId = database.insertAttachment({
      graphMessageId: "message-1",
      graphAttachmentId: "attachment-1",
      ingestRunId: runId,
      internetMessageId: "<message-1@test>",
      sourceMailbox: "auditor@eternalhotels.com",
      receivedAt: "2026-05-19T12:00:00Z",
      attachmentName: fileName,
      propertyName: "Red Lion Hotel Pasco Airport and Conference Center",
      propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
      extension: ".pdf",
      contentType: "application/pdf",
      archivedPath,
      status: "archived"
    });
    database.updateAttachment(attachmentId, {
      status: "failed",
      propertyName: "Red Lion Hotel Pasco Airport and Conference Center",
      propertySlug: "red-lion-hotel-pasco-airport-and-conference-center",
      reportTitle: "History and Forecast",
      reportDate: "2026-05-17",
      parseError: "Previous parser failure"
    });

    const service = new IngestionService(database, {
      async pullAttachments() {
        return {
          attachments: [],
          nextDeltaToken: null,
          deltaWasReset: false,
          messagesSeen: 0
        };
      }
    }, dataDir);
    const result = await service.retryAttachmentParse(attachmentId);

    assert.equal(result.succeeded, true);
    const updated = database.getAttachmentById(attachmentId);
    assert.ok(updated);
    assert.equal(updated.status, "parsed");
    assert.equal(updated.report_type, "history_forecast_rows");
    assert.equal(updated.report_title, "History and Forecast");
    assert.equal(updated.report_date, "2026-05-19");
    assert.equal(updated.parse_error, null);
    assert.ok(typeof updated.parsed_json_path === "string");

    const rows = database.getExportRows("history_forecast_rows", {
      propertySlug: "red-lion-hotel-pasco-airport-and-conference-center"
    });
    assert.ok(rows.length > 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function createMinimalPdf(title: string): Buffer {
  const stream = `BT\n/F1 24 Tf\n72 72 Td\n(${title}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let output = "%PDF-1.4\n";
  const offsets = [0];

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "utf8");
}

function mockConfig(): AppConfig {
  return {
    port: 3000,
    graphTenantId: "tenant",
    graphClientId: "client",
    graphClientSecret: "secret",
    graphMailboxUser: "auditor@eternalhotels.com",
    graphMailFolder: "Inbox",
    pollCron: "0 * * * *",
    dataDir: "./storage",
    databasePath: "./storage/app.sqlite"
  };
}

function mockResponse(status: number, payload: unknown): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  } as Response;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const attachments = runRecord.attachments as Array<{ status: string }>;
    assert.equal(attachments.length, 8);
    assert.ok(attachments.some((attachment) => attachment.status === "deferred"));

    const secondRun = await service.run("test");
    assert.equal(secondRun.status, "completed");
    assert.equal(secondRun.summary.attachmentsSeen, 0);
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

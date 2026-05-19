import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/db/Database.js";
import { ExampleDataAttachmentSource } from "../src/sources/ExampleDataAttachmentSource.js";
import { IngestionService } from "../src/services/IngestionService.js";
import { pathExists } from "../src/utils/files.js";

test("example data ingests end to end into storage, sqlite, and csv exports", async () => {
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
    assert.match(latestCsv, /property_name,property_slug,report_type/);
    assert.match(latestCsv, /business_date,section,day_of_week/);

    const runRecord = database.getRun(firstRun.runId);
    assert.ok(runRecord);
    const attachments = (runRecord.attachments as Array<{ status: string; property_slug: string; archived_path: string; attachment_name: string }>);
    assert.equal(attachments.length, 8);
    assert.ok(attachments.some((attachment) => attachment.status === "deferred"));
    assert.ok(attachments.every((attachment) => attachment.property_slug === "red-lion-hotel-pasco-airport-and-conference-center"));
    assert.ok(attachments.every((attachment) => attachment.archived_path.includes(path.join("raw", "red-lion-hotel-pasco-airport-and-conference-center"))));
    assert.ok(attachments.some((attachment) => attachment.attachment_name.endsWith(".xlsx") && attachment.property_slug === "red-lion-hotel-pasco-airport-and-conference-center"));

    const propertySummaries = database.getPropertySummaries();
    assert.equal(propertySummaries.length, 1);
    assert.equal(propertySummaries[0].property_slug, "red-lion-hotel-pasco-airport-and-conference-center");
    assert.equal(propertySummaries[0].attachment_count, 8);

    const renamedProperty = await service.updateProperty("red-lion-hotel-pasco-airport-and-conference-center", {
      propertyName: "Eternal Pasco Test Hotel",
      propertySlug: "eternal-pasco-test-hotel"
    });
    assert.equal(renamedProperty.property_slug, "eternal-pasco-test-hotel");
    assert.equal(database.getPropertySummary("red-lion-hotel-pasco-airport-and-conference-center"), null);

    const renamedAttachments = database.getPropertyAttachments("eternal-pasco-test-hotel") as Array<{
      property_name: string;
      property_slug: string;
      archived_path: string;
    }>;
    assert.equal(renamedAttachments.length, 8);
    assert.ok(renamedAttachments.every((attachment) => attachment.property_name === "Eternal Pasco Test Hotel"));
    assert.ok(renamedAttachments.every((attachment) => attachment.property_slug === "eternal-pasco-test-hotel"));
    assert.ok(renamedAttachments.every((attachment) => attachment.archived_path.includes(path.join("raw", "eternal-pasco-test-hotel"))));
    assert.equal(await pathExists(path.join(dataDir, "raw", "red-lion-hotel-pasco-airport-and-conference-center")), false);
    assert.equal(await pathExists(path.join(dataDir, "raw", "eternal-pasco-test-hotel")), true);

    const renamedPropertyExport = database.getLatestExport("history_forecast_rows", "eternal-pasco-test-hotel");
    assert.ok(renamedPropertyExport);
    assert.ok(String(renamedPropertyExport.latest_path).includes(path.join("properties", "eternal-pasco-test-hotel")));
    const renamedPropertyCsv = await readFile(String(renamedPropertyExport.latest_path), "utf8");
    assert.match(renamedPropertyCsv, /Eternal Pasco Test Hotel/);
    assert.match(renamedPropertyCsv, /eternal-pasco-test-hotel/);

    const refreshedGlobalExport = database.getLatestExport("history_forecast_rows");
    assert.ok(refreshedGlobalExport);
    const refreshedGlobalCsv = await readFile(String(refreshedGlobalExport.latest_path), "utf8");
    assert.match(refreshedGlobalCsv, /Eternal Pasco Test Hotel/);
    assert.match(refreshedGlobalCsv, /eternal-pasco-test-hotel/);

    const secondRun = await service.run("test");
    assert.equal(secondRun.status, "completed");
    assert.equal(secondRun.summary.attachmentsSeen, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
        assert.equal(firstRun.summary.attachmentsSeen, 12);
        assert.equal(firstRun.summary.attachmentsArchived, 12);
        assert.equal(firstRun.summary.attachmentsParsed, 11);
        assert.equal(firstRun.summary.attachmentsDeferred, 1);
        assert.equal(firstRun.summary.attachmentsFailed, 0);
        assert.ok(firstRun.exports.every((entry) => entry.propertySlug !== null));
        const historyExport = firstRun.exports.find((entry) => (entry.reportType === "history_forecast_rows"
            && entry.propertySlug === "red-lion-hotel-pasco-airport-and-conference-center"));
        assert.ok(historyExport);
        assert.equal(historyExport.rowCount, 61);
        const latestCsv = await readFile(historyExport.latestPath, "utf8");
        assert.match(latestCsv, /^business_date,section,day_of_week/m);
        assert.doesNotMatch(latestCsv, /attachment_name|property_name|property_slug|report_type|report_title|report_date|ingest_run_id/);
        assert.equal(database.getLatestExport("history_forecast_rows"), null);
        const runRecord = database.getRun(firstRun.runId);
        assert.ok(runRecord);
        const attachments = runRecord.attachments;
        assert.equal(attachments.length, 12);
        assert.ok(attachments.some((attachment) => attachment.status === "deferred"));
        assert.equal(attachments.filter((attachment) => attachment.property_slug === "red-lion-hotel-pasco-airport-and-conference-center").length, 8);
        assert.equal(attachments.filter((attachment) => attachment.property_slug === "best-western-pendleton-inn").length, 4);
        assert.ok(attachments.every((attachment) => (attachment.archived_path.includes(path.join("raw", "red-lion-hotel-pasco-airport-and-conference-center"))
            || attachment.archived_path.includes(path.join("raw", "best-western-pendleton-inn")))));
        assert.ok(attachments.some((attachment) => attachment.attachment_name.endsWith(".xlsx") && attachment.property_slug === "red-lion-hotel-pasco-airport-and-conference-center"));
        const propertySummaries = database.getPropertySummaries();
        assert.equal(propertySummaries.length, 2);
        const redLionSummary = propertySummaries.find((entry) => entry.property_slug === "red-lion-hotel-pasco-airport-and-conference-center");
        const bestWesternSummary = propertySummaries.find((entry) => entry.property_slug === "best-western-pendleton-inn");
        assert.ok(redLionSummary);
        assert.ok(bestWesternSummary);
        assert.equal(redLionSummary.attachment_count, 8);
        assert.equal(bestWesternSummary.attachment_count, 4);
        const renamedProperty = await service.updateProperty("red-lion-hotel-pasco-airport-and-conference-center", {
            propertyName: "Eternal Pasco Test Hotel",
            propertySlug: "eternal-pasco-test-hotel"
        });
        assert.equal(renamedProperty.property_slug, "eternal-pasco-test-hotel");
        assert.equal(database.getPropertySummary("red-lion-hotel-pasco-airport-and-conference-center"), null);
        const renamedAttachments = database.getPropertyAttachments("eternal-pasco-test-hotel");
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
        assert.match(renamedPropertyCsv, /^business_date,section,day_of_week/m);
        assert.doesNotMatch(renamedPropertyCsv, /attachment_name|property_name|property_slug|report_type|report_title|report_date|ingest_run_id/);
        assert.equal(database.getLatestExport("history_forecast_rows"), null);
        const reparseRun = await service.reparseStoredReports();
        assert.equal(reparseRun.status, "completed");
        assert.equal(reparseRun.summary.attachmentsSeen, 12);
        assert.equal(reparseRun.summary.attachmentsArchived, 0);
        assert.equal(reparseRun.summary.attachmentsParsed, 11);
        assert.equal(reparseRun.summary.attachmentsDeferred, 1);
        assert.equal(reparseRun.summary.attachmentsFailed, 0);
        const reparsedRunRecord = database.getRun(reparseRun.runId);
        assert.ok(reparsedRunRecord);
        const reparsedAttachments = reparsedRunRecord.attachments;
        assert.equal(reparsedAttachments.length, 12);
        assert.equal(reparsedAttachments.filter((attachment) => attachment.property_slug === "eternal-pasco-test-hotel").length, 8);
        assert.equal(reparsedAttachments.filter((attachment) => attachment.property_slug === "best-western-pendleton-inn").length, 4);
        assert.ok(reparsedAttachments.some((attachment) => attachment.status === "deferred"));
        const reparsedExport = database.getLatestExport("history_forecast_rows", "eternal-pasco-test-hotel");
        assert.ok(reparsedExport);
        const reparsedCsv = await readFile(String(reparsedExport.latest_path), "utf8");
        assert.match(reparsedCsv, /^business_date,section,day_of_week/m);
        assert.doesNotMatch(reparsedCsv, /attachment_name|property_name|property_slug|report_type|report_title|report_date|ingest_run_id/);
        const secondRun = await service.run("test");
        assert.equal(secondRun.status, "completed");
        assert.equal(secondRun.summary.attachmentsSeen, 0);
    }
    finally {
        database.close();
        await rm(root, { recursive: true, force: true });
    }
});

import express from "express";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { REPORT_TYPES } from "../types.js";
import type { AppDatabase } from "../db/Database.js";
import { PropertyUpdateError, type IngestionService } from "../services/IngestionService.js";
import { REPORT_TITLES } from "../reports.js";

export function createApp(
  config: AppConfig,
  database: AppDatabase,
  ingestionService: IngestionService
): express.Express {
  const app = express();
  const uiDir = path.resolve(process.cwd(), "src", "ui");
  app.use(express.json());

  app.get("/", (_request, response) => {
    response.sendFile(path.join(uiDir, "admin-panel.html"));
  });

  app.get("/app.css", (_request, response) => {
    response.sendFile(path.join(uiDir, "admin-panel.css"));
  });

  app.get("/app.js", (_request, response) => {
    response.sendFile(path.join(uiDir, "admin-client.js"));
  });

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      mailboxUser: config.graphMailboxUser,
      mailFolder: config.graphMailFolder,
      dataDir: config.dataDir,
      latestRun: database.getLatestRun()
    });
  });

  app.get("/api/dashboard", (_request, response) => {
    response.json({
      status: "ok",
      serverTime: new Date().toISOString(),
      mailboxUser: config.graphMailboxUser,
      mailFolder: config.graphMailFolder,
      pollCron: config.pollCron,
      dataDir: config.dataDir,
      latestRun: database.getLatestRun(),
      properties: database.getPropertySummaries()
    });
  });

  app.post("/api/ingest/run", async (_request, response) => {
    const result = await ingestionService.run("manual");
    response.status(result.status === "completed" ? 200 : 500).json(result);
  });

  app.get("/api/runs/latest", (_request, response) => {
    const latestRun = database.getLatestRun();
    if (!latestRun || typeof latestRun.id !== "number") {
      response.status(404).json({ error: "No runs have been recorded yet." });
      return;
    }

    const run = database.getRun(latestRun.id);
    if (!run) {
      response.status(404).json({ error: "Latest run details are unavailable." });
      return;
    }

    response.json(run);
  });

  app.get("/api/runs/:runId", (request, response) => {
    const runId = Number(request.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      response.status(400).json({ error: "runId must be a positive integer." });
      return;
    }

    const run = database.getRun(runId);
    if (!run) {
      response.status(404).json({ error: `Run ${runId} was not found.` });
      return;
    }

    response.json(run);
  });

  app.get("/api/properties/:propertySlug", (request, response) => {
    const propertySlug = request.params.propertySlug;
    const payload = buildPropertyPayload(propertySlug, database, ingestionService);
    if (!payload) {
      response.status(404).json({ error: `Property ${propertySlug} was not found.` });
      return;
    }

    response.json(payload);
  });

  app.patch("/api/properties/:propertySlug", async (request, response) => {
    const propertySlug = request.params.propertySlug;
    const propertyName = typeof request.body?.propertyName === "string" ? request.body.propertyName : "";
    const nextPropertySlug = typeof request.body?.propertySlug === "string" ? request.body.propertySlug : null;

    try {
      const updated = await ingestionService.updateProperty(propertySlug, {
        propertyName,
        propertySlug: nextPropertySlug
      });

      const payload = buildPropertyPayload(String(updated.property_slug), database, ingestionService);
      if (!payload) {
        response.status(404).json({ error: `Property ${propertySlug} could not be reloaded after save.` });
        return;
      }

      response.json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof PropertyUpdateError ? 400 : 500).json({ error: message });
    }
  });

  app.get("/api/properties/:propertySlug/exports/:reportType/latest", (request, response) => {
    const reportType = request.params.reportType;
    const propertySlug = request.params.propertySlug;
    if (!REPORT_TYPES.includes(reportType as (typeof REPORT_TYPES)[number])) {
      response.status(400).json({ error: `Unknown report type: ${reportType}` });
      return;
    }

    const latest = ingestionService.getLatestExport(reportType as (typeof REPORT_TYPES)[number], propertySlug);
    if (!latest || typeof latest.latest_path !== "string") {
      response.status(404).json({ error: `No property export exists yet for ${propertySlug} / ${reportType}.` });
      return;
    }

    if (request.query.download === "1") {
      response.download(latest.latest_path, `${propertySlug}-${reportType}-latest.csv`);
      return;
    }

    response.json(latest);
  });

  return app;
}

function buildPropertyPayload(
  propertySlug: string,
  database: AppDatabase,
  ingestionService: IngestionService
): Record<string, unknown> | null {
  const summary = database.getPropertySummary(propertySlug);
  if (!summary) {
    return null;
  }

  const counts = new Map(
    database.getPropertyReportCounts(propertySlug).map((entry) => [entry.report_type, entry.attachment_count])
  );

  return {
    property: summary,
    reports: REPORT_TYPES.map((reportType) => ({
      reportType,
      title: REPORT_TITLES[reportType],
      attachmentCount: counts.get(reportType) ?? 0,
      latestExport: ingestionService.getLatestExport(reportType, propertySlug)
    })),
    attachments: database.getPropertyAttachments(propertySlug)
  };
}

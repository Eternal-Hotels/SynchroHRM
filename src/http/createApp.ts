import express from "express";
import path from "node:path";
import {
  AuthenticationError,
  AuthorizationError,
  AuthService,
  UserManagementError,
  type SessionUser
} from "../auth/AuthService.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/Database.js";
import { NetSuitePostingError, NetSuitePostingService } from "../services/NetSuitePostingService.js";
import { NetSuiteConnectionService, NetSuiteSettingsError } from "../services/NetSuiteConnectionService.js";
import { REPORT_COLUMN_MAP, REPORT_EXPORT_COLUMN_MAP, REPORT_TITLES } from "../reports.js";
import {
  AttachmentRetryError,
  IngestionOperationError,
  PropertyUpdateError,
  ReparseOperationError,
  type IngestionService
} from "../services/IngestionService.js";
import { parseApprovedSenderPatterns } from "../utils/approvedSenders.js";
import { REPORT_TYPES } from "../types.js";
import { toCsv } from "../utils/csv.js";
import { buildLatestExportDownloadName, buildParsedCsvDownloadName } from "../utils/downloads.js";

export function createApp(
  config: AppConfig,
  database: AppDatabase,
  ingestionService: IngestionService,
  authService: AuthService,
  netSuiteConnectionService?: NetSuiteConnectionService
): express.Express {
  const app = express();
  const uiDir = path.resolve(process.cwd(), "src", "ui");
  const effectiveNetSuiteConnectionService = netSuiteConnectionService ?? new NetSuiteConnectionService(database, config.secretMasterKey, config.dataDir);
  const netSuitePostingService = new NetSuitePostingService(database, effectiveNetSuiteConnectionService);
  const secureCookies = process.env.NODE_ENV === "production";

  if (secureCookies) {
    app.set("trust proxy", 1);
  }

  app.use(express.json());

  app.get("/login", (request, response) => {
    const user = getAuthenticatedUser(request, authService);
    if (user) {
      response.redirect(getHomePathForUser(user));
      return;
    }

    response.sendFile(path.join(uiDir, "login.html"));
  });

  app.get("/login.css", (_request, response) => {
    response.sendFile(path.join(uiDir, "login.css"));
  });

  app.get("/login.js", (_request, response) => {
    response.sendFile(path.join(uiDir, "login.js"));
  });

  app.get("/login-logo.png", (_request, response) => {
    response.sendFile(path.join(uiDir, "eternal-hotels-logo.png"));
  });

  app.post("/api/auth/login", (request, response) => {
    const authorizedUserConfirmed = request.body?.authorizedUserConfirmed === true;
    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    if (!authorizedUserConfirmed) {
      response.status(400).json({ error: "Please confirm that you are an authorized user before signing in." });
      return;
    }

    try {
      const result = authService.login(username, password);
      setSessionCookie(response, authService, result.token, result.expiresAt, secureCookies);
      response.json({ user: result.user });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof AuthenticationError ? 401 : 500).json({ error: message });
    }
  });

  app.post("/api/auth/logout", (request, response) => {
    authService.logout(readSessionToken(request, authService));
    clearSessionCookie(response, authService, secureCookies);
    response.status(204).end();
  });

  app.get("/api/auth/me", (request, response) => {
    const user = getAuthenticatedUser(request, authService);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }

    response.json({ user });
  });

  app.get("/app.css", (_request, response) => {
    response.sendFile(path.join(uiDir, "admin-panel.css"));
  });

  app.get("/app.js", (_request, response) => {
    response.sendFile(path.join(uiDir, "admin-client.js"));
  });

  app.get("/", (request, response) => {
    const user = getAuthenticatedUser(request, authService);
    if (!user) {
      response.redirect("/login");
      return;
    }

    response.redirect(getHomePathForUser(user));
  });

  app.get("/admin", (request, response) => {
    const user = getAuthenticatedUser(request, authService);
    if (!user) {
      response.redirect("/login");
      return;
    }
    if (user.role !== "admin") {
      response.redirect("/viewer");
      return;
    }

    response.sendFile(path.join(uiDir, "admin-panel.html"));
  });

  app.get("/viewer", (request, response) => {
    const user = getAuthenticatedUser(request, authService);
    if (!user) {
      response.redirect("/login");
      return;
    }
    if (user.role === "admin") {
      response.redirect("/admin");
      return;
    }

    response.sendFile(path.join(uiDir, "viewer-panel.html"));
  });

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      mailboxUser: config.graphMailboxUser,
      mailFolder: config.graphMailFolder,
      dataDir: config.dataDir,
      latestRun: buildRunPayload(database.getLatestRunProgress(), ingestionService)
    });
  });

  app.use("/api", (request, response, next) => {
    if (request.path.startsWith("/auth/")) {
      next();
      return;
    }

    const user = getAuthenticatedUser(request, authService);
    if (!user) {
      response.status(401).json({ error: "Authentication required." });
      return;
    }

    response.locals.authUser = user;
    next();
  });

  app.get("/api/dashboard", (_request, response) => {
    response.json({
      status: "ok",
      serverTime: new Date().toISOString(),
      mailboxUser: config.graphMailboxUser,
      mailFolder: config.graphMailFolder,
      pollCron: config.pollCron,
      dataDir: config.dataDir,
      latestRun: buildRunPayload(database.getLatestRunProgress(), ingestionService),
      properties: database.getPropertySummaries(),
      currentUser: getResponseUser(response)
    });
  });

  app.get("/api/users", (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    response.json({ users: authService.listUsers() });
  });

  app.get("/api/settings/approved-senders", (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    response.json(ingestionService.getApprovedSenderPatterns());
  });

  app.put("/api/settings/approved-senders", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const rawPatterns: string[] = Array.isArray(request.body?.patterns)
      ? request.body.patterns
      : parseApprovedSenderPatterns(typeof request.body?.patterns === "string" ? request.body.patterns : "");
    const patterns = rawPatterns.map((entry) => entry.trim());

    try {
      const savedPatterns = ingestionService.updateApprovedSenderPatterns(patterns);
      response.json({
        patterns: savedPatterns,
        source: "database"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof PropertyUpdateError ? 400 : 500).json({ error: message });
    }
  });

  app.get("/api/settings/netsuite", (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    response.json(effectiveNetSuiteConnectionService.getSettings());
  });

  app.put("/api/settings/netsuite", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const serviceBaseUrl = typeof request.body?.serviceBaseUrl === "string" ? request.body.serviceBaseUrl : "";
    const clientId = typeof request.body?.clientId === "string" ? request.body.clientId : "";
    const certificateId = typeof request.body?.certificateId === "string" ? request.body.certificateId : "";
    const jwtAlgorithm = typeof request.body?.jwtAlgorithm === "string" ? request.body.jwtAlgorithm : "";
    const probeQuery = typeof request.body?.probeQuery === "string" ? request.body.probeQuery : "";
    const privateKeyPem = typeof request.body?.privateKeyPem === "string" ? request.body.privateKeyPem : null;
    const clearPrivateKey = request.body?.clearPrivateKey === true;

    try {
      const settings = effectiveNetSuiteConnectionService.updateSettings({
        serviceBaseUrl,
        clientId,
        certificateId,
        jwtAlgorithm,
        probeQuery,
        privateKeyPem,
        clearPrivateKey
      });
      response.json(settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof NetSuiteSettingsError ? 400 : 500).json({ error: message });
    }
  });

  app.post("/api/settings/netsuite/test", async (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    try {
      const lastTest = await effectiveNetSuiteConnectionService.testConnection();
      response.json({ lastTest });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof NetSuiteSettingsError ? 400 : 500).json({ error: message });
    }
  });

  app.post("/api/settings/netsuite/debug/metadata-catalog/export", async (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    try {
      const lastCatalogExport = await effectiveNetSuiteConnectionService.exportMetadataCatalog();
      response.json({
        lastCatalogExport,
        downloadUrl: "/api/settings/netsuite/debug/metadata-catalog/latest"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof NetSuiteSettingsError ? 400 : 500).json({ error: message });
    }
  });

  app.get("/api/settings/netsuite/debug/metadata-catalog/latest", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const download = effectiveNetSuiteConnectionService.getLatestMetadataCatalogDownload();
    if (!download) {
      response.status(404).json({ error: "No NetSuite metadata catalog export exists yet." });
      return;
    }

    response.download(download.absolutePath, download.fileName);
  });

  app.get("/api/netsuite/properties", (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    response.json({
      properties: netSuitePostingService.listProperties()
    });
  });

  app.get("/api/netsuite/properties/:propertySlug", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const attachmentId = request.query.attachmentId === undefined
      ? null
      : Number(request.query.attachmentId);
    const requestedReportType = typeof request.query.reportType === "string"
      ? request.query.reportType
      : null;

    try {
      response.json(
        netSuitePostingService.getWorkspace(
          request.params.propertySlug,
          Number.isInteger(attachmentId) && attachmentId && attachmentId > 0 ? attachmentId : null,
          requestedReportType
        )
      );
    } catch (error) {
      sendNetSuitePostingError(response, error);
    }
  });

  app.put("/api/netsuite/properties/:propertySlug", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const attachmentId = Number(request.body?.attachmentId);
    const mappings = Array.isArray(request.body?.mappings) ? request.body.mappings : [];
    const defaults = isRecord(request.body?.defaults) ? request.body.defaults : {};

    try {
      response.json(
        netSuitePostingService.saveSetup(
          request.params.propertySlug,
          attachmentId,
          mappings.map((entry: Record<string, unknown>) => ({
            mappingKey: typeof entry?.mappingKey === "string" ? entry.mappingKey : "",
            netsuiteGlCode: typeof entry?.netsuiteGlCode === "string" ? entry.netsuiteGlCode : "",
            postingPolarity: typeof entry?.postingPolarity === "string" ? entry.postingPolarity : ""
          })),
          defaults
        )
      );
    } catch (error) {
      sendNetSuitePostingError(response, error);
    }
  });

  app.post("/api/netsuite/properties/:propertySlug/preview", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const attachmentId = Number(request.body?.attachmentId);
    const mappings = Array.isArray(request.body?.mappings) ? request.body.mappings : [];
    const defaults = isRecord(request.body?.defaults) ? request.body.defaults : {};

    try {
      response.json(
        netSuitePostingService.buildPreview(
          request.params.propertySlug,
          attachmentId,
          getResponseUser(response).username,
          mappings.map((entry: Record<string, unknown>) => ({
            mappingKey: typeof entry?.mappingKey === "string" ? entry.mappingKey : "",
            netsuiteGlCode: typeof entry?.netsuiteGlCode === "string" ? entry.netsuiteGlCode : "",
            postingPolarity: typeof entry?.postingPolarity === "string" ? entry.postingPolarity : ""
          })),
          defaults
        )
      );
    } catch (error) {
      sendNetSuitePostingError(response, error);
    }
  });

  app.post("/api/netsuite/properties/:propertySlug/runs/:runId/submit", async (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    try {
      response.json({
        run: await netSuitePostingService.submitRun(request.params.propertySlug, request.params.runId)
      });
    } catch (error) {
      sendNetSuitePostingError(response, error);
    }
  });

  app.post("/api/users", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const username = typeof request.body?.username === "string" ? request.body.username : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    try {
      const user = authService.createViewer(username, password);
      response.status(201).json({ user });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AuthorizationError) {
        response.status(403).json({ error: message });
        return;
      }
      response.status(error instanceof UserManagementError ? 400 : 500).json({ error: message });
    }
  });

  app.patch("/api/users/:userId/password", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const userId = Number(request.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      response.status(400).json({ error: "userId must be a positive integer." });
      return;
    }

    const password = typeof request.body?.password === "string" ? request.body.password : "";

    try {
      const user = authService.updateUserPassword(userId, password);
      response.json({ user });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AuthorizationError) {
        response.status(403).json({ error: message });
        return;
      }
      response.status(error instanceof UserManagementError ? 400 : 500).json({ error: message });
    }
  });

  app.delete("/api/users/:userId", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const userId = Number(request.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      response.status(400).json({ error: "userId must be a positive integer." });
      return;
    }

    try {
      authService.deleteViewer(userId);
      response.status(204).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AuthorizationError) {
        response.status(403).json({ error: message });
        return;
      }
      response.status(error instanceof UserManagementError ? 400 : 500).json({ error: message });
    }
  });

  app.post("/api/ingest/run", (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    try {
      const fullRescan = typeof request.body?.fullRescan === "boolean" ? request.body.fullRescan : true;
      const result = ingestionService.startManualRun({ fullRescan });
      response.status(202).json({
        ...result,
        active: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof IngestionOperationError) {
        response.status(409).json({
          error: message,
          activeRunId: ingestionService.getActiveRunId()
        });
        return;
      }

      response.status(500).json({ error: message });
    }
  });

  app.post("/api/ingest/reparse", async (_request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    try {
      const result = await ingestionService.reparseStoredReports();
      response.status(result.status === "completed" ? 200 : 500).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof ReparseOperationError ? 409 : 500).json({ error: message });
    }
  });

  app.get("/api/runs/latest", (_request, response) => {
    const latestRun = database.getLatestRunProgress();
    if (!latestRun || typeof latestRun.id !== "number") {
      response.status(404).json({ error: "No runs have been recorded yet." });
      return;
    }

    const run = database.getRun(latestRun.id);
    if (!run) {
      response.status(404).json({ error: "Latest run details are unavailable." });
      return;
    }

    response.json(buildRunPayload(run, ingestionService));
  });

  app.get("/api/runs/:runId/progress", (request, response) => {
    const runId = Number(request.params.runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      response.status(400).json({ error: "runId must be a positive integer." });
      return;
    }

    const run = database.getRunProgress(runId);
    if (!run) {
      response.status(404).json({ error: `Run ${runId} was not found.` });
      return;
    }

    response.json(buildRunPayload(run, ingestionService));
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

    response.json(buildRunPayload(run, ingestionService));
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
    if (!requireAdminUser(response)) {
      return;
    }

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
      response.download(latest.latest_path, buildLatestExportDownloadName({
        propertySlug: typeof latest.property_slug === "string" ? latest.property_slug : propertySlug,
        reportType,
        createdAt: typeof latest.created_at === "string" ? latest.created_at : null
      }));
      return;
    }

    response.json(latest);
  });

  app.get("/api/attachments/:attachmentId/file", (request, response) => {
    const attachmentId = Number(request.params.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      response.status(400).json({ error: "attachmentId must be a positive integer." });
      return;
    }

    const attachment = database.getAttachmentById(attachmentId);
    if (!attachment || typeof attachment.archived_path !== "string") {
      response.status(404).json({ error: `Attachment ${attachmentId} was not found.` });
      return;
    }

    const attachmentName = typeof attachment.attachment_name === "string"
      ? attachment.attachment_name
      : `attachment-${attachmentId}`;
    const absolutePath = path.resolve(attachment.archived_path);

    if (request.query.download === "1") {
      response.download(absolutePath, attachmentName);
      return;
    }

    response.sendFile(absolutePath, (error) => {
      if (error && !response.headersSent) {
        const sendError = error as NodeJS.ErrnoException & { statusCode?: number; status?: number };
        response.status(sendError.statusCode || sendError.status || 500).json({ error: sendError.message });
      }
    });
  });

  app.get("/api/attachments/:attachmentId/parsed-json", (request, response) => {
    const attachmentId = Number(request.params.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      response.status(400).json({ error: "attachmentId must be a positive integer." });
      return;
    }

    const attachment = database.getAttachmentById(attachmentId);
    if (!attachment || typeof attachment.parsed_json_path !== "string") {
      response.status(404).json({ error: `Parsed JSON for attachment ${attachmentId} was not found.` });
      return;
    }

    const absolutePath = path.resolve(attachment.parsed_json_path);
    response.sendFile(absolutePath, (error) => {
      if (error && !response.headersSent) {
        const sendError = error as NodeJS.ErrnoException & { statusCode?: number; status?: number };
        response.status(sendError.statusCode || sendError.status || 500).json({ error: sendError.message });
      }
    });
  });

  app.get("/api/attachments/:attachmentId/parsed-csv", (request, response) => {
    const attachmentId = Number(request.params.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      response.status(400).json({ error: "attachmentId must be a positive integer." });
      return;
    }

    const attachment = database.getAttachmentById(attachmentId);
    const reportType = typeof attachment?.report_type === "string" ? attachment.report_type : null;
    if (!attachment || attachment.status !== "parsed" || !reportType || !REPORT_TYPES.includes(reportType as (typeof REPORT_TYPES)[number])) {
      response.status(404).json({ error: `Parsed CSV for attachment ${attachmentId} was not found.` });
      return;
    }

    const rows = database.getAttachmentExportRows(reportType as (typeof REPORT_TYPES)[number], attachmentId);
    const fileName = buildParsedCsvDownloadName({
      propertySlug: typeof attachment.property_slug === "string" ? attachment.property_slug : null,
      reportDate: typeof attachment.report_date === "string" ? attachment.report_date : null,
      receivedAt: typeof attachment.received_at === "string" ? attachment.received_at : null,
      attachmentName: typeof attachment.attachment_name === "string" ? attachment.attachment_name : null,
      reportType
    });

    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    response.send(toCsv(rows, REPORT_EXPORT_COLUMN_MAP[reportType as (typeof REPORT_TYPES)[number]]));
  });

  app.post("/api/attachments/:attachmentId/retry-parse", async (request, response) => {
    if (!requireAdminUser(response)) {
      return;
    }

    const attachmentId = Number(request.params.attachmentId);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      response.status(400).json({ error: "attachmentId must be a positive integer." });
      return;
    }

    try {
      const result = await ingestionService.retryAttachmentParse(attachmentId);
      const propertyPayload = buildPropertyPayload(result.propertySlug, database, ingestionService);
      if (!propertyPayload) {
        response.status(500).json({ error: `Property ${result.propertySlug} could not be reloaded after retry.` });
        return;
      }

      response.json({
        ...result,
        propertyPayload
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(error instanceof AttachmentRetryError ? 400 : 500).json({ error: message });
    }
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

function buildRunPayload(
  run: Record<string, unknown> | null,
  ingestionService: IngestionService
): Record<string, unknown> | null {
  if (!run) {
    return null;
  }

  const runId = typeof run.id === "number" ? run.id : Number(run.id);
  return {
    ...run,
    active: Number.isInteger(runId) && runId > 0
      ? ingestionService.isRunActive(runId)
      : false
  };
}

function readSessionToken(request: express.Request, authService: AuthService): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookieName = authService.sessionCookieName;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

function getAuthenticatedUser(request: express.Request, authService: AuthService): SessionUser | null {
  return authService.getSessionUser(readSessionToken(request, authService));
}

function getHomePathForUser(user: SessionUser): string {
  return user.role === "admin" ? "/admin" : "/viewer";
}

function setSessionCookie(
  response: express.Response,
  authService: AuthService,
  token: string,
  expiresAt: string,
  secure: boolean
): void {
  response.cookie(authService.sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(expiresAt)
  });
}

function clearSessionCookie(response: express.Response, authService: AuthService, secure: boolean): void {
  response.cookie(authService.sessionCookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: new Date(0)
  });
}

function getResponseUser(response: express.Response): SessionUser {
  return response.locals.authUser as SessionUser;
}

function requireAdminUser(response: express.Response): SessionUser | null {
  const user = getResponseUser(response);
  if (user.role !== "admin") {
    response.status(403).json({ error: "Admin access is required for settings changes." });
    return null;
  }

  return user;
}

function sendNetSuitePostingError(response: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NetSuitePostingError) {
    response.status(error.statusCode).json({ error: message });
    return;
  }
  if (error instanceof NetSuiteSettingsError) {
    response.status(400).json({ error: message });
    return;
  }
  response.status(500).json({ error: message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

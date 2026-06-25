import cron from "node-cron";
import { AuthService } from "./auth/AuthService.js";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db/Database.js";
import { createApp } from "./http/createApp.js";
import { NetSuiteConnectionService } from "./services/NetSuiteConnectionService.js";
import { GraphAttachmentSource } from "./sources/GraphAttachmentSource.js";
import { IngestionService } from "./services/IngestionService.js";
import { logger } from "./utils/logger.js";
const config = await loadConfig();
const database = await AppDatabase.open(config.databasePath);
const authService = new AuthService(database);
const source = new GraphAttachmentSource(config);
const ingestionService = new IngestionService(database, source, config.dataDir, config.defaultApprovedSenderPatterns);
const netSuiteConnectionService = new NetSuiteConnectionService(database, config.secretMasterKey, config.dataDir);
const app = createApp(config, database, ingestionService, authService, netSuiteConnectionService);
cron.schedule(config.pollCron, async () => {
    logger.info("Starting scheduled mailbox poll");
    const result = await ingestionService.run("scheduled");
    logger.info("Scheduled mailbox poll finished", {
        runId: result.runId,
        status: result.status,
        summary: result.summary
    });
});
app.listen(config.port, config.bindHost, () => {
    logger.info("Mailbox ingestion server listening", {
        bindHost: config.bindHost,
        port: config.port,
        mailboxUser: config.graphMailboxUser,
        mailFolder: config.graphMailFolder
    });
});

import cron from "node-cron";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./db/Database.js";
import { createApp } from "./http/createApp.js";
import { GraphAttachmentSource } from "./sources/GraphAttachmentSource.js";
import { IngestionService } from "./services/IngestionService.js";
import { logger } from "./utils/logger.js";

const config = await loadConfig();
const database = await AppDatabase.open(config.databasePath);
const source = new GraphAttachmentSource(config);
const ingestionService = new IngestionService(database, source, config.dataDir);
const app = createApp(config, database, ingestionService);

cron.schedule(config.pollCron, async () => {
  logger.info("Starting scheduled mailbox poll");
  const result = await ingestionService.run("scheduled");
  logger.info("Scheduled mailbox poll finished", {
    runId: result.runId,
    status: result.status,
    summary: result.summary
  });
});

app.listen(config.port, () => {
  logger.info("Mailbox ingestion server listening", {
    port: config.port,
    mailboxUser: config.graphMailboxUser,
    mailFolder: config.graphMailFolder
  });
});

import path from "node:path";
import { loadDotEnv } from "./utils/env.js";

export interface AppConfig {
  port: number;
  graphTenantId: string;
  graphClientId: string;
  graphClientSecret: string;
  graphMailboxUser: string;
  graphMailFolder: string;
  pollCron: string;
  dataDir: string;
  databasePath: string;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function loadConfig(): Promise<AppConfig> {
  await loadDotEnv();

  const dataDir = path.resolve(process.env.SYNCHRO_DATA_DIR ?? "./storage");

  return {
    port: Number(process.env.PORT ?? "3000"),
    graphTenantId: required("SYNCHRO_GRAPH_TENANT_ID", process.env.SYNCHRO_GRAPH_TENANT_ID),
    graphClientId: required("SYNCHRO_GRAPH_CLIENT_ID", process.env.SYNCHRO_GRAPH_CLIENT_ID),
    graphClientSecret: required("SYNCHRO_GRAPH_CLIENT_SECRET", process.env.SYNCHRO_GRAPH_CLIENT_SECRET),
    graphMailboxUser: process.env.SYNCHRO_GRAPH_MAILBOX_USER ?? "auditor@eternalhotels.com",
    graphMailFolder: process.env.SYNCHRO_GRAPH_MAIL_FOLDER ?? "Inbox",
    pollCron: process.env.SYNCHRO_POLL_CRON ?? "0 * * * *",
    dataDir,
    databasePath: path.join(dataDir, "synchro-ingestion.sqlite")
  };
}

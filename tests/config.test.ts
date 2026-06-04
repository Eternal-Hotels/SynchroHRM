import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("loadConfig honors SYNCHRO_BIND_HOST when dotenv loading is disabled", async () => {
  const restoreEnv = snapshotEnv([
    "SYNCHRO_SKIP_DOTENV",
    "SYNCHRO_BIND_HOST",
    "SYNCHRO_GRAPH_TENANT_ID",
    "SYNCHRO_GRAPH_CLIENT_ID",
    "SYNCHRO_GRAPH_CLIENT_SECRET",
    "SYNCHRO_GRAPH_MAILBOX_USER",
    "SYNCHRO_GRAPH_MAIL_FOLDER",
    "SYNCHRO_POLL_CRON",
    "SYNCHRO_DATA_DIR",
    "PORT"
  ]);

  try {
    process.env.SYNCHRO_SKIP_DOTENV = "1";
    process.env.SYNCHRO_BIND_HOST = "127.0.0.1";
    process.env.SYNCHRO_GRAPH_TENANT_ID = "tenant";
    process.env.SYNCHRO_GRAPH_CLIENT_ID = "client";
    process.env.SYNCHRO_GRAPH_CLIENT_SECRET = "secret";
    process.env.SYNCHRO_GRAPH_MAILBOX_USER = "auditor@eternalhotels.com";
    process.env.SYNCHRO_GRAPH_MAIL_FOLDER = "Inbox";
    process.env.SYNCHRO_POLL_CRON = "0 * * * *";
    process.env.SYNCHRO_DATA_DIR = "./storage";
    process.env.PORT = "3000";

    const config = await loadConfig();
    assert.equal(config.bindHost, "127.0.0.1");
  } finally {
    restoreEnv();
  }
});

function snapshotEnv(keys: string[]): () => void {
  const values = new Map(keys.map((key) => [key, process.env[key]]));

  return () => {
    for (const [key, value] of values) {
      if (typeof value === "undefined") {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

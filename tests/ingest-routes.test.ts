import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../src/config.js";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { IngestionService } from "../src/services/IngestionService.js";
import type { MailAttachmentSource, PullAttachmentsResult } from "../src/types.js";

test("manual rescan starts in the background and can be polled by run id", async () => {
  const pullStarted = createDeferred<void>();
  const releasePull = createDeferred<void>();
  const context = await createRouteTestContext({
    async pullAttachments(_deltaToken: string | null): Promise<PullAttachmentsResult> {
      pullStarted.resolve();
      await releasePull.promise;
      return {
        attachments: [],
        nextDeltaToken: "delta-after-test",
        deltaWasReset: false,
        messagesSeen: 0
      };
    }
  });

  try {
    const adminCookie = await loginAdmin(context.baseUrl);
    const startResponse = await fetch(`${context.baseUrl}/api/ingest/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie
      },
      body: JSON.stringify({ fullRescan: true })
    });
    assert.equal(startResponse.status, 202);
    const startPayload = await startResponse.json() as Record<string, unknown>;
    assert.equal(startPayload.status, "running");
    assert.equal(startPayload.triggerSource, "manual");
    assert.equal(startPayload.active, true);
    assert.ok(Number.isInteger(startPayload.runId));

    const runId = Number(startPayload.runId);
    await pullStarted.promise;

    const latestRun = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/latest`, adminCookie);
    assert.equal(latestRun.id, runId);
    assert.equal(latestRun.status, "running");
    assert.equal(latestRun.active, true);

    const runById = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/${runId}`, adminCookie);
    assert.equal(runById.id, runId);
    assert.equal(runById.status, "running");
    assert.equal(runById.active, true);

    const conflictResponse = await fetch(`${context.baseUrl}/api/ingest/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie
      },
      body: JSON.stringify({ fullRescan: true })
    });
    assert.equal(conflictResponse.status, 409);
    const conflictPayload = await conflictResponse.json() as Record<string, unknown>;
    assert.equal(conflictPayload.activeRunId, runId);
    assert.match(String(conflictPayload.error ?? ""), /active inbox sync|another rescan/i);

    releasePull.resolve();

    const completedRun = await waitForRun(context.baseUrl, adminCookie, runId, (run) => run.status !== "running");
    assert.equal(completedRun.status, "completed");
    assert.equal(completedRun.active, false);

    const dashboard = await fetchJsonAbsolute(`${context.baseUrl}/api/dashboard`, adminCookie);
    assert.equal(dashboard.latestRun.id, runId);
    assert.equal(dashboard.latestRun.status, "completed");
    assert.equal(dashboard.latestRun.active, false);
  } finally {
    releasePull.resolve();
    await context.dispose();
  }
});

async function createRouteTestContext(source: MailAttachmentSource): Promise<{
  baseUrl: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-ingest-routes-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
  const authService = new AuthService(database);
  const adminUser = database.getUserByUsername("admin");
  assert.ok(adminUser);
  authService.updateUserPassword(Number(adminUser.id), "AdminPass123!");

  const service = new IngestionService(database, source, dataDir);
  const app = createApp(mockConfig(), database, service, authService);
  const server = await listen(app);
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dispose: async () => {
      await closeServer(server);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function loginAdmin(baseUrl: string): Promise<string> {
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      authorizedUserConfirmed: true,
      username: "admin",
      password: "AdminPass123!"
    })
  });
  assert.equal(loginResponse.status, 200);
  return extractCookie(String(loginResponse.headers.get("set-cookie") ?? ""));
}

async function waitForRun(
  baseUrl: string,
  cookie: string,
  runId: number,
  predicate: (run: Record<string, any>) => boolean
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await fetchJsonAbsolute(`${baseUrl}/api/runs/${runId}`, cookie);
    if (predicate(run)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Run ${runId} did not reach the expected status in time.`);
}

function mockConfig(): AppConfig {
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    graphTenantId: "tenant",
    graphClientId: "client",
    graphClientSecret: "secret",
    graphMailboxUser: "auditor@eternalhotels.com",
    graphMailFolder: "Inbox",
    pollCron: "0 * * * *",
    dataDir: "./storage",
    databasePath: "./storage/app.sqlite",
    defaultApprovedSenderPatterns: [],
    secretMasterKey: null
  };
}

async function fetchJsonAbsolute(url: string, cookie?: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: cookie ? { cookie } : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload as Record<string, any>;
}

function extractCookie(header: string): string {
  return header.split(";")[0] ?? "";
}

function createDeferred<T>() {
  let settled = false;
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    rejectPromise = (reason) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(reason);
    };
  });

  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
    reject: (reason?: unknown) => rejectPromise(reason)
  };
}

async function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  return await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

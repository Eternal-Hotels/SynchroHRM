import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AppConfig } from "../src/config.js";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { IngestionService } from "../src/services/IngestionService.js";

test("production auth routes mark session cookies as Secure", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  const context = await createRouteTestContext();

  try {
    const loginResponse = await fetch(`${context.baseUrl}/api/auth/login`, {
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
    const loginCookie = String(loginResponse.headers.get("set-cookie") ?? "");
    assert.match(loginCookie, /;\s*Secure/i);

    const logoutResponse = await fetch(`${context.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: extractCookie(loginCookie)
      }
    });
    assert.equal(logoutResponse.status, 204);
    const logoutCookie = String(logoutResponse.headers.get("set-cookie") ?? "");
    assert.match(logoutCookie, /;\s*Secure/i);
  } finally {
    if (typeof originalNodeEnv === "undefined") {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    await context.dispose();
  }
});

test("non-admin users can only change their own password while the primary admin can reset any account", async () => {
  const context = await createRouteTestContext();

  try {
    const viewer = context.authService.createViewer("viewer.ops", "ViewerPass123!");
    const adminUser = context.database.getUserByUsername("admin");
    assert.ok(adminUser);

    const viewerCookie = await login(context.baseUrl, "viewer.ops", "ViewerPass123!");
    const forbiddenResponse = await fetch(`${context.baseUrl}/api/users/${adminUser.id}/password`, {
      method: "PATCH",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ password: "BlockedPass123!" })
    });
    assert.equal(forbiddenResponse.status, 403);
    const forbiddenPayload = await forbiddenResponse.json() as { error: string };
    assert.match(forbiddenPayload.error, /own password/i);

    const ownPasswordResponse = await fetch(`${context.baseUrl}/api/users/${viewer.id}/password`, {
      method: "PATCH",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ password: "ViewerPass456!" })
    });
    assert.equal(ownPasswordResponse.status, 200);

    const oldLoginResponse = await fetch(`${context.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        authorizedUserConfirmed: true,
        username: "viewer.ops",
        password: "ViewerPass123!"
      })
    });
    assert.equal(oldLoginResponse.status, 401);

    const newViewerCookie = await login(context.baseUrl, "viewer.ops", "ViewerPass456!");
    assert.ok(newViewerCookie);

    const adminCookie = await login(context.baseUrl, "admin", "AdminPass123!");
    const adminResetResponse = await fetch(`${context.baseUrl}/api/users/${viewer.id}/password`, {
      method: "PATCH",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({ password: "ViewerPass789!" })
    });
    assert.equal(adminResetResponse.status, 200);

    const resetViewerCookie = await login(context.baseUrl, "viewer.ops", "ViewerPass789!");
    assert.ok(resetViewerCookie);
  } finally {
    await context.dispose();
  }
});

async function createRouteTestContext(): Promise<{
  baseUrl: string;
  authService: AuthService;
  database: AppDatabase;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-auth-routes-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
  const authService = new AuthService(database);
  const adminUser = database.getUserByUsername("admin");
  assert.ok(adminUser);
  authService.updateUserPassword(Number(adminUser.id), "AdminPass123!");

  const service = new IngestionService(database, {
    async pullAttachments() {
      return {
        attachments: [],
        nextDeltaToken: null,
        deltaWasReset: false,
        messagesSeen: 0
      };
    }
  }, dataDir);

  const app = createApp(mockConfig(), database, service, authService);
  const server = await listen(app);
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    authService,
    database,
    dispose: async () => {
      await closeServer(server);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
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

function extractCookie(header: string): string {
  return header.split(";")[0] ?? "";
}

async function login(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      authorizedUserConfirmed: true,
      username,
      password
    })
  });
  assert.equal(response.status, 200);
  return extractCookie(String(response.headers.get("set-cookie") ?? ""));
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

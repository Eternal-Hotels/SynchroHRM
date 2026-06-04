import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AppConfig } from "../src/config.js";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { NetSuiteConnectionService } from "../src/services/NetSuiteConnectionService.js";
import { IngestionService } from "../src/services/IngestionService.js";

const ADMIN_PASSWORD = "AdminPass123!";
const VIEWER_PASSWORD = "ViewerPass123!";
const PRIVATE_KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048
}).privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();

test("NetSuite settings routes stay admin-only", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(200, { access_token: "unused" })
  });

  try {
    const unauthenticated = await fetch(`${context.baseUrl}/api/settings/netsuite`);
    assert.equal(unauthenticated.status, 401);

    const viewerCookie = await login(context.baseUrl, "viewer.ops", VIEWER_PASSWORD);
    const viewerGet = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerGet.status, 403);

    const viewerPut = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(viewerPut.status, 403);

    const viewerTest = await fetch(`${context.baseUrl}/api/settings/netsuite/test`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerTest.status, 403);

    const viewerExport = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/export`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerExport.status, 403);

    const viewerLatest = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/latest`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerLatest.status, 403);
  } finally {
    await context.dispose();
  }
});

test("GET redacts the private key while PUT saves and clears encrypted state", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(200, { access_token: "unused" })
  });

  try {
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const saveResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveResponse.status, 200);

    const encryptedKey = context.database.getNetSuiteEncryptedPrivateKey();
    assert.ok(encryptedKey);
    assert.equal(encryptedKey.includes("BEGIN PRIVATE KEY"), false);

    const getResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(getResponse.status, 200);
    const getPayload = await getResponse.json() as Record<string, unknown>;
    assert.equal(getPayload.hasPrivateKey, true);
    assert.equal("privateKeyPem" in getPayload, false);
    assert.match(String(getPayload.maskedClientId || ""), /^\w{4}\*\*\*/);

    const clearResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...buildSettingsPayload(),
        privateKeyPem: "",
        clearPrivateKey: true
      })
    });
    assert.equal(clearResponse.status, 200);
    assert.equal(context.database.getNetSuiteEncryptedPrivateKey(), null);
  } finally {
    await context.dispose();
  }
});

test("POST /api/settings/netsuite/test persists the sanitized proof-of-life summary", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const context = await createRouteTestContext({
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return mockResponse(200, { access_token: "token-123" });
      }

      return mockResponse(200, {
        count: 1,
        totalResults: 1,
        items: [{ id: "200" }]
      });
    }
  });

  try {
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const saveResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveResponse.status, 200);

    const testResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/test`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(testResponse.status, 200);
    const payload = await testResponse.json() as { lastTest: Record<string, unknown> };
    assert.equal(payload.lastTest.status, "success");
    assert.deepEqual(payload.lastTest.columnNames, ["id"]);

    const persisted = context.database.getNetSuiteLastTest();
    assert.ok(persisted);
    assert.equal(persisted?.status, "success");
    assert.deepEqual(persisted?.columnNames, ["id"]);
    assert.equal((requests[1]?.init?.headers as Record<string, string>).prefer, "transient");
  } finally {
    await context.dispose();
  }
});

test("metadata catalog export writes the latest CSV and persists the latest schema snapshot summary", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const context = await createRouteTestContext({
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return mockResponse(200, { access_token: "token-123" });
      }
      if (requests.length === 2) {
        return mockResponse(200, {
          items: [
            {
              name: "customer",
              links: [
                {
                  rel: "canonical",
                  href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer",
                  mediaType: "application/json"
                },
                {
                  rel: "alternate",
                  href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer",
                  mediaType: "application/schema+json"
                }
              ]
            },
            {
              name: "account",
              links: [
                {
                  rel: "canonical",
                  href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/account",
                  mediaType: "application/json"
                },
                {
                  rel: "alternate",
                  href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/account",
                  mediaType: "application/schema+json"
                }
              ]
            }
          ]
        });
      }

      const url = String(input);
      if (url.endsWith("/customer")) {
        return mockResponse(200, {
          type: "object",
          properties: {
            entityId: {
              type: "string"
            }
          }
        });
      }

      return mockResponse(200, {
        type: "object",
        properties: {
          id: {
            type: "integer"
          }
        }
      });
    }
  });

  try {
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const saveResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveResponse.status, 200);

    const exportResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/export`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(exportResponse.status, 200);
    const exportPayload = await exportResponse.json() as {
      lastCatalogExport: Record<string, unknown>;
      downloadUrl: string;
    };
    assert.equal(exportPayload.lastCatalogExport.status, "success");
    assert.equal(exportPayload.lastCatalogExport.rowCount, 2);
    assert.equal(exportPayload.lastCatalogExport.schemaFileCount, 2);
    assert.equal(exportPayload.downloadUrl, "/api/settings/netsuite/debug/metadata-catalog/latest");

    const persisted = context.database.getNetSuiteLastCatalogExport();
    assert.ok(persisted);
    assert.equal(persisted?.status, "success");
    assert.equal(persisted?.rowCount, 2);
    assert.equal(persisted?.schemaFileCount, 2);

    const latestResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/latest`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(latestResponse.status, 200);
    const latestCsv = await latestResponse.text();
    assert.match(latestCsv, /record_type,canonical_href,openapi_href,json_schema_href,describes_href,captured_at/);
    assert.match(latestCsv, /^account,/m);
    assert.match(latestCsv, /^customer,/m);
    assert.match(String(latestResponse.headers.get("content-disposition") || ""), /netsuite_metadata_catalog_/);
  } finally {
    await context.dispose();
  }
});

test("metadata catalog latest download returns 404 before the first export and export requires a saved private key", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(200, { access_token: "unused" })
  });

  try {
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const latestResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/latest`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(latestResponse.status, 404);

    const saveResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...buildSettingsPayload(),
        privateKeyPem: ""
      })
    });
    assert.equal(saveResponse.status, 200);

    const exportResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/export`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(exportResponse.status, 400);
  } finally {
    await context.dispose();
  }
});

test("missing master key disables NetSuite mutation routes while GET stays descriptive", async () => {
  const context = await createRouteTestContext({
    masterKey: null,
    fetchImpl: async () => mockResponse(200, { access_token: "unused" })
  });

  try {
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const getResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      headers: { cookie: adminCookie }
    });
    const getPayload = await getResponse.json() as Record<string, unknown>;
    assert.equal(getPayload.masterKeyConfigured, false);
    assert.match(String(getPayload.availabilityError || ""), /SYNCHRO_SECRET_MASTER_KEY/i);

    const saveResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveResponse.status, 400);

    const testResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/test`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(testResponse.status, 400);

    const exportResponse = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/export`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(exportResponse.status, 400);
  } finally {
    await context.dispose();
  }
});

async function createRouteTestContext(options: {
  masterKey?: string | null;
  fetchImpl: typeof fetch;
}): Promise<{
  baseUrl: string;
  database: AppDatabase;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-netsuite-routes-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
  const authService = new AuthService(database);
  const adminUser = database.getUserByUsername("admin");
  assert.ok(adminUser);
  authService.updateUserPassword(Number(adminUser.id), ADMIN_PASSWORD);
  authService.createViewer("viewer.ops", VIEWER_PASSWORD);

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
  const hasExplicitMasterKey = Object.prototype.hasOwnProperty.call(options, "masterKey");
  const config = mockConfig(hasExplicitMasterKey ? (options.masterKey ?? null) : randomBytes(32).toString("base64"));
  const netSuiteConnectionService = new NetSuiteConnectionService(database, config.secretMasterKey, dataDir, options.fetchImpl);
  const app = createApp(config, database, service, authService, netSuiteConnectionService);
  const server = await listen(app);
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    database,
    dispose: async () => {
      await closeServer(server);
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function mockConfig(secretMasterKey: string | null): AppConfig {
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
    secretMasterKey
  };
}

function buildSettingsPayload() {
  return {
    serviceBaseUrl: "https://1234567.suitetalk.api.netsuite.com",
    clientId: "client-id-1234",
    certificateId: "cert-4567",
    jwtAlgorithm: "PS256",
    probeQuery: "SELECT id FROM Account",
    privateKeyPem: PRIVATE_KEY_PEM,
    clearPrivateKey: false
  };
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
  const cookie = extractCookie(response.headers.get("set-cookie"));
  assert.ok(cookie);
  return cookie;
}

function extractCookie(header: string | null): string {
  return String(header ?? "").split(";")[0];
}

function mockResponse(status: number, payload: unknown): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return mockResponse(status, payload);
    },
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  } as Response;
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

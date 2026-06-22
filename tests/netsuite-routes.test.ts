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
import type { ReportType } from "../src/types.js";

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

test("NetSuite posting routes stay admin-only", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(200, { access_token: "unused" })
  });

  try {
    const unauthenticated = await fetch(`${context.baseUrl}/api/netsuite/properties`);
    assert.equal(unauthenticated.status, 401);

    const viewerCookie = await login(context.baseUrl, "viewer.ops", VIEWER_PASSWORD);
    const viewerList = await fetch(`${context.baseUrl}/api/netsuite/properties`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerList.status, 403);

    const viewerWorkspace = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerWorkspace.status, 403);

    const viewerSave = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property`, {
      method: "PUT",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: 1,
        mappings: [],
        defaults: {}
      })
    });
    assert.equal(viewerSave.status, 403);

    const viewerPreview = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property/preview`, {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: 1,
        mappings: [],
        defaults: {}
      })
    });
    assert.equal(viewerPreview.status, 403);

    const viewerSubmit = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property/runs/test-run/submit`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerSubmit.status, 403);
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace discovers monetary rows, saves setup, builds a balanced preview, and submits it", async () => {
  let requestCount = 0;
  const context = await createRouteTestContext({
    fetchImpl: async (input) => {
      requestCount += 1;
      const url = String(input);
      if (url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        return mockResponse(200, { access_token: `token-${requestCount}` });
      }
      if (url.includes("/services/rest/query/v1/suiteql")) {
        return mockResponse(200, {
          items: [
            { id: "101", acctnumber: "4000" },
            { id: "202", acctnumber: "2100" },
            { id: "303", acctnumber: "9999" }
          ]
        });
      }
      if (url.endsWith("/services/rest/record/v1/journalEntry")) {
        return mockResponse(201, {
          id: "9981",
          tranId: "JE1001"
        }, {
          location: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry/9981"
        });
      }
      return mockResponse(404, { error: "Unexpected request" });
    }
  });

  try {
    const attachmentRecordId = seedParsedAttachment(context.database, {
      propertyName: "Holiday Inn Express Pendleton",
      propertySlug: "holiday-inn-express-pendleton",
      reportType: "all_transaction_rows",
      reportTitle: "All Transactions",
      reportDate: "2026-05-22",
      attachmentName: "May 22, 2026-all-transactions.pdf",
      rows: [
        {
          section: "Reservations",
          transaction_date: "2026-05-22",
          transaction_time: "12:28:05",
          confirmation_no: "20645151",
          guest_name: "DAUER JOEL",
          room_number: "221",
          folio_number: "015316",
          transaction_code: "RR",
          transaction_description: "Guest",
          last_four_digits: null,
          transaction_type: "CHARGE",
          charge_type: "ROOM",
          amount: "149.00",
          username: "systemuser",
          note: "ROOM RENT"
        },
        {
          section: "Reservations",
          transaction_date: "2026-05-22",
          transaction_time: "12:28:05",
          confirmation_no: "20645151",
          guest_name: "DAUER JOEL",
          room_number: "221",
          folio_number: "015316",
          transaction_code: "CT",
          transaction_description: "City Tax",
          last_four_digits: null,
          transaction_type: "TAX",
          charge_type: "ROOM",
          amount: "11.92",
          username: "systemuser",
          note: "RENT"
        }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "Holiday Inn Express Pendleton",
      propertySlug: "holiday-inn-express-pendleton",
      reportType: "closed_folio_balance_rows",
      reportTitle: "Closed Folio Balances",
      reportDate: "2026-05-21",
      attachmentName: "closed-folio-balances.pdf",
      rows: [
        {
          section: "Closed Folio Balances",
          row_kind: "summary",
          summary_label: "City Ledger",
          guest_name: null,
          company_name: null,
          metric_name: null,
          net_change: "250.00",
          metric_value: null
        }
      ]
    });
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);

    const listResponse = await fetch(`${context.baseUrl}/api/netsuite/properties`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as { properties: Array<Record<string, unknown>> };
    assert.equal(listPayload.properties.length, 1);
    assert.equal(listPayload.properties[0]?.property_slug, "holiday-inn-express-pendleton");
    assert.deepEqual(
      (listPayload.properties[0]?.supportedReportTypes as Array<Record<string, unknown>>).map((entry) => entry.reportType),
      ["all_transaction_rows", "closed_folio_balance_rows"]
    );

    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-pendleton?attachmentId=${attachmentRecordId}`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    assert.equal((workspacePayload.selectedAttachment as Record<string, unknown>).attachmentId, attachmentRecordId);
    assert.equal(Array.isArray(workspacePayload.mappings), true);
    assert.equal((workspacePayload.mappings as Array<Record<string, unknown>>).length, 2);
    assert.equal((workspacePayload.discoverySummary as Record<string, unknown>).supportedReportTypeCount, 2);

    const filteredWorkspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-pendleton?reportType=closed_folio_balance_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(filteredWorkspaceResponse.status, 200);
    const filteredWorkspacePayload = await filteredWorkspaceResponse.json() as Record<string, unknown>;
    assert.equal(filteredWorkspacePayload.selectedReportType, "closed_folio_balance_rows");
    assert.equal((filteredWorkspacePayload.selectedAttachment as Record<string, unknown>).reportType, "closed_folio_balance_rows");
    assert.equal((filteredWorkspacePayload.availableReportTypes as Array<Record<string, unknown>>).length, 2);

    const saveResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-pendleton`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: attachmentRecordId,
        mappings: [
          {
            mappingKey: "all_transaction_rows:amount:reservations:charge:room:rr:guest",
            netsuiteGlCode: "4000",
            postingPolarity: "credit_positive"
          },
          {
            mappingKey: "all_transaction_rows:amount:reservations:tax:room:ct:city_tax",
            netsuiteGlCode: "2100",
            postingPolarity: "credit_positive"
          }
        ],
        defaults: {
          externalIdPrefix: "hiep",
          balancingGlCode: "9999",
          memoTemplate: "Synchro HRM {propertyName} {reportDate}",
          subsidiaryId: "7"
        }
      })
    });
    assert.equal(saveResponse.status, 200);
    const savedWorkspace = await saveResponse.json() as Record<string, unknown>;
    assert.equal((savedWorkspace.defaults as Record<string, unknown>).balancingGlCode, "9999");
    assert.equal((savedWorkspace.defaults as Record<string, unknown>).subsidiaryId, "7");

    const previewResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-pendleton/preview`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: attachmentRecordId,
        mappings: [
          {
            mappingKey: "all_transaction_rows:amount:reservations:charge:room:rr:guest",
            netsuiteGlCode: "4000",
            postingPolarity: "credit_positive"
          },
          {
            mappingKey: "all_transaction_rows:amount:reservations:tax:room:ct:city_tax",
            netsuiteGlCode: "2100",
            postingPolarity: "credit_positive"
          }
        ],
        defaults: {
          externalIdPrefix: "hiep",
          balancingGlCode: "9999",
          memoTemplate: "Synchro HRM {propertyName} {reportDate}",
          subsidiaryId: "7"
        }
      })
    });
    assert.equal(previewResponse.status, 200);
    const previewPayload = await previewResponse.json() as {
      run: Record<string, unknown>;
      workspace: Record<string, unknown>;
    };
    assert.equal(previewPayload.run.status, "preview");
    const previewRunPayload = previewPayload.run.previewPayload as Record<string, unknown>;
    const previewSummary = previewRunPayload.summary as Record<string, unknown>;
    assert.equal(previewSummary.postable, true);
    assert.equal(previewSummary.lineCount, 3);

    const saveSettingsResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveSettingsResponse.status, 200);

    const submitResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-pendleton/runs/${encodeURIComponent(String(previewPayload.run.id))}/submit`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(submitResponse.status, 200);
    const submitPayload = await submitResponse.json() as { run: Record<string, unknown> };
    assert.equal(submitPayload.run.status, "submitted");
    assert.match(String(submitPayload.run.netsuite_response_summary || ""), /JE1001/);
    assert.equal((submitPayload.run.netsuiteResponsePayload as Record<string, unknown>).id, "9981");
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

function seedParsedAttachment(
  database: AppDatabase,
  options: {
    propertyName: string;
    propertySlug: string;
    reportType: ReportType;
    reportTitle: string;
    reportDate: string;
    attachmentName: string;
    rows: Array<Record<string, string | number | null>>;
  }
): number {
  const runId = database.createRun("test");
  const graphMessageId = `message-${randomBytes(6).toString("hex")}`;
  const graphAttachmentId = `attachment-${randomBytes(6).toString("hex")}`;
  const receivedAt = `${options.reportDate}T09:00:00.000Z`;

  database.upsertMessage({
    graphMessageId,
    internetMessageId: `<${graphMessageId}@example.test>`,
    subject: options.attachmentName,
    senderEmail: "auditor@eternalhotels.com",
    receivedAt,
    webLink: null
  });

  const attachmentRecordId = database.insertAttachment({
    graphMessageId,
    graphAttachmentId,
    internetMessageId: `<${graphMessageId}@example.test>`,
    sourceMailbox: "auditor@eternalhotels.com",
    receivedAt,
    attachmentName: options.attachmentName,
    propertyName: options.propertyName,
    propertySlug: options.propertySlug,
    extension: ".pdf",
    contentType: "application/pdf",
    archivedPath: path.join("C:\\archive", options.propertySlug, options.attachmentName),
    status: "parsed",
    ingestRunId: runId
  });

  database.updateAttachment(attachmentRecordId, {
    status: "parsed",
    propertyName: options.propertyName,
    propertySlug: options.propertySlug,
    reportType: options.reportType,
    reportTitle: options.reportTitle,
    reportDate: options.reportDate
  });

  database.insertParsedReport(runId, attachmentRecordId, {
    sourceMailbox: "auditor@eternalhotels.com",
    graphMessageId,
    internetMessageId: `<${graphMessageId}@example.test>`,
    receivedAt,
    attachmentId: graphAttachmentId,
    attachmentName: options.attachmentName,
    propertyName: options.propertyName,
    propertySlug: options.propertySlug
  }, {
    reportType: options.reportType,
    reportTitle: options.reportTitle,
    reportDate: options.reportDate,
    propertyName: options.propertyName,
    propertySlug: options.propertySlug,
    rows: options.rows
  });

  database.finishRun(runId, "completed", {
    messagesSeen: 1,
    attachmentsSeen: 1,
    attachmentsApproved: 1,
    attachmentsNotApproved: 0,
    attachmentsArchived: 1,
    attachmentsParsed: 1,
    attachmentsDeferred: 0,
    attachmentsFailed: 0,
    notes: []
  });

  return attachmentRecordId;
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

function mockResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? headers[name] ?? null;
      }
    },
    clone() {
      return mockResponse(status, payload, headers);
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

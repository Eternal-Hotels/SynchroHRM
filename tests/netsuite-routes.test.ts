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

test("NetSuite settings routes are available to any authenticated console user", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        return mockResponse(200, { access_token: "viewer-token" });
      }
      if (url.includes("/services/rest/query/v1/suiteql")) {
        return mockResponse(200, {
          count: 1,
          totalResults: 1,
          items: [{ id: "200" }]
        });
      }
      if (url.includes("/services/rest/record/v1/metadata-catalog")) {
        if (url.endsWith("/metadata-catalog")) {
          return mockResponse(200, {
            items: [
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

        return mockResponse(200, {
          type: "object",
          properties: {
            id: {
              type: "integer"
            }
          }
        });
      }

      return mockResponse(200, { access_token: "viewer-token" });
    }
  });

  try {
    const unauthenticated = await fetch(`${context.baseUrl}/api/settings/netsuite`);
    assert.equal(unauthenticated.status, 401);

    const viewerCookie = await login(context.baseUrl, "viewer.ops", VIEWER_PASSWORD);
    const viewerGet = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerGet.status, 200);

    const viewerPut = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(viewerPut.status, 200);

    const viewerTest = await fetch(`${context.baseUrl}/api/settings/netsuite/test`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerTest.status, 200);

    const viewerExport = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/export`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerExport.status, 200);

    const viewerLatest = await fetch(`${context.baseUrl}/api/settings/netsuite/debug/metadata-catalog/latest`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerLatest.status, 200);
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

test("NetSuite posting routes are available to any authenticated console user", async () => {
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
    assert.equal(viewerList.status, 200);

    const viewerWorkspace = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property`, {
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerWorkspace.status, 404);

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
    assert.equal(viewerSave.status, 404);

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
    assert.equal(viewerPreview.status, 404);

    const viewerSync = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property/statistical-accounts/sync`, {
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
    assert.equal(viewerSync.status, 404);

    const viewerSubmit = await fetch(`${context.baseUrl}/api/netsuite/properties/test-property/runs/test-run/submit`, {
      method: "POST",
      headers: { cookie: viewerCookie }
    });
    assert.equal(viewerSubmit.status, 404);
  } finally {
    await context.dispose();
  }
});

test("NetSuite statistical workspace syncs accounts, builds previews, and submits statistical journals across parsed properties", async () => {
  const createdAccounts: Array<{ id: string; acctNumber: string; acctName: string; externalId: string }> = [];
  let tokenCounter = 0;
  let accountCounter = 0;
  let journalCounter = 0;
  const context = await createRouteTestContext({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        tokenCounter += 1;
        return mockResponse(200, { access_token: `token-${tokenCounter}` });
      }
      if (url.includes("/services/rest/query/v1/suiteql")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { q?: string } : {};
        const query = String(body.q || "");
        const items = createdAccounts.filter((entry) => query.includes(entry.acctNumber) || query.includes(entry.externalId)).map((entry) => ({
          id: entry.id,
          acctnumber: entry.acctNumber,
          acctname: entry.acctName,
          externalid: entry.externalId
        }));
        return mockResponse(200, { items });
      }
      if (url.endsWith("/services/rest/record/v1/account")) {
        accountCounter += 1;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        const account = {
          id: `700${accountCounter}`,
          acctNumber: String(body.acctNumber || ""),
          acctName: String(body.acctName || ""),
          externalId: String(body.externalId || "")
        };
        createdAccounts.push(account);
        return mockResponse(201, account, {
          location: `https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/account/${account.id}`
        });
      }
      if (url.endsWith("/services/rest/record/v1/statisticaljournalentry")) {
        journalCounter += 1;
        return mockResponse(201, {
          id: `990${journalCounter}`,
          tranId: `SJ10${journalCounter}`
        }, {
          location: `https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/statisticaljournalentry/990${journalCounter}`
        });
      }
      return mockResponse(404, { error: "Unexpected request" });
    }
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "credit_card_transaction_rows",
      reportTitle: "Credit Card Transactions",
      reportDate: "2026-05-31",
      attachmentName: "CreditCardBatchReport.pdf",
      rows: [
        { card_type: "VS", charge_amount: "200.00", credit_amount: "0.00", transaction_status: "Settled" },
        { card_type: "MC", charge_amount: "18.75", credit_amount: "0.00", transaction_status: "Settled" },
        { card_type: "VS", charge_amount: "0.00", credit_amount: "25.00", transaction_status: "Settled" }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "best_western_daily_report_rows",
      reportTitle: "Daily Report",
      reportDate: "2026-05-31",
      attachmentName: "DailyReport.pdf",
      rows: [
        { section: "Statistical Recap", row_kind: "metric", metric_name: "Occupied", today_value: "23", mtd_value: "949", ytd_value: "3789" },
        { section: "Statistical Recap", row_kind: "metric", metric_name: "No Show", today_value: "0", mtd_value: "2", ytd_value: "25" },
        { section: "Detail Listing", subsection: "Guest Ledger", group_name: "GL ROOM REV", row_kind: "detail", posting_code: "AR", posting_description: "ROOM CHARGE", today_value: "4125.44", mtd_value: "125447.11", ytd_value: "482995.37" }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "operator_transaction_rows",
      reportTitle: "Operator Transactions",
      reportDate: "2026-05-31",
      attachmentName: "OperatorTransactionsReport.pdf",
      rows: [
        { transaction_code: "VS", transaction_description: "PAYMENT VISA/MC 121-A", amount: "-100.00", adjustment_amount: "0.00" },
        { transaction_code: "CASH", transaction_description: "PAYMENT CASH", amount: "1.00", adjustment_amount: "0.00" }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "daily_transaction_log_rows",
      reportTitle: "Daily Transaction Log",
      reportDate: "2026-05-31",
      attachmentName: "TransactionLogReport.pdf",
      rows: [
        { transaction_code: "VS", transaction_description: "PAYMENT VISA/MC", posted_amount: "-145.00", adjusted_amount: "0.00" },
        { transaction_code: "ROOM", transaction_description: "ROOM REVENUE", posted_amount: "250.00", adjusted_amount: "0.00" }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "room_tax_listing_rows",
      reportTitle: "Room and Tax Report",
      reportDate: "2026-05-31",
      attachmentName: "RoomAndTaxReport.pdf",
      rows: [
        { charge_type: "ROOM RATE", room_charge: "516.46", tax_amount: "0.00" },
        { charge_type: "ROOM TAX", room_charge: "0.00", tax_amount: "53.71" }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "Holiday Inn Express Lexington",
      propertySlug: "holiday-inn-express-lexington",
      reportType: "all_transaction_rows",
      reportTitle: "All Transactions",
      reportDate: "2026-05-31",
      attachmentName: "AllTransactionsReport.pdf",
      rows: [
        { transaction_type: "CHARGE", charge_type: "ROOM", transaction_description: "ROOM CHARGE 101-A", amount: "450.00" },
        { transaction_type: "TAX", charge_type: "ROOM", transaction_description: "ROOM TAX 101-A", amount: "54.00" },
        { transaction_type: "PAYMENT", charge_type: "CARD", transaction_description: "VISA PAYMENT 101-A", amount: "-504.00" }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const saveSettingsResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveSettingsResponse.status, 200);

    const listResponse = await fetch(`${context.baseUrl}/api/netsuite/properties`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as { properties: Array<Record<string, unknown>> };
    assert.equal(listPayload.properties.length, 2);
    const propertySummaries = new Map<string, string[]>(
      listPayload.properties.map((entry) => [
        String(entry.property_slug || ""),
        (entry.supportedReportTypes as Array<Record<string, unknown>>)
          .map((reportEntry) => String(reportEntry.reportType || ""))
          .sort()
      ])
    );
    assert.deepEqual(propertySummaries.get("bw-plus-dayton-hotel-and-suites"), [
      "best_western_daily_report_rows",
      "credit_card_transaction_rows",
      "daily_transaction_log_rows",
      "operator_transaction_rows",
      "room_tax_listing_rows"
    ]);
    assert.deepEqual(propertySummaries.get("holiday-inn-express-lexington"), [
      "all_transaction_rows"
    ]);

    const supportedTypes: string[] = propertySummaries.get("bw-plus-dayton-hotel-and-suites") ?? [];

    for (const reportType of supportedTypes) {
      const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=${encodeURIComponent(reportType)}`, {
        headers: { cookie: adminCookie }
      });
      assert.equal(workspaceResponse.status, 200);
      const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
      const selectedAttachment = workspacePayload.selectedAttachment as Record<string, unknown>;
      const attachmentId = Number(selectedAttachment.attachmentId);
      assert.ok(attachmentId > 0);
      assert.equal(workspacePayload.selectedReportType, reportType);
      assert.ok(((workspacePayload.mappings as Array<Record<string, unknown>>) ?? []).length > 0);

      const syncResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites/statistical-accounts/sync`, {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          attachmentId,
          mappings: [],
          defaults: {
            externalIdPrefix: "bwdayton",
            memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
            subsidiaryId: "7",
            locationId: "9",
            departmentId: "11",
            classId: "13",
            unitsTypeId: "5",
            unitId: "Rooms"
          }
        })
      });
      assert.equal(syncResponse.status, 200);
      const syncPayload = await syncResponse.json() as { sync: Record<string, unknown>; workspace: Record<string, unknown> };
      assert.equal(syncPayload.sync.errorCount, 0);
      assert.ok(((syncPayload.workspace.mappings as Array<Record<string, unknown>>) ?? []).every((entry) => String(entry.accountSyncStatus || "") === "synced"));

      const previewResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites/preview`, {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          attachmentId,
          mappings: [],
          defaults: {
            externalIdPrefix: "bwdayton",
            memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
            subsidiaryId: "7",
            locationId: "9",
            departmentId: "11",
            classId: "13",
            unitsTypeId: "5",
            unitId: "Rooms"
          }
        })
      });
      assert.equal(previewResponse.status, 200);
      const previewPayload = await previewResponse.json() as { run: Record<string, unknown> };
      assert.equal(previewPayload.run.status, "preview");
      const previewRunPayload = previewPayload.run.previewPayload as Record<string, unknown>;
      const previewSummary = previewRunPayload.summary as Record<string, unknown>;
      assert.equal(previewSummary.postable, true);
      assert.ok(Number(previewSummary.lineCount) > 0);

      const submitResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites/runs/${encodeURIComponent(String(previewPayload.run.id))}/submit`, {
        method: "POST",
        headers: { cookie: adminCookie }
      });
      assert.equal(submitResponse.status, 200);
      const submitPayload = await submitResponse.json() as { run: Record<string, unknown> };
      assert.equal(submitPayload.run.status, "submitted");
      assert.match(String(submitPayload.run.netsuite_response_summary || ""), /statistical journal/i);
    }

    const allTransactionsWorkspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-lexington?reportType=all_transaction_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(allTransactionsWorkspaceResponse.status, 200);
    const allTransactionsWorkspacePayload = await allTransactionsWorkspaceResponse.json() as Record<string, unknown>;
    const allTransactionsAttachment = allTransactionsWorkspacePayload.selectedAttachment as Record<string, unknown>;
    const allTransactionsAttachmentId = Number(allTransactionsAttachment.attachmentId);
    assert.ok(allTransactionsAttachmentId > 0);
    assert.equal(allTransactionsWorkspacePayload.selectedReportType, "all_transaction_rows");
    assert.ok(((allTransactionsWorkspacePayload.mappings as Array<Record<string, unknown>>) ?? []).length > 0);

    const allTransactionsSyncResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-lexington/statistical-accounts/sync`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: allTransactionsAttachmentId,
        mappings: [],
        defaults: {
          externalIdPrefix: "hilex",
          memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
          subsidiaryId: "7",
          locationId: "9",
          departmentId: "11",
          classId: "13",
          unitsTypeId: "5",
          unitId: "Rooms"
        }
      })
    });
    assert.equal(allTransactionsSyncResponse.status, 200);

    const allTransactionsPreviewResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-lexington/preview`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId: allTransactionsAttachmentId,
        mappings: [],
        defaults: {
          externalIdPrefix: "hilex",
          memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
          subsidiaryId: "7",
          locationId: "9",
          departmentId: "11",
          classId: "13",
          unitsTypeId: "5",
          unitId: "Rooms"
        }
      })
    });
    assert.equal(allTransactionsPreviewResponse.status, 200);
    const allTransactionsPreviewPayload = await allTransactionsPreviewResponse.json() as { run: Record<string, unknown> };
    assert.equal(allTransactionsPreviewPayload.run.status, "preview");

    const allTransactionsSubmitResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/holiday-inn-express-lexington/runs/${encodeURIComponent(String(allTransactionsPreviewPayload.run.id))}/submit`, {
      method: "POST",
      headers: { cookie: adminCookie }
    });
    assert.equal(allTransactionsSubmitResponse.status, 200);
    const allTransactionsSubmitPayload = await allTransactionsSubmitResponse.json() as { run: Record<string, unknown> };
    assert.equal(allTransactionsSubmitPayload.run.status, "submitted");
    assert.match(String(allTransactionsSubmitPayload.run.netsuite_response_summary || ""), /statistical journal/i);

    assert.ok(createdAccounts.length > 0);
    assert.equal(journalCounter, supportedTypes.length + 1);
  } finally {
    await context.dispose();
  }
});

test("NetSuite statistical account sync reuses existing BW Dayton accounts on rerun", async () => {
  const createdAccounts: Array<{ id: string; acctNumber: string; acctName: string; externalId: string }> = [];
  let tokenCounter = 0;
  let accountCounter = 0;
  const context = await createRouteTestContext({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/services/rest/auth/oauth2/v1/token")) {
        tokenCounter += 1;
        return mockResponse(200, { access_token: `token-${tokenCounter}` });
      }
      if (url.includes("/services/rest/query/v1/suiteql")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { q?: string } : {};
        const query = String(body.q || "");
        const items = createdAccounts.filter((entry) => query.includes(entry.acctNumber) || query.includes(entry.externalId)).map((entry) => ({
          id: entry.id,
          acctnumber: entry.acctNumber,
          acctname: entry.acctName,
          externalid: entry.externalId
        }));
        return mockResponse(200, { items });
      }
      if (url.endsWith("/services/rest/record/v1/account")) {
        accountCounter += 1;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        const account = {
          id: `710${accountCounter}`,
          acctNumber: String(body.acctNumber || ""),
          acctName: String(body.acctName || ""),
          externalId: String(body.externalId || "")
        };
        createdAccounts.push(account);
        return mockResponse(201, account, {
          location: `https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/account/${account.id}`
        });
      }
      return mockResponse(404, { error: "Unexpected request" });
    }
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "best_western_daily_report_rows",
      reportTitle: "Daily Report",
      reportDate: "2026-05-31",
      attachmentName: "DailyReport.pdf",
      rows: [
        { section: "Statistical Recap", row_kind: "metric", metric_name: "Occupied", today_value: "23", mtd_value: "949", ytd_value: "3789" },
        { section: "Statistical Recap", row_kind: "metric", metric_name: "No Show", today_value: "1", mtd_value: "2", ytd_value: "25" }
      ]
    });
    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const saveSettingsResponse = await fetch(`${context.baseUrl}/api/settings/netsuite`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify(buildSettingsPayload())
    });
    assert.equal(saveSettingsResponse.status, 200);

    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=best_western_daily_report_rows`, {
      headers: { cookie: adminCookie }
    });
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    const attachmentId = Number((workspacePayload.selectedAttachment as Record<string, unknown>).attachmentId);

    const firstSync = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites/statistical-accounts/sync`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId,
        mappings: [],
        defaults: {
          externalIdPrefix: "bwdayton",
          memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
          subsidiaryId: "7",
          unitsTypeId: "5",
          unitId: "Rooms"
        }
      })
    });
    const firstSyncPayload = await firstSync.json() as { sync: Record<string, unknown>; workspace: Record<string, unknown> };
    assert.equal(firstSync.status, 200);
    assert.ok(Number(firstSyncPayload.sync.createdCount) > 0);
    const firstNumbers = ((firstSyncPayload.workspace.mappings as Array<Record<string, unknown>>) ?? []).map((entry) => entry.statisticalAccountNumber);

    const secondSync = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites/statistical-accounts/sync`, {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        attachmentId,
        mappings: [],
        defaults: {
          externalIdPrefix: "bwdayton",
          memoTemplate: "Synchro HRM {propertyName} {reportTitle} {reportDate}",
          subsidiaryId: "7",
          unitsTypeId: "5",
          unitId: "Rooms"
        }
      })
    });
    const secondSyncPayload = await secondSync.json() as { sync: Record<string, unknown>; workspace: Record<string, unknown> };
    assert.equal(secondSync.status, 200);
    assert.equal(secondSyncPayload.sync.createdCount, 0);
    assert.ok(Number(secondSyncPayload.sync.reusedCount) > 0);
    const secondNumbers = ((secondSyncPayload.workspace.mappings as Array<Record<string, unknown>>) ?? []).map((entry) => entry.statisticalAccountNumber);
    assert.deepEqual(secondNumbers, firstNumbers);
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace collapses same-message PDF and workbook siblings into one source attachment", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    const graphMessageId = "message-bw-dayton-dedupe";
    seedParsedAttachment(context.database, {
      graphMessageId,
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "credit_card_transaction_rows",
      reportTitle: "Credit Card Transactions",
      reportDate: "2026-06-24",
      attachmentName: "Jun 25, 2026-BWDAY-CreditCardBatchReport.pdf",
      rows: [
        {
          card_type: "VS",
          charge_amount: "12.34",
          credit_amount: "0.00",
          transaction_status: "Settled"
        }
      ]
    });
    const workbookAttachmentId = seedParsedAttachment(context.database, {
      graphMessageId,
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "credit_card_transaction_rows",
      reportTitle: "Credit Card Transactions",
      reportDate: "2026-06-24",
      attachmentName: "Jun 25, 2026-BWDAY-CreditCardBatchReport.xlsx",
      extension: ".xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      rows: [
        {
          card_type: "VS",
          charge_amount: "12.34",
          credit_amount: "0.00",
          transaction_status: "Settled"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);

    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    const supportedAttachments = workspacePayload.supportedAttachments as Array<Record<string, unknown>>;
    assert.equal(supportedAttachments.length, 1);
    assert.equal(supportedAttachments[0]?.attachmentId, workbookAttachmentId);
    assert.equal(supportedAttachments[0]?.attachmentName, "Jun 25, 2026-BWDAY-CreditCardBatchReport.xlsx");
    assert.equal((workspacePayload.selectedAttachment as Record<string, unknown>).attachmentId, workbookAttachmentId);
    assert.equal((workspacePayload.discoverySummary as Record<string, unknown>).attachmentCount, 1);
    assert.equal(
      ((workspacePayload.availableReportTypes as Array<Record<string, unknown>>)[0] ?? {}).attachmentCount,
      1
    );
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace groups BW daily report categories and collapses credit card logs", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "credit_card_transaction_rows",
      reportTitle: "Credit Card Transactions",
      reportDate: "2026-05-31",
      attachmentName: "CreditCardBatchReport.pdf",
      rows: [
        {
          card_type: "VS",
          charge_amount: "200.00",
          credit_amount: "0.00",
          transaction_status: "Settled"
        },
        {
          card_type: "MC",
          charge_amount: "18.75",
          credit_amount: "0.00",
          transaction_status: "Settled"
        },
        {
          card_type: "VS",
          charge_amount: "0.00",
          credit_amount: "25.00",
          transaction_status: "Settled"
        }
      ]
    });
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "best_western_daily_report_rows",
      reportTitle: "Daily Report",
      reportDate: "2026-05-31",
      attachmentName: "DailyReport.pdf",
      rows: [
        {
          section: "Statistical Recap",
          subsection: null,
          group_name: null,
          row_kind: "metric",
          metric_name: "Occupied",
          posting_code: null,
          posting_description: null,
          today_value: "23",
          mtd_value: "949",
          ytd_value: "3789"
        },
        {
          section: "Statistical Recap",
          subsection: null,
          group_name: null,
          row_kind: "metric",
          metric_name: "No Show",
          posting_code: null,
          posting_description: null,
          today_value: "0",
          mtd_value: "2",
          ytd_value: "25"
        },
        {
          section: "Detail Listing",
          subsection: "Guest Ledger",
          group_name: "GL CREDIT CARDS REV",
          row_kind: "detail",
          metric_name: null,
          posting_code: "MC",
          posting_description: "PAYMENT MASTERCARD",
          today_value: "-2718.08",
          mtd_value: "-146317.95",
          ytd_value: "-526384.74"
        },
        {
          section: "Detail Listing",
          subsection: "Guest Ledger",
          group_name: "GL CREDIT CARDS REV",
          row_kind: "detail",
          metric_name: null,
          posting_code: "VS",
          posting_description: "PAYMENT VISA/MC",
          today_value: "-840.59",
          mtd_value: "-50244.73",
          ytd_value: "-194730.82"
        },
        {
          section: "Detail Listing",
          subsection: "Guest Ledger",
          group_name: "GL ROOM REV",
          row_kind: "detail",
          metric_name: null,
          posting_code: "AR",
          posting_description: "ROOM CHARGE",
          today_value: "4125.44",
          mtd_value: "125447.11",
          ytd_value: "482995.37"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);

    const creditCardWorkspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=credit_card_transaction_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(creditCardWorkspaceResponse.status, 200);
    const creditCardWorkspacePayload = await creditCardWorkspaceResponse.json() as Record<string, unknown>;
    assert.equal(creditCardWorkspacePayload.selectedReportType, "credit_card_transaction_rows");
    const creditCardMappings = creditCardWorkspacePayload.mappings as Array<Record<string, unknown>>;
    assert.equal(creditCardMappings.length, 1);
    assert.equal(creditCardMappings[0]?.groupLabel, "Credit Card Transactions");
    assert.equal(creditCardMappings[0]?.itemLabel, "All Cards");
    assert.equal(creditCardMappings[0]?.amountField, "net_amount");
    assert.equal(creditCardMappings[0]?.currentAmount, "193.75");

    const dailyWorkspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=best_western_daily_report_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(dailyWorkspaceResponse.status, 200);
    const dailyWorkspacePayload = await dailyWorkspaceResponse.json() as Record<string, unknown>;
    assert.equal(dailyWorkspacePayload.selectedReportType, "best_western_daily_report_rows");
    const dailyMappings = dailyWorkspacePayload.mappings as Array<Record<string, unknown>>;
    assert.equal(dailyMappings.length, 4);
    assert.ok(dailyMappings.every((entry) => entry.amountField === "today_value"));
    assert.equal(dailyMappings.some((entry) => entry.amountField === "mtd_value"), false);
    assert.equal(dailyMappings.some((entry) => entry.amountField === "ytd_value"), false);

    const occupiedMapping = dailyMappings.find((entry) => entry.itemLabel === "Occupied");
    assert.ok(occupiedMapping);
    assert.equal(occupiedMapping?.currentAmount, "23.00");

    const creditCardsRevenueMapping = dailyMappings.find((entry) => (
      entry.groupLabel === "Detail Listing / Guest Ledger"
      && entry.itemLabel === "GL CREDIT CARDS REV"
    ));
    assert.ok(creditCardsRevenueMapping);
    assert.equal(creditCardsRevenueMapping?.currentAmount, "-3558.67");
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace collapses operator transactions into grouped ledger categories", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "operator_transaction_rows",
      reportTitle: "Operator Transactions",
      reportDate: "2026-05-31",
      attachmentName: "OperatorTransactionsReport.pdf",
      rows: [
        {
          transaction_code: "VS",
          transaction_description: "PAYMENT VISA/MC 121-A",
          transaction_id: "1001",
          confirmation_no: "C1",
          guest_name: "Guest One",
          reference_value: "ref-1",
          amount: "-100.00",
          adjustment_amount: "0.00",
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:00 AM"
        },
        {
          transaction_code: "VS",
          transaction_description: "PAYMENT VISA/MC 131-A",
          transaction_id: "1002",
          confirmation_no: "C2",
          guest_name: "Guest Two",
          reference_value: "ref-2",
          amount: "-50.00",
          adjustment_amount: "5.00",
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:05 AM"
        },
        {
          transaction_code: "7V",
          transaction_description: "ADV DEP VISA 121-A",
          transaction_id: "1003",
          confirmation_no: "C3",
          guest_name: "Guest Three",
          reference_value: "ref-3",
          amount: "-25.00",
          adjustment_amount: "0.00",
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:10 AM"
        },
        {
          transaction_code: "CH",
          transaction_description: "PAYMENT CASH 105-A",
          transaction_id: "1004",
          confirmation_no: "C4",
          guest_name: "Guest Four",
          reference_value: "ref-4",
          amount: "0.00",
          adjustment_amount: "1.00",
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:15 AM"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=operator_transaction_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    assert.equal(workspacePayload.selectedReportType, "operator_transaction_rows");

    const mappings = workspacePayload.mappings as Array<Record<string, unknown>>;
    assert.equal(mappings.length, 3);
    assert.ok(mappings.every((entry) => entry.groupLabel === "Operator Transactions"));
    assert.ok(mappings.every((entry) => entry.amountField === "ledger_total"));

    const paymentVisa = mappings.find((entry) => entry.itemLabel === "PAYMENT VISA/MC");
    assert.ok(paymentVisa);
    assert.equal(paymentVisa?.currentAmount, "-145.00");

    const advanceDeposit = mappings.find((entry) => entry.itemLabel === "ADV DEP VISA");
    assert.ok(advanceDeposit);
    assert.equal(advanceDeposit?.currentAmount, "-25.00");

    const paymentCash = mappings.find((entry) => entry.itemLabel === "PAYMENT CASH");
    assert.ok(paymentCash);
    assert.equal(paymentCash?.currentAmount, "1.00");
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace collapses daily transaction logs into grouped ledger categories", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "daily_transaction_log_rows",
      reportTitle: "Daily Transaction Log",
      reportDate: "2026-05-31",
      attachmentName: "TransactionLogReport.pdf",
      rows: [
        {
          transaction_code: "VS",
          transaction_description: "PAYMENT VISA/MC",
          room_number: "121-A",
          transaction_id: "2001",
          confirmation_no: "D1",
          guest_name: "Guest One",
          reference_value: null,
          posted_amount: "-100.00",
          adjusted_amount: null,
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:00 AM"
        },
        {
          transaction_code: "VS",
          transaction_description: "PAYMENT VISA/MC",
          room_number: "131-A",
          transaction_id: "2002",
          confirmation_no: "D2",
          guest_name: "Guest Two",
          reference_value: null,
          posted_amount: "-50.00",
          adjusted_amount: "5.00",
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:05 AM"
        },
        {
          transaction_code: "RC",
          transaction_description: "ROOM CHRG REVENUE",
          room_number: "104-A",
          transaction_id: "2003",
          confirmation_no: "D3",
          guest_name: "Guest Three",
          reference_value: null,
          posted_amount: "250.00",
          adjusted_amount: null,
          original_id: null,
          original_date: null,
          void_from_value: null,
          clerk_name: "clerk",
          transaction_time: "1:10 AM"
        },
        {
          transaction_code: "91",
          transaction_description: "TRAVEL PENDLETON ASSESSMENT",
          room_number: null,
          transaction_id: "2004",
          confirmation_no: "D4",
          guest_name: "Guest Four",
          reference_value: null,
          posted_amount: null,
          adjusted_amount: "-4.00",
          original_id: "1999",
          original_date: null,
          void_from_value: "X",
          clerk_name: "clerk",
          transaction_time: "1:15 AM"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=daily_transaction_log_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    assert.equal(workspacePayload.selectedReportType, "daily_transaction_log_rows");

    const mappings = workspacePayload.mappings as Array<Record<string, unknown>>;
    assert.equal(mappings.length, 3);
    assert.ok(mappings.every((entry) => entry.groupLabel === "Daily Transaction Log"));
    assert.ok(mappings.every((entry) => entry.amountField === "ledger_total"));

    const paymentVisa = mappings.find((entry) => entry.itemLabel === "PAYMENT VISA/MC");
    assert.ok(paymentVisa);
    assert.equal(paymentVisa?.currentAmount, "-145.00");

    const roomRevenue = mappings.find((entry) => entry.itemLabel === "ROOM CHRG REVENUE");
    assert.ok(roomRevenue);
    assert.equal(roomRevenue?.currentAmount, "250.00");

    const assessment = mappings.find((entry) => entry.itemLabel === "TRAVEL PENDLETON ASSESSMENT");
    assert.ok(assessment);
    assert.equal(assessment?.currentAmount, "-4.00");
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace collapses room tax listings by charge type", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "BW Plus Dayton Hotel & Suites",
      propertySlug: "bw-plus-dayton-hotel-and-suites",
      reportType: "room_tax_listing_rows",
      reportTitle: "Room & Tax Listing",
      reportDate: "2026-06-22",
      attachmentName: "RoomAndTaxReport.pdf",
      rows: [
        {
          room_number: "101-A",
          guest_name: "Guest One",
          confirmation_no: "R1",
          charge_type: "Room And Tax",
          arrival_date: "2026-06-13",
          departure_date: "2026-06-23",
          rate_amount: "154.90",
          override_flag: null,
          tax_amount: "16.11",
          package_name: null,
          extra_1: null,
          extra_2: null,
          transfer_flag: null,
          payment_method: "Cash"
        },
        {
          room_number: "102-A",
          guest_name: "Guest Two",
          confirmation_no: "R2",
          charge_type: "Room And Tax",
          arrival_date: "2026-06-14",
          departure_date: "2026-06-23",
          rate_amount: "173.24",
          override_flag: null,
          tax_amount: "18.01",
          package_name: null,
          extra_1: null,
          extra_2: null,
          transfer_flag: null,
          payment_method: "Cash"
        },
        {
          room_number: "103-A",
          guest_name: "Guest Three",
          confirmation_no: "R3",
          charge_type: "Room And Tax",
          arrival_date: "2026-06-18",
          departure_date: "2026-06-22",
          rate_amount: "188.32",
          override_flag: null,
          tax_amount: "19.59",
          package_name: null,
          extra_1: null,
          extra_2: null,
          transfer_flag: null,
          payment_method: "Credit Card"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/bw-plus-dayton-hotel-and-suites?reportType=room_tax_listing_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    assert.equal(workspacePayload.selectedReportType, "room_tax_listing_rows");

    const mappings = workspacePayload.mappings as Array<Record<string, unknown>>;
    assert.equal(mappings.length, 2);
    assert.ok(mappings.every((entry) => entry.groupLabel === "Charge Type: Room And Tax"));
    assert.ok(mappings.every((entry) => entry.itemLabel === "All Listed Rooms"));

    const rateMapping = mappings.find((entry) => entry.amountField === "rate_amount");
    assert.ok(rateMapping);
    assert.equal(rateMapping?.currentAmount, "516.46");

    const taxMapping = mappings.find((entry) => entry.amountField === "tax_amount");
    assert.ok(taxMapping);
    assert.equal(taxMapping?.currentAmount, "53.71");
  } finally {
    await context.dispose();
  }
});

test("NetSuite posting workspace collapses daily audit packet sections into statistical categories", async () => {
  const context = await createRouteTestContext({
    fetchImpl: async () => mockResponse(404, { error: "Unexpected request" })
  });

  try {
    seedParsedAttachment(context.database, {
      propertyName: "Comfort Inn & Suites WA184",
      propertySlug: "comfort-inn-and-suites-wa184",
      reportType: "choice_audit_packet_rows",
      reportTitle: "Daily Audit Packet",
      reportDate: "2026-05-31",
      attachmentName: "All_Night_Audit_Reports_WA184_COMFORT WALLA WALLA DAILY PDF FOR NETSUITE_2026-05-31.pdf",
      rows: [
        {
          report_name: "Hotel Journal Summary",
          row_kind: "detail",
          line_text: "Cash (CA) (2.00) 0.00 0.00 (2.00) (2.00) 0.00 0.00 1 1 0 0"
        },
        {
          report_name: "Hotel Journal Summary",
          row_kind: "detail",
          line_text: "Visa Payment (VI) (3,253.41) 0.00 0.00 (3,253.41) (2,871.80) 0.00 (381.61) 10 10 0 0"
        },
        {
          report_name: "Hotel Journal Summary",
          row_kind: "total",
          line_text: "Today's Total: (2,580.93) 0.00 0.00 (2,580.93) (1,291.18) 53.00 (1,342.75) 129 129 0 0"
        },
        {
          report_name: "Hotel Statistics",
          row_kind: "section",
          line_text: "Room Statistics 5/31/2026 Current PTD Last Year PTD Current YTD Last YTD"
        },
        {
          report_name: "Hotel Statistics",
          row_kind: "detail",
          line_text: "Total Rooms 76 2,356 2,356 11,476 11,476"
        },
        {
          report_name: "Hotel Statistics",
          row_kind: "detail",
          line_text: "Total Occupied Rooms 22 952 1,092 3,699 4,281"
        },
        {
          report_name: "Revenue by Rate Code",
          row_kind: "detail",
          line_text: "SP3BK 1 4.35 117.85 5.84 117.85 22 2.70 3,238.50 3.04 147.20 47 1.32 5,877.94 1.55 125.06"
        },
        {
          report_name: "Final Transaction Closeout",
          row_kind: "section",
          section: "Transaction Type: CREDIT CARDS",
          line_text: "Transaction Type: CREDIT CARDS"
        },
        {
          report_name: "Final Transaction Closeout",
          row_kind: "total",
          section: "Transaction Type: CREDIT CARDS",
          line_text: "Total For Credit Cards 0.00 0.00 0.00 (5073.32) (3730.57) 0.00"
        }
      ]
    });

    const adminCookie = await login(context.baseUrl, "admin", ADMIN_PASSWORD);
    const workspaceResponse = await fetch(`${context.baseUrl}/api/netsuite/properties/comfort-inn-and-suites-wa184?reportType=choice_audit_packet_rows`, {
      headers: { cookie: adminCookie }
    });
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as Record<string, unknown>;
    assert.equal(workspacePayload.selectedReportType, "choice_audit_packet_rows");

    const mappings = workspacePayload.mappings as Array<Record<string, unknown>>;
    assert.ok(mappings.length >= 6);

    const cashSummary = mappings.find((entry) => entry.groupLabel === "Hotel Journal Summary" && entry.itemLabel === "Cash");
    assert.ok(cashSummary);
    assert.equal(cashSummary?.amountField, "journal_total");
    assert.equal(cashSummary?.currentAmount, "-2.00");

    const visaSummary = mappings.find((entry) => entry.groupLabel === "Hotel Journal Summary" && entry.itemLabel === "Visa Payment");
    assert.ok(visaSummary);
    assert.equal(visaSummary?.currentAmount, "-3253.41");

    const totalRooms = mappings.find((entry) => entry.groupLabel === "Hotel Statistics / Room Statistics" && entry.itemLabel === "Total Rooms");
    assert.ok(totalRooms);
    assert.equal(totalRooms?.amountField, "current");
    assert.equal(totalRooms?.currentAmount, "76.00");

    const occupiedRooms = mappings.find((entry) => entry.groupLabel === "Hotel Statistics / Room Statistics" && entry.itemLabel === "Total Occupied Rooms");
    assert.ok(occupiedRooms);
    assert.equal(occupiedRooms?.currentAmount, "22.00");

    const rateCode = mappings.find((entry) => entry.groupLabel === "Revenue by Rate Code" && entry.itemLabel === "SP3BK");
    assert.ok(rateCode);
    assert.equal(rateCode?.amountField, "daily_revenue");
    assert.equal(rateCode?.currentAmount, "117.85");

    const closeout = mappings.find((entry) => entry.groupLabel === "Final Transaction Closeout / Transaction Type: CREDIT CARDS");
    assert.ok(closeout);
    assert.equal(closeout?.amountField, "todays_net");
    assert.equal(closeout?.currentAmount, "-5073.32");
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
    graphMessageId?: string;
    propertyName: string;
    propertySlug: string;
    reportType: ReportType;
    reportTitle: string;
    reportDate: string;
    attachmentName: string;
    extension?: string;
    contentType?: string;
    rows: Array<Record<string, string | number | null>>;
  }
): number {
  const runId = database.createRun("test");
  const graphMessageId = options.graphMessageId ?? `message-${randomBytes(6).toString("hex")}`;
  const graphAttachmentId = `attachment-${randomBytes(6).toString("hex")}`;
  const receivedAt = `${options.reportDate}T09:00:00.000Z`;
  const extension = options.extension ?? path.extname(options.attachmentName) ?? ".pdf";
  const contentType = options.contentType
    ?? (extension.toLowerCase() === ".xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/pdf");

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
    extension,
    contentType,
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

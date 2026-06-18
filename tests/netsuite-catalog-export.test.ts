import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/db/Database.js";
import { NetSuiteConnectionService } from "../src/services/NetSuiteConnectionService.js";

const PRIVATE_KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048
}).privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();

test("metadata catalog export writes a sorted latest CSV and per-record schema files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-netsuite-catalog-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const service = new NetSuiteConnectionService(
    database,
    randomBytes(32).toString("base64"),
    dataDir,
    async (input, init) => {
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
  );

  try {
    service.updateSettings({
      serviceBaseUrl: "https://1234567.suitetalk.api.netsuite.com",
      clientId: "client-id-1234",
      certificateId: "cert-4567",
      jwtAlgorithm: "PS256",
      probeQuery: "SELECT id FROM Account",
      privateKeyPem: PRIVATE_KEY_PEM,
      clearPrivateKey: false
    });

    const summary = await service.exportMetadataCatalog();
    assert.equal(summary.status, "success");
    assert.equal(summary.rowCount, 2);
    assert.equal(summary.schemaFileCount, 2);
    assert.ok(summary.latestPath);
    assert.ok(summary.schemaDirectory);

    const latestCsv = await readFile(String(summary.latestPath), "utf8");
    const csvLines = latestCsv.trim().split(/\r?\n/);
    assert.equal(csvLines[0], "record_type,canonical_href,openapi_href,json_schema_href,describes_href,captured_at");
    assert.match(csvLines[1] ?? "", /^account,/);
    assert.match(csvLines[2] ?? "", /^customer,/);

    const schemaFiles = (await readdir(String(summary.schemaDirectory))).sort();
    assert.deepEqual(schemaFiles, ["account.schema.json", "customer.schema.json"]);

    const accountSchema = JSON.parse(await readFile(path.join(String(summary.schemaDirectory), "account.schema.json"), "utf8")) as {
      properties?: Record<string, unknown>;
    };
    assert.ok(accountSchema.properties);
    assert.ok("id" in accountSchema.properties);
    assert.equal((requests[2]?.init?.headers as Record<string, string>).accept, "application/schema+json");
    assert.equal((requests[2]?.init?.headers as Record<string, string>).authorization, "Bearer token-123");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { buildClientAssertion, NetSuiteClient, NetSuiteRequestError } from "../src/netsuite/NetSuiteClient.js";
import type { NetSuiteConnectionSettings } from "../src/netsuite/types.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048
});
const privateKeyPem = privateKey.export({
  type: "pkcs8",
  format: "pem"
}).toString();

test("client assertion includes NetSuite OAuth claims and headers", () => {
  const token = buildClientAssertion({
    clientId: "client-id-1234",
    certificateId: "cert-4567",
    privateKeyPem,
    algorithm: "PS256",
    audience: "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token",
    now: 1_700_000_000,
    expiresInSeconds: 300
  });

  const [encodedHeader, encodedPayload, signature] = token.split(".");
  assert.ok(signature);

  const header = JSON.parse(Buffer.from(fromBase64Url(encodedHeader), "base64").toString("utf8"));
  const payload = JSON.parse(Buffer.from(fromBase64Url(encodedPayload), "base64").toString("utf8"));

  assert.equal(header.alg, "PS256");
  assert.equal(header.kid, "cert-4567");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, "client-id-1234");
  assert.equal(payload.scope, "rest_webservices");
  assert.equal(payload.aud, "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token");
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_000_300);
  assert.equal(typeof payload.jti, "string");
  assert.ok(payload.jti.length > 10);
});

test("NetSuite client exchanges a token and runs the SuiteQL proof query", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      init
    });

    if (requests.length === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    return mockResponse(200, {
      count: 1,
      totalResults: 1,
      items: [{ id: "100" }]
    });
  };

  const client = new NetSuiteClient(fetchImpl);
  const result = await client.runSuiteQlProbe(mockSettings(), privateKeyPem);

  assert.equal(result.httpStatus, 200);
  assert.equal(result.count, 1);
  assert.equal(result.totalResults, 1);
  assert.deepEqual(result.columnNames, ["id"]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/services\/rest\/auth\/oauth2\/v1\/token$/);
  assert.match(requests[1].url, /\/services\/rest\/query\/v1\/suiteql\?limit=1&offset=0$/);
  assert.equal((requests[1].init?.headers as Record<string, string>).prefer, "transient");
  assert.equal((requests[1].init?.headers as Record<string, string>).authorization, "Bearer token-123");
});

test("NetSuite client maps token failures into normalized request errors", async () => {
  const client = new NetSuiteClient(async () => mockResponse(401, {
    error: "invalid_client",
    error_description: "bad client"
  }));

  await assert.rejects(
    () => client.runSuiteQlProbe(mockSettings(), privateKeyPem),
    (error: unknown) => {
      assert.ok(error instanceof NetSuiteRequestError);
      assert.equal(error.httpStatus, 401);
      assert.equal(error.errorCode, "invalid_client");
      assert.equal(error.detail, "bad client");
      return true;
    }
  );
});

test("NetSuite client maps SuiteQL error details into normalized request errors", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    return mockResponse(403, {
      "o:errorDetails": [
        {
          detail: "permission denied",
          "o:errorCode": "INSUFFICIENT_PERMISSION"
        }
      ]
    });
  });

  await assert.rejects(
    () => client.runSuiteQlProbe(mockSettings(), privateKeyPem),
    (error: unknown) => {
      assert.ok(error instanceof NetSuiteRequestError);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.errorCode, "INSUFFICIENT_PERMISSION");
      assert.equal(error.detail, "permission denied");
      return true;
    }
  );
});

test("NetSuite client fetches metadata catalog rows and per-record schemas", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      init
    });

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
                mediaType: "application/swagger+json"
              },
              {
                rel: "alternate",
                href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer",
                mediaType: "application/schema+json"
              },
              {
                rel: "describes",
                href: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer"
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

    return mockResponse(200, {
      type: "object",
      properties: {
        id: {
          type: "integer"
        }
      }
    });
  };

  const client = new NetSuiteClient(fetchImpl);
  const result = await client.fetchMetadataCatalog(mockSettings(), privateKeyPem, "2026-05-27T19:00:00.000Z");

  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.rows.map((row) => row.recordType), ["account", "customer"]);
  assert.equal(result.rows[1]?.openApiHref, "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer");
  assert.equal(result.rows[1]?.jsonSchemaHref, "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog/customer");
  assert.equal(result.schemas.length, 2);
  assert.equal(result.schemas[0]?.recordType, "account");
  assert.equal((requests[2]?.init?.headers as Record<string, string>).accept, "application/schema+json");
  assert.equal((requests[2]?.init?.headers as Record<string, string>).authorization, "Bearer token-123");
});

function mockSettings(): NetSuiteConnectionSettings {
  return {
    serviceBaseUrl: "https://1234567.suitetalk.api.netsuite.com",
    clientId: "client-id-1234",
    certificateId: "cert-4567",
    jwtAlgorithm: "PS256",
    probeQuery: "SELECT id FROM Account"
  };
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

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return normalized + padding;
}

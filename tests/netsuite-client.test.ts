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

test("NetSuite client resolves account numbers into internal IDs", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    return mockResponse(200, {
      items: [
        { id: "101", acctnumber: "4000" },
        { id: "202", acctnumber: "2100" }
      ]
    });
  });

  const result = await client.resolveGlAccountIds(mockSettings(), privateKeyPem, ["4000", "2100", "4000"]);
  assert.deepEqual(result, {
    "4000": "101",
    "2100": "202"
  });
});

test("NetSuite client creates a journal entry and surfaces the returned id and tranId", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async (input) => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    assert.match(String(input), /\/services\/rest\/record\/v1\/journalEntry$/);
    return mockResponse(201, {
      id: "9981",
      tranId: "JE1001"
    }, {
      location: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/journalEntry/9981"
    });
  });

  const result = await client.createJournalEntry(mockSettings(), privateKeyPem, {
    externalId: "hiep-all-transactions-20260522",
    tranDate: "2026-05-22",
    memo: "Synchro HRM preview",
    line: {
      items: [
        {
          account: { id: "101" },
          credit: 149
        }
      ]
    }
  });

  assert.equal(result.httpStatus, 201);
  assert.equal(result.journalEntry.id, "9981");
  assert.equal(result.journalEntry.tranId, "JE1001");
  assert.match(result.journalEntry.location, /journalEntry\/9981$/);
});

test("NetSuite client resolves statistical accounts by account number and external ID", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    return mockResponse(200, {
      items: [
        { id: "501", acctnumber: "BWDAY-STAT-001", acctname: "BW Dayton Occupied", externalid: "synchrohrm:statacct:bw:occupied" },
        { id: "502", acctnumber: "BWDAY-STAT-002", acctname: "BW Dayton No Show", externalid: "synchrohrm:statacct:bw:noshow" }
      ]
    });
  });

  const result = await client.resolveStatisticalAccounts(
    mockSettings(),
    privateKeyPem,
    ["BWDAY-STAT-001"],
    ["synchrohrm:statacct:bw:noshow"]
  );

  assert.equal(result.byAccountNumber["BWDAY-STAT-001"]?.id, "501");
  assert.equal(result.byExternalId["synchrohrm:statacct:bw:noshow"]?.acctNumber, "BWDAY-STAT-002");
});

test("NetSuite client creates a statistical account and surfaces the returned identifiers", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async (input) => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    assert.match(String(input), /\/services\/rest\/record\/v1\/account$/);
    return mockResponse(201, {
      id: "7001",
      acctNumber: "BWDAY-BESTWESTER-1A2B3C4D",
      acctName: "BW Dayton Daily Occupied",
      externalId: "synchrohrm:statacct:bw-plus-dayton-hotel-and-suites:best-western:occupied"
    }, {
      location: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/account/7001"
    });
  });

  const result = await client.createStatisticalAccount(mockSettings(), privateKeyPem, {
    acctType: { id: "Stat" },
    acctNumber: "BWDAY-BESTWESTER-1A2B3C4D",
    acctName: "BW Dayton Daily Occupied",
    externalId: "synchrohrm:statacct:bw-plus-dayton-hotel-and-suites:best-western:occupied"
  });

  assert.equal(result.account.id, "7001");
  assert.equal(result.account.acctNumber, "BWDAY-BESTWESTER-1A2B3C4D");
  assert.match(result.account.location, /account\/7001$/);
});

test("NetSuite client creates a statistical journal entry and surfaces the returned id and tranId", async () => {
  let requestCount = 0;
  const client = new NetSuiteClient(async (input) => {
    requestCount += 1;
    if (requestCount === 1) {
      return mockResponse(200, { access_token: "token-123" });
    }

    assert.match(String(input), /\/services\/rest\/record\/v1\/statisticaljournalentry$/);
    return mockResponse(201, {
      id: "9988",
      tranId: "SJ1008"
    }, {
      location: "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/statisticaljournalentry/9988"
    });
  });

  const result = await client.createStatisticalJournalEntry(mockSettings(), privateKeyPem, {
    externalId: "bw-dayton-best-western-daily-20260531",
    tranDate: "2026-05-31",
    memo: "BW Dayton statistical journal",
    line: {
      items: [
        {
          account: { id: "7001" },
          debit: 23
        }
      ]
    }
  });

  assert.equal(result.journalEntry.id, "9988");
  assert.equal(result.journalEntry.tranId, "SJ1008");
  assert.match(result.journalEntry.location, /statisticaljournalentry\/9988$/);
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

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return normalized + padding;
}

import test from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.js";
import { GraphAttachmentSource } from "../src/sources/GraphAttachmentSource.js";

test("graph source resets stale delta tokens and filters to supported file attachments", async () => {
  const requests: string[] = [];
  const responses = [
    mockResponse(200, { access_token: "token-1", expires_in: 3600 }),
    mockResponse(410, { error: { message: "Sync state expired" } }),
    mockResponse(200, {
      value: [
        {
          id: "message-1",
          subject: "Daily reports",
          internetMessageId: "<message-1@test>",
          from: {
            emailAddress: {
              address: "auditor+ops@eternalhotels.com"
            }
          },
          receivedDateTime: "2026-05-19T12:00:00Z",
          hasAttachments: true
        }
      ],
      "@odata.deltaLink": "delta-2"
    }),
    mockResponse(200, {
      value: [
        {
          id: "attachment-pdf",
          name: "sales.pdf",
          "@odata.type": "#microsoft.graph.fileAttachment",
          contentType: "application/pdf",
          contentBytes: Buffer.from("pdf-bytes").toString("base64")
        },
        {
          id: "attachment-inline",
          name: "inline.png",
          "@odata.type": "#microsoft.graph.fileAttachment",
          isInline: true,
          contentType: "image/png",
          contentBytes: Buffer.from("png").toString("base64")
        },
        {
          id: "attachment-text",
          name: "notes.txt",
          "@odata.type": "#microsoft.graph.fileAttachment",
          contentType: "text/plain",
          contentBytes: Buffer.from("notes").toString("base64")
        }
      ]
    })
  ];

  const fetchImpl: typeof fetch = async (input) => {
    requests.push(String(input));
    const next = responses.shift();
    assert.ok(next, `Unexpected request: ${String(input)}`);
    return next as Response;
  };

  const source = new GraphAttachmentSource(mockConfig(), fetchImpl);
  const result = await source.pullAttachments("stale-delta");

  assert.equal(result.deltaWasReset, true);
  assert.equal(result.nextDeltaToken, "delta-2");
  assert.equal(result.messagesSeen, 1);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].attachmentName, "sales.pdf");
  assert.equal(result.attachments[0].sourceMailbox, "auditor@eternalhotels.com");
  assert.equal(result.attachments[0].message.senderEmail, "auditor+ops@eternalhotels.com");

  const tokenRequests = requests.filter((url) => url.includes("/oauth2/v2.0/token"));
  assert.equal(tokenRequests.length, 1);
});

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

function mockResponse(status: number, payload: unknown): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    }
  } as Response;
}

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/db/Database.js";
import { IngestionService } from "../src/services/IngestionService.js";
import type { IncomingAttachment, MailAttachmentSource, PullAttachmentsResult } from "../src/types.js";
import { isSenderApproved, parseApprovedSenderPatterns, validateApprovedSenderPatterns } from "../src/utils/approvedSenders.js";

test("approved sender utility supports wildcard domains and exact emails", () => {
  const patterns = parseApprovedSenderPatterns([
    "*@eternalhotels.com",
    "parn.singh@outlook.com",
    "",
    "*@eternalhotels.com"
  ]);

  assert.deepEqual(patterns, ["*@eternalhotels.com", "parn.singh@outlook.com"]);
  assert.equal(isSenderApproved("ops@eternalhotels.com", patterns), true);
  assert.equal(isSenderApproved("parn.singh@outlook.com", patterns), true);
  assert.equal(isSenderApproved("someone@redlionpasco.com", patterns), false);

  const validated = validateApprovedSenderPatterns(["*@eternalhotels.com", "nope", "parn.singh@outlook.com"]);
  assert.deepEqual(validated.valid, ["*@eternalhotels.com", "parn.singh@outlook.com"]);
  assert.deepEqual(validated.invalid, ["nope"]);
});

test("ingestion skips attachments from unapproved senders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "synchro-approved-senders-"));
  const dataDir = path.join(root, "storage");
  const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));

  try {
    const source: MailAttachmentSource = {
      async pullAttachments(): Promise<PullAttachmentsResult> {
        const attachments: IncomingAttachment[] = [
          {
            sourceMailbox: "auditor@eternalhotels.com",
            message: {
              graphMessageId: "approved-message",
              internetMessageId: "<approved@local.test>",
              subject: "Approved sender",
              senderEmail: "ops@eternalhotels.com",
              receivedAt: "2026-05-20T08:00:00.000Z",
              webLink: null
            },
            attachmentId: "approved-attachment",
            attachmentName: "approved.txt",
            contentType: "text/plain",
            bytes: Buffer.from("approved")
          },
          {
            sourceMailbox: "auditor@eternalhotels.com",
            message: {
              graphMessageId: "blocked-message",
              internetMessageId: "<blocked@local.test>",
              subject: "Blocked sender",
              senderEmail: "fraud@bad-actor.com",
              receivedAt: "2026-05-20T08:05:00.000Z",
              webLink: null
            },
            attachmentId: "blocked-attachment",
            attachmentName: "blocked.txt",
            contentType: "text/plain",
            bytes: Buffer.from("blocked")
          }
        ];

        return {
          attachments,
          nextDeltaToken: null,
          deltaWasReset: false,
          messagesSeen: 2
        };
      }
    };

    const service = new IngestionService(database, source, dataDir, ["*@eternalhotels.com"]);
    const result = await service.run("test");

    assert.equal(result.status, "completed");
    assert.equal(result.summary.attachmentsSeen, 2);
    assert.equal(result.summary.attachmentsArchived, 1);
    assert.equal(result.summary.attachmentsDeferred, 1);
    assert.ok(result.summary.notes.some((note) => note.includes("unapproved sender fraud@bad-actor.com")));
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

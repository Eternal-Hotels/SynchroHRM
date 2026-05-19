import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { IncomingAttachment, MailAttachmentSource, PullAttachmentsResult } from "../types.js";

export class ExampleDataAttachmentSource implements MailAttachmentSource {
  constructor(
    private readonly exampleDir: string,
    private readonly sourceMailbox = "auditor@eternalhotels.com",
    private readonly stableToken = "example-data-v1"
  ) {}

  async pullAttachments(deltaToken: string | null): Promise<PullAttachmentsResult> {
    if (deltaToken === this.stableToken) {
      return {
        attachments: [],
        nextDeltaToken: this.stableToken,
        deltaWasReset: false,
        messagesSeen: 0
      };
    }

    const names = (await readdir(this.exampleDir)).filter((name) => /\.(pdf|xlsx)$/i.test(name)).sort();
    const attachments: IncomingAttachment[] = [];

    for (const [index, name] of names.entries()) {
      const bytes = await readFile(path.join(this.exampleDir, name));
      attachments.push({
        sourceMailbox: this.sourceMailbox,
        message: {
          graphMessageId: `example-message-${index + 1}`,
          internetMessageId: `<example-${index + 1}@local.test>`,
          subject: `Example attachment ${name}`,
          receivedAt: new Date(Date.UTC(2026, 4, 19, 12, index, 0)).toISOString(),
          webLink: null
        },
        attachmentId: `example-attachment-${index + 1}`,
        attachmentName: name,
        contentType: name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes
      });
    }

    return {
      attachments,
      nextDeltaToken: this.stableToken,
      deltaWasReset: false,
      messagesSeen: attachments.length
    };
  }
}

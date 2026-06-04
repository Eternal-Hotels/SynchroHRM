import path from "node:path";
import type { AppConfig } from "../config.js";
import type {
  IncomingAttachment,
  MailAttachmentSource,
  MailMessageRef,
  PullAttachmentsResult
} from "../types.js";

interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
}

interface GraphMessage {
  id: string;
  subject?: string | null;
  internetMessageId?: string | null;
  from?: { emailAddress?: { address?: string | null } } | null;
  sender?: { emailAddress?: { address?: string | null } } | null;
  receivedDateTime: string;
  webLink?: string | null;
  hasAttachments?: boolean;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType?: string | null;
  contentBytes?: string;
  isInline?: boolean;
  "@odata.type"?: string;
}

export class GraphAttachmentSource implements MailAttachmentSource {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async pullAttachments(deltaToken: string | null): Promise<PullAttachmentsResult> {
    try {
      return await this.pullAttachmentsInner(deltaToken, false);
    } catch (error) {
      if (deltaToken && isDeltaResetError(error)) {
        return this.pullAttachmentsInner(null, true);
      }
      throw error;
    }
  }

  private async pullAttachmentsInner(deltaToken: string | null, deltaWasReset: boolean): Promise<PullAttachmentsResult> {
    const attachments: IncomingAttachment[] = [];
    let messagesSeen = 0;
    let nextLink: string | null = deltaToken;
    let deltaLink: string | null = null;

    if (!nextLink) {
      const folderPath = encodeURIComponent(this.config.graphMailFolder.toLowerCase());
      const baseUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/mailFolders/${folderPath}/messages/delta`;
      const select = "$select=id,subject,internetMessageId,from,sender,receivedDateTime,webLink,hasAttachments";
      nextLink = `${baseUrl}?${select}`;
    }

    while (nextLink) {
      const page: { value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } = await this.fetchJson(nextLink);
      messagesSeen += page.value.length;

      for (const message of page.value) {
        if (!message.hasAttachments) {
          continue;
        }

        const messageRef: MailMessageRef = {
          graphMessageId: message.id,
          internetMessageId: message.internetMessageId ?? null,
          subject: message.subject ?? null,
          senderEmail: message.from?.emailAddress?.address ?? message.sender?.emailAddress?.address ?? null,
          receivedAt: message.receivedDateTime,
          webLink: message.webLink ?? null
        };

        const messageAttachments = await this.fetchMessageAttachments(messageRef);
        attachments.push(...messageAttachments);
      }

      deltaLink = page["@odata.deltaLink"] ?? deltaLink;
      nextLink = page["@odata.nextLink"] ?? null;
    }

    return {
      attachments,
      nextDeltaToken: deltaLink,
      deltaWasReset,
      messagesSeen
    };
  }

  private async fetchMessageAttachments(message: MailMessageRef): Promise<IncomingAttachment[]> {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/messages/${encodeURIComponent(message.graphMessageId)}/attachments`;
    const response = await this.fetchJson<{ value: GraphAttachment[] }>(url);
    const accepted: IncomingAttachment[] = [];

    for (const attachment of response.value) {
      const fileType = attachment["@odata.type"] ?? "";
      const extension = path.extname(attachment.name ?? "").toLowerCase();
      if (attachment.isInline || fileType !== "#microsoft.graph.fileAttachment" || ![".pdf", ".xlsx"].includes(extension)) {
        continue;
      }

      const bytes = attachment.contentBytes
        ? Buffer.from(attachment.contentBytes, "base64")
        : await this.fetchAttachmentBytes(message.graphMessageId, attachment.id);

      accepted.push({
        sourceMailbox: this.config.graphMailboxUser,
        message,
        attachmentId: attachment.id,
        attachmentName: attachment.name,
        contentType: attachment.contentType ?? null,
        bytes
      });
    }

    return accepted;
  }

  private async fetchAttachmentBytes(messageId: string, attachmentId: string): Promise<Buffer> {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const attachment = await this.fetchJson<GraphAttachment>(url);
    if (!attachment.contentBytes) {
      throw new Error(`Attachment ${attachmentId} did not include contentBytes.`);
    }
    return Buffer.from(attachment.contentBytes, "base64");
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.config.graphClientId,
      client_secret: this.config.graphClientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    });

    const response = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.config.graphTenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Failed to obtain Graph access token: ${response.status} ${await response.text()}`);
    }

    const payload = await response.json() as GraphTokenResponse;
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = now + payload.expires_in * 1000;
    return this.accessToken;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new GraphRequestError(response.status, body);
    }

    return response.json() as Promise<T>;
  }
}

class GraphRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string
  ) {
    super(`Graph request failed with ${statusCode}: ${body}`);
    this.name = "GraphRequestError";
  }
}

function isDeltaResetError(error: unknown): boolean {
  if (!(error instanceof GraphRequestError)) {
    return false;
  }

  return error.statusCode === 404
    || error.statusCode === 410
    || /sync state/i.test(error.body)
    || /delta/i.test(error.body);
}

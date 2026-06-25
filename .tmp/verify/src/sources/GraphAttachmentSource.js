import path from "node:path";
export class GraphAttachmentSource {
    config;
    fetchImpl;
    accessToken = null;
    accessTokenExpiresAt = 0;
    constructor(config, fetchImpl = fetch) {
        this.config = config;
        this.fetchImpl = fetchImpl;
    }
    async pullAttachments(deltaToken) {
        const attachments = [];
        const meta = await this.scanAttachments(deltaToken, (batch) => {
            attachments.push(...batch);
        });
        return {
            attachments,
            ...meta
        };
    }
    async scanAttachments(deltaToken, onAttachments) {
        try {
            return await this.scanAttachmentsInner(deltaToken, false, onAttachments);
        }
        catch (error) {
            if (deltaToken && isDeltaResetError(error)) {
                return this.scanAttachmentsInner(null, true, onAttachments);
            }
            throw error;
        }
    }
    async scanAttachmentsInner(deltaToken, deltaWasReset, onAttachments) {
        let messagesSeen = 0;
        let nextLink = deltaToken;
        let deltaLink = null;
        if (!nextLink) {
            const folderPath = encodeURIComponent(this.config.graphMailFolder.toLowerCase());
            const baseUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/mailFolders/${folderPath}/messages/delta`;
            const select = "$select=id,subject,internetMessageId,from,sender,receivedDateTime,webLink,hasAttachments";
            nextLink = `${baseUrl}?${select}`;
        }
        while (nextLink) {
            const page = await this.fetchJson(nextLink);
            messagesSeen += page.value.length;
            for (const message of page.value) {
                if (!message.hasAttachments) {
                    continue;
                }
                const messageRef = {
                    graphMessageId: message.id,
                    internetMessageId: message.internetMessageId ?? null,
                    subject: message.subject ?? null,
                    senderEmail: message.from?.emailAddress?.address ?? message.sender?.emailAddress?.address ?? null,
                    receivedAt: message.receivedDateTime,
                    webLink: message.webLink ?? null
                };
                const messageAttachments = await this.fetchMessageAttachments(messageRef);
                if (messageAttachments.length > 0) {
                    await onAttachments(messageAttachments, { messagesSeen });
                }
            }
            deltaLink = page["@odata.deltaLink"] ?? deltaLink;
            nextLink = page["@odata.nextLink"] ?? null;
        }
        return {
            nextDeltaToken: deltaLink,
            deltaWasReset,
            messagesSeen
        };
    }
    async fetchMessageAttachments(message) {
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/messages/${encodeURIComponent(message.graphMessageId)}/attachments`;
        const response = await this.fetchJson(url);
        const accepted = [];
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
    async fetchAttachmentBytes(messageId, attachmentId) {
        const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.config.graphMailboxUser)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
        const attachment = await this.fetchJson(url);
        if (!attachment.contentBytes) {
            throw new Error(`Attachment ${attachmentId} did not include contentBytes.`);
        }
        return Buffer.from(attachment.contentBytes, "base64");
    }
    async getAccessToken() {
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
        const payload = await response.json();
        this.accessToken = payload.access_token;
        this.accessTokenExpiresAt = now + payload.expires_in * 1000;
        return this.accessToken;
    }
    async fetchJson(url) {
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
        return response.json();
    }
}
class GraphRequestError extends Error {
    statusCode;
    body;
    constructor(statusCode, body) {
        super(`Graph request failed with ${statusCode}: ${body}`);
        this.statusCode = statusCode;
        this.body = body;
        this.name = "GraphRequestError";
    }
}
function isDeltaResetError(error) {
    if (!(error instanceof GraphRequestError)) {
        return false;
    }
    return error.statusCode === 404
        || error.statusCode === 410
        || /sync state/i.test(error.body)
        || /delta/i.test(error.body);
}

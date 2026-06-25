import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { IngestionService, ReparseOperationError } from "../src/services/IngestionService.js";
test("manual scan starts in the background and can be polled by run id", async () => {
    const scanStarted = createDeferred();
    const releaseScan = createDeferred();
    const context = await createRouteTestContext({
        async pullAttachments(_deltaToken) {
            return {
                attachments: [],
                nextDeltaToken: "delta-after-test",
                deltaWasReset: false,
                messagesSeen: 0
            };
        },
        async scanAttachments(_deltaToken, onAttachments) {
            await onAttachments([
                {
                    sourceMailbox: "auditor@eternalhotels.com",
                    message: {
                        graphMessageId: "approved-message",
                        internetMessageId: "<approved@local.test>",
                        subject: "Approved sender",
                        senderEmail: "ops@eternalhotels.com",
                        receivedAt: "2026-06-04T08:00:00.000Z",
                        webLink: null
                    },
                    attachmentId: "approved-attachment",
                    attachmentName: "daily.xlsx",
                    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    bytes: Buffer.from("approved")
                },
                {
                    sourceMailbox: "auditor@eternalhotels.com",
                    message: {
                        graphMessageId: "blocked-message",
                        internetMessageId: "<blocked@local.test>",
                        subject: "Blocked sender",
                        senderEmail: "fraud@bad-actor.com",
                        receivedAt: "2026-06-04T08:05:00.000Z",
                        webLink: null
                    },
                    attachmentId: "blocked-attachment",
                    attachmentName: "blocked.pdf",
                    contentType: "application/pdf",
                    bytes: Buffer.from("%PDF-1.4")
                }
            ], { messagesSeen: 2 });
            scanStarted.resolve();
            await releaseScan.promise;
            return {
                nextDeltaToken: "delta-after-test",
                deltaWasReset: false,
                messagesSeen: 2
            };
        }
    });
    try {
        const adminCookie = await loginAdmin(context.baseUrl);
        const startResponse = await fetch(`${context.baseUrl}/api/ingest/run`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({ fullRescan: true })
        });
        assert.equal(startResponse.status, 202);
        const startPayload = await startResponse.json();
        assert.equal(startPayload.status, "running");
        assert.equal(startPayload.triggerSource, "manual");
        assert.equal(startPayload.active, true);
        assert.ok(Number.isInteger(startPayload.runId));
        const runId = Number(startPayload.runId);
        await scanStarted.promise;
        const latestRun = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/latest`, adminCookie);
        assert.equal(latestRun.id, runId);
        assert.equal(latestRun.status, "running");
        assert.equal(latestRun.active, true);
        const progress = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/${runId}/progress`, adminCookie);
        assert.equal(progress.id, runId);
        assert.equal(progress.status, "running");
        assert.equal(progress.active, true);
        assert.equal(progress.attachments_seen, 2);
        assert.equal(progress.attachments_approved, 1);
        assert.equal(progress.attachments_not_approved, 1);
        assert.equal(progress.attachments_deferred, 1);
        const runById = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/${runId}`, adminCookie);
        assert.equal(runById.id, runId);
        assert.equal(runById.status, "running");
        assert.equal(runById.active, true);
        const conflictResponse = await fetch(`${context.baseUrl}/api/ingest/run`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                cookie: adminCookie
            },
            body: JSON.stringify({ fullRescan: true })
        });
        assert.equal(conflictResponse.status, 409);
        const conflictPayload = await conflictResponse.json();
        assert.equal(conflictPayload.activeRunId, runId);
        assert.match(String(conflictPayload.error ?? ""), /active inbox sync|another mailbox scan/i);
        releaseScan.resolve();
        const completedRun = await waitForRun(context.baseUrl, adminCookie, runId, (run) => run.status !== "running");
        assert.equal(completedRun.status, "completed");
        assert.equal(completedRun.active, false);
        const dashboard = await fetchJsonAbsolute(`${context.baseUrl}/api/dashboard`, adminCookie);
        assert.equal(dashboard.latestRun.id, runId);
        assert.equal(dashboard.latestRun.status, "completed");
        assert.equal(dashboard.latestRun.active, false);
    }
    finally {
        releaseScan.resolve();
        await context.dispose();
    }
});
test("stored report reparse starts in the background and can be polled by run id", async () => {
    const context = await createBlockingReparseRouteTestContext();
    try {
        const adminCookie = await loginAdmin(context.baseUrl);
        const startResponse = await fetch(`${context.baseUrl}/api/ingest/reparse`, {
            method: "POST",
            headers: {
                cookie: adminCookie
            }
        });
        assert.equal(startResponse.status, 202);
        const startPayload = await startResponse.json();
        assert.equal(startPayload.status, "running");
        assert.equal(startPayload.triggerSource, "reparse");
        assert.equal(startPayload.active, true);
        assert.ok(Number.isInteger(startPayload.runId));
        const runId = Number(startPayload.runId);
        await context.waitForReparseStart();
        const latestRun = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/latest`, adminCookie);
        assert.equal(latestRun.id, runId);
        assert.equal(latestRun.status, "running");
        assert.equal(latestRun.trigger_source, "reparse");
        assert.equal(latestRun.active, true);
        const progress = await fetchJsonAbsolute(`${context.baseUrl}/api/runs/${runId}/progress`, adminCookie);
        assert.equal(progress.id, runId);
        assert.equal(progress.status, "running");
        assert.equal(progress.trigger_source, "reparse");
        assert.equal(progress.active, true);
        const conflictResponse = await fetch(`${context.baseUrl}/api/ingest/reparse`, {
            method: "POST",
            headers: {
                cookie: adminCookie
            }
        });
        assert.equal(conflictResponse.status, 409);
        const conflictPayload = await conflictResponse.json();
        assert.equal(conflictPayload.activeRunId, runId);
        assert.match(String(conflictPayload.error ?? ""), /active ingestion run/i);
        context.finishReparse();
        const completedRun = await waitForRun(context.baseUrl, adminCookie, runId, (run) => run.status !== "running");
        assert.equal(completedRun.status, "completed");
        assert.equal(completedRun.trigger_source, "reparse");
        assert.equal(completedRun.active, false);
        assert.equal(completedRun.attachments_parsed, 2);
        assert.equal(completedRun.attachments_deferred, 1);
    }
    finally {
        context.finishReparse();
        await context.dispose();
    }
});
async function createRouteTestContext(source) {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-ingest-routes-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    const authService = new AuthService(database);
    const adminUser = database.getUserByUsername("admin");
    assert.ok(adminUser);
    authService.updateUserPassword(Number(adminUser.id), "AdminPass123!");
    const service = new IngestionService(database, source, dataDir, ["*@eternalhotels.com"]);
    const app = createApp(mockConfig(), database, service, authService);
    const server = await listen(app);
    const port = server.address().port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        dispose: async () => {
            for (let attempt = 0; attempt < 100 && service.getActiveRunId() !== null; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await closeServer(server);
            database.close();
            await rm(root, { recursive: true, force: true });
        }
    };
}
async function createBlockingReparseRouteTestContext() {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-reparse-routes-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    const authService = new AuthService(database);
    const adminUser = database.getUserByUsername("admin");
    assert.ok(adminUser);
    authService.updateUserPassword(Number(adminUser.id), "AdminPass123!");
    const service = new BlockingReparseIngestionService(database, dataDir);
    const app = createApp(mockConfig(), database, service, authService);
    const server = await listen(app);
    const port = server.address().port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        waitForReparseStart: () => service.waitForReparseStart(),
        finishReparse: () => service.finishReparse(),
        dispose: async () => {
            service.finishReparse();
            for (let attempt = 0; attempt < 100 && service.getActiveRunId() !== null; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await closeServer(server);
            database.close();
            await rm(root, { recursive: true, force: true });
        }
    };
}
async function loginAdmin(baseUrl) {
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            authorizedUserConfirmed: true,
            username: "admin",
            password: "AdminPass123!"
        })
    });
    assert.equal(loginResponse.status, 200);
    return extractCookie(String(loginResponse.headers.get("set-cookie") ?? ""));
}
async function waitForRun(baseUrl, cookie, runId, predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const run = await fetchJsonAbsolute(`${baseUrl}/api/runs/${runId}`, cookie);
        if (predicate(run)) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Run ${runId} did not reach the expected status in time.`);
}
function mockConfig() {
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
async function fetchJsonAbsolute(url, cookie) {
    const response = await fetch(url, {
        headers: cookie ? { cookie } : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
}
function extractCookie(header) {
    return header.split(";")[0] ?? "";
}
function createDeferred() {
    let settled = false;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(value);
        };
        rejectPromise = (reason) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(reason);
        };
    });
    return {
        promise,
        resolve: (value) => resolvePromise(value),
        reject: (reason) => rejectPromise(reason)
    };
}
class BlockingReparseIngestionService extends IngestionService {
    routeTestDatabase;
    reparseStarted = createDeferred();
    releaseReparse = createDeferred();
    activeReparseRunId = null;
    constructor(routeTestDatabase, dataDir) {
        super(routeTestDatabase, {
            async pullAttachments() {
                return {
                    attachments: [],
                    nextDeltaToken: null,
                    deltaWasReset: false,
                    messagesSeen: 0
                };
            }
        }, dataDir);
        this.routeTestDatabase = routeTestDatabase;
    }
    startReparseRun() {
        if (this.activeReparseRunId !== null) {
            throw new ReparseOperationError("Please wait for the active ingestion run to finish before reparsing stored reports.");
        }
        const runId = this.routeTestDatabase.createRun("reparse");
        this.activeReparseRunId = runId;
        this.routeTestDatabase.updateRunProgress(runId, emptySummary());
        void (async () => {
            this.reparseStarted.resolve(runId);
            await this.releaseReparse.promise;
            const summary = {
                ...emptySummary(),
                messagesSeen: 3,
                attachmentsSeen: 3,
                attachmentsApproved: 3,
                attachmentsParsed: 2,
                attachmentsDeferred: 1
            };
            this.routeTestDatabase.finishRun(runId, "completed", summary);
            if (this.activeReparseRunId === runId) {
                this.activeReparseRunId = null;
            }
        })();
        return {
            runId,
            status: "running",
            triggerSource: "reparse"
        };
    }
    getActiveRunId() {
        return this.activeReparseRunId ?? super.getActiveRunId();
    }
    isRunActive(runId) {
        return this.activeReparseRunId === runId || super.isRunActive(runId);
    }
    async waitForReparseStart() {
        return this.reparseStarted.promise;
    }
    finishReparse() {
        this.releaseReparse.resolve();
    }
}
function emptySummary() {
    return {
        messagesSeen: 0,
        attachmentsSeen: 0,
        attachmentsApproved: 0,
        attachmentsNotApproved: 0,
        attachmentsArchived: 0,
        attachmentsParsed: 0,
        attachmentsDeferred: 0,
        attachmentsFailed: 0,
        notes: []
    };
}
async function listen(app) {
    return await new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => {
            resolve(server);
        });
    });
}
async function closeServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AuthService } from "../src/auth/AuthService.js";
import { AppDatabase } from "../src/db/Database.js";
import { createApp } from "../src/http/createApp.js";
import { IngestionService } from "../src/services/IngestionService.js";
test("production auth routes mark session cookies as Secure", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const context = await createRouteTestContext();
    try {
        const loginResponse = await fetch(`${context.baseUrl}/api/auth/login`, {
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
        const loginCookie = String(loginResponse.headers.get("set-cookie") ?? "");
        assert.match(loginCookie, /;\s*Secure/i);
        const logoutResponse = await fetch(`${context.baseUrl}/api/auth/logout`, {
            method: "POST",
            headers: {
                cookie: extractCookie(loginCookie)
            }
        });
        assert.equal(logoutResponse.status, 204);
        const logoutCookie = String(logoutResponse.headers.get("set-cookie") ?? "");
        assert.match(logoutCookie, /;\s*Secure/i);
    }
    finally {
        if (typeof originalNodeEnv === "undefined") {
            delete process.env.NODE_ENV;
        }
        else {
            process.env.NODE_ENV = originalNodeEnv;
        }
        await context.dispose();
    }
});
async function createRouteTestContext() {
    const root = await mkdtemp(path.join(tmpdir(), "synchro-auth-routes-"));
    const dataDir = path.join(root, "storage");
    const database = await AppDatabase.open(path.join(dataDir, "app.sqlite"));
    const authService = new AuthService(database);
    const adminUser = database.getUserByUsername("admin");
    assert.ok(adminUser);
    authService.updateUserPassword(Number(adminUser.id), "AdminPass123!");
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
    const app = createApp(mockConfig(), database, service, authService);
    const server = await listen(app);
    const port = server.address().port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        dispose: async () => {
            await closeServer(server);
            database.close();
            await rm(root, { recursive: true, force: true });
        }
    };
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
function extractCookie(header) {
    return header.split(";")[0] ?? "";
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

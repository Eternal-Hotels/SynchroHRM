import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
export class SecretConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = "SecretConfigurationError";
    }
}
export function getSecretMasterKeyStatus(value) {
    if (!value) {
        return {
            configured: false,
            key: null,
            error: "NetSuite secret storage is unavailable because SYNCHRO_SECRET_MASTER_KEY is not configured on the server."
        };
    }
    try {
        return {
            configured: true,
            key: parseSecretMasterKey(value),
            error: null
        };
    }
    catch (error) {
        return {
            configured: false,
            key: null,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
export function parseSecretMasterKey(value) {
    const normalized = value.trim();
    if (!normalized) {
        throw new SecretConfigurationError("SYNCHRO_SECRET_MASTER_KEY is blank.");
    }
    const key = Buffer.from(normalized, "base64");
    if (key.length !== 32) {
        throw new SecretConfigurationError("SYNCHRO_SECRET_MASTER_KEY must be a base64-encoded 32-byte key.");
    }
    return key;
}
export function encryptSecret(plainText, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final()
    ]);
    const payload = {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
    };
    return JSON.stringify(payload);
}
export function decryptSecret(encodedPayload, key) {
    let payload;
    try {
        payload = JSON.parse(encodedPayload);
    }
    catch {
        throw new SecretConfigurationError("Encrypted secret payload is not valid JSON.");
    }
    if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
        throw new SecretConfigurationError("Encrypted secret payload uses an unsupported format.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    try {
        const plainText = Buffer.concat([
            decipher.update(Buffer.from(payload.ciphertext, "base64")),
            decipher.final()
        ]);
        return plainText.toString("utf8");
    }
    catch {
        throw new SecretConfigurationError("Encrypted secret payload could not be decrypted with the configured master key.");
    }
}

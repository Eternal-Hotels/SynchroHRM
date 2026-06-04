import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EncryptedSecretPayload {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigurationError";
  }
}

export interface SecretMasterKeyStatus {
  configured: boolean;
  key: Buffer | null;
  error: string | null;
}

export function getSecretMasterKeyStatus(value: string | null | undefined): SecretMasterKeyStatus {
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
  } catch (error) {
    return {
      configured: false,
      key: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function parseSecretMasterKey(value: string): Buffer {
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

export function encryptSecret(plainText: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final()
  ]);
  const payload: EncryptedSecretPayload = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
  return JSON.stringify(payload);
}

export function decryptSecret(encodedPayload: string, key: Buffer): string {
  let payload: EncryptedSecretPayload;
  try {
    payload = JSON.parse(encodedPayload) as EncryptedSecretPayload;
  } catch {
    throw new SecretConfigurationError("Encrypted secret payload is not valid JSON.");
  }

  if (payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
    throw new SecretConfigurationError("Encrypted secret payload uses an unsupported format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

  try {
    const plainText = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]);
    return plainText.toString("utf8");
  } catch {
    throw new SecretConfigurationError("Encrypted secret payload could not be decrypted with the configured master key.");
  }
}


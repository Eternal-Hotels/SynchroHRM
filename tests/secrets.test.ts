import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, getSecretMasterKeyStatus } from "../src/utils/secrets.js";

test("encrypted secrets round-trip with AES-256-GCM", () => {
  const key = randomBytes(32);
  const encrypted = encryptSecret("top secret value", key);
  assert.notEqual(encrypted.includes("top secret value"), true);

  const decrypted = decryptSecret(encrypted, key);
  assert.equal(decrypted, "top secret value");
});

test("missing secret master key reports connector storage as unavailable", () => {
  const status = getSecretMasterKeyStatus(null);
  assert.equal(status.configured, false);
  assert.equal(status.key, null);
  assert.match(status.error || "", /SYNCHRO_SECRET_MASTER_KEY/i);
});


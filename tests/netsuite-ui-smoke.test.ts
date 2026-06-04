import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("admin NetSuite settings UI wires the expected fields and endpoints", async () => {
  const html = await readFile("src/ui/admin-panel.html", "utf8");
  const client = await readFile("src/ui/admin-client.js", "utf8");
  const viewer = await readFile("src/ui/viewer-panel.html", "utf8");

  for (const id of [
    "netsuite-settings-form",
    "netsuite-service-base-url-input",
    "netsuite-client-id-input",
    "netsuite-certificate-id-input",
    "netsuite-jwt-algorithm-input",
    "netsuite-probe-query-input",
    "netsuite-private-key-input",
    "netsuite-save-button",
    "netsuite-test-button",
    "netsuite-clear-key-button",
    "netsuite-last-test",
    "netsuite-export-catalog-button",
    "netsuite-last-catalog-export",
    "netsuite-catalog-download-link"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /NetSuite Connector/);
  assert.match(html, /Test Connection/);
  assert.match(html, /Export Metadata Catalog CSV/);
  assert.match(html, /Clear Saved Key/);
  assert.match(client, /\/api\/settings\/netsuite/);
  assert.match(client, /\/api\/settings\/netsuite\/test/);
  assert.match(client, /\/api\/settings\/netsuite\/debug\/metadata-catalog\/export/);
  assert.match(html, /\/api\/settings\/netsuite\/debug\/metadata-catalog\/latest/);
  assert.doesNotMatch(viewer, /NetSuite Connector/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorPreview } from "../build/connector-preview-plugin.mjs";

test("preview denies private configuration, credential files and local state", () => {
  const config = connectorPreview().config({});
  assert.equal(config.server.host, "127.0.0.1");
  for (const pattern of [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.sites-runtime/**",
    "**/.openai/**", "**/.dev.vars*", "**/.wrangler/**", "**/client_secret*.json", "**/credentials*.json"]) {
    assert.ok(config.server.fs.deny.includes(pattern), pattern);
  }
  assert.equal(connectorPreview().config({ server: { host: "0.0.0.0" } }).server.host, "0.0.0.0");
});

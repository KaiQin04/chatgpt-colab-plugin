import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorPreview } from "../build/connector-preview-plugin.mjs";
import { driverMessageSchema, invocationSchema } from "../scripts/connector-preview/protocol.mjs";

test("preview denies private configuration, credential files and local state", () => {
  const config = connectorPreview().config({});
  assert.equal(config.server.host, "127.0.0.1");
  for (const pattern of [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.sites-runtime/**",
    "**/.openai/**", "**/.dev.vars*", "**/.wrangler/**", "**/client_secret*.json", "**/credentials*.json"]) {
    assert.ok(config.server.fs.deny.includes(pattern), pattern);
  }
  assert.equal(connectorPreview().config({ server: { host: "0.0.0.0" } }).server.host, "0.0.0.0");
});

test("preview protocol retains arbitrary JSON records and rejects widened envelopes with Zod 4", () => {
  const args = { query: "synthetic", limit: 2, nested: { enabled: true }, values: [null, "x"] };
  const invocation = { connectorId: "synthetic", actionName: "search", arguments: args };
  assert.deepEqual(invocationSchema.parse(invocation), invocation);
  assert.equal(invocationSchema.safeParse({ ...invocation, accountId: "other" }).success, false);
  assert.equal(invocationSchema.safeParse({ ...invocation, arguments: [] }).success, false);
  const response = {
    jsonrpc: "2.0", id: "11111111-1111-4111-8111-111111111111", result: args,
  };
  assert.deepEqual(driverMessageSchema.parse(response), response);
  assert.equal(driverMessageSchema.safeParse({ ...response, result: [] }).success, false);
});

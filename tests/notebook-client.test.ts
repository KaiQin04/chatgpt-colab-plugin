import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeClient, createFetchClient, MCP_APPS_PROTOCOL } from "../lib/notebook/client.ts";
import type { BridgeHost } from "../lib/notebook/client.ts";

test("fetch client posts the tool envelope and maps failures to fixed codes", async () => {
  const seen: { url: string; body: unknown; credentials?: string }[] = [];
  const ok = createFetchClient({ fetch: async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init!.body)), credentials: init!.credentials });
    return Response.json({ notebooks: [] });
  } });
  assert.deepEqual(await ok.call("get_notebook", {}), { notebooks: [] });
  assert.deepEqual(seen, [{ url: "/api/notebooks", body: { name: "get_notebook", arguments: {} }, credentials: "same-origin" }]);

  const denied = createFetchClient({ fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(denied.call("get_notebook", {}), /^Error: http_403$/);
  const array = createFetchClient({ fetch: async () => Response.json([1]) });
  await assert.rejects(array.call("get_notebook", {}), /invalid_site_result/);
});

test("fetch client aborts after its request budget", async () => {
  const slow = createFetchClient({ timeoutMs: 10, fetch: (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
  }) });
  await assert.rejects(slow.call("get_notebook", {}), /aborted/);
});

class FakeHost implements BridgeHost {
  sent: Record<string, unknown>[] = [];
  listeners = new Set<(event: { source: unknown; data: unknown }) => void>();
  parent = { postMessage: (message: unknown) => { this.sent.push(message as Record<string, unknown>); this.respond?.(message as Record<string, unknown>); } };
  respond?: (message: Record<string, unknown>) => void;
  addEventListener(_type: "message", listener: (event: { source: unknown; data: unknown }) => void) { this.listeners.add(listener); }
  removeEventListener(_type: "message", listener: (event: { source: unknown; data: unknown }) => void) { this.listeners.delete(listener); }
  deliver(data: unknown, source: unknown = this.parent) { this.listeners.forEach((listener) => listener({ source, data })); }
}

function autoReply(host: FakeHost, result: (message: Record<string, unknown>) => unknown) {
  host.respond = (message) => {
    if (typeof message.id !== "number") return;
    queueMicrotask(() => host.deliver({ jsonrpc: "2.0", id: message.id, result: result(message) }));
  };
}

test("bridge client initializes, calls tools and ignores foreign messages", async () => {
  const host = new FakeHost();
  autoReply(host, (message) => message.method === "tools/call"
    ? { structuredContent: { notebooks: ["synthetic"] } } : {});
  const client = await createBridgeClient({ host, appInfo: { name: "Colab Notebook", version: "test" } });
  assert.equal(host.sent[0].method, "ui/initialize");
  assert.equal((host.sent[0].params as Record<string, unknown>).protocolVersion, MCP_APPS_PROTOCOL);
  assert.equal(host.sent[1].method, "ui/notifications/initialized");

  // A message from another window with a colliding id must not settle the call.
  host.respond = (message) => {
    if (message.method !== "tools/call") return;
    queueMicrotask(() => {
      host.deliver({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { forged: true } } }, {});
      host.deliver({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { notebooks: [] } } });
    });
  };
  assert.deepEqual(await client.call("get_notebook", {}), { notebooks: [] });

  for (const name of ["upsert_cell", "run_cell"] as const) {
    await client.call(name, {} as never);
    assert.equal((host.sent.at(-1)!.params as { name: string }).name, `ui_${name}`);
  }

  const pushed: unknown[] = [];
  const stop = client.onToolResult((value) => pushed.push(value));
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { a: 1 } } });
  stop();
  host.deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { a: 2 } } });
  assert.deepEqual(pushed, [{ a: 1 }]);
  client.dispose();
  assert.equal(host.listeners.size, 0);
});

test("bridge client maps host errors, missing content and timeouts to fixed codes", async () => {
  const host = new FakeHost();
  autoReply(host, () => ({}));
  const client = await createBridgeClient({ host, appInfo: { name: "t", version: "t" }, timeoutMs: 20 });
  await assert.rejects(client.call("get_notebook", {}), /invalid_host_result/);
  host.respond = (message) => {
    if (typeof message.id === "number") queueMicrotask(() => host.deliver({ jsonrpc: "2.0", id: message.id, error: { code: -1 } }));
  };
  await assert.rejects(client.call("get_notebook", {}), /bridge_error_unknown/);
  host.respond = undefined;
  await assert.rejects(client.call("get_notebook", {}), /bridge_timeout_unknown/);
  client.dispose();

  const silent = new FakeHost();
  await assert.rejects(createBridgeClient({ host: silent, appInfo: { name: "t", version: "t" }, timeoutMs: 10 }),
    /bridge_timeout_unknown/);
  assert.equal(silent.listeners.size, 0);
});

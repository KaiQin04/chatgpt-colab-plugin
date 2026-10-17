import assert from "node:assert/strict";
import { test } from "node:test";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { mcpPost } from "../lib/mcp/transport.ts";
import { TOOLS } from "../lib/mcp/registry.ts";
import { PANEL_URI, PANEL_MIME } from "../lib/notebook/panel.ts";
import { NOTEBOOK_UI_SOURCE_HASH } from "../lib/notebook/ui-bundle.generated.ts";
import { fixture, noNetwork, OTHER, OWNER } from "./helpers.ts";

interface RpcResponse {
  result: {
    tools: unknown[];
    isError?: boolean;
    structuredContent: {
      error: { code: string };
      notebooks?: unknown[];
    };
    contents: { mimeType: string; text: string;
      _meta: { ui: { csp: { connectDomains: string[] } } } }[];
  };
}

test("panel resource URI versions the UI so hosts do not reuse a stale editor", () => {
  assert.equal(PANEL_URI, `ui://colab-spike/panel-${NOTEBOOK_UI_SOURCE_HASH.slice(0, 16)}.html`);
});

function rpc(method: string, params: unknown = {}, owner: typeof OWNER | null = OWNER) {
  return new Request(`${SITE_ORIGIN}/mcp`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(owner ? {
      "oai-authenticated-user-id": owner.userId,
      "oai-authenticated-user-email": owner.email,
    } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("MCP 2026-07-28 discovery and resource responses include required cache hints", async () => {
  const f = fixture();
  try {
    for (const method of ["server/discover", "tools/list", "resources/list", "resources/read"]) {
      const request = rpc(method, {
        ...(method === "resources/read" ? { uri: PANEL_URI } : {}),
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }, null);
      request.headers.set("MCP-Protocol-Version", "2026-07-28");
      const response = await mcpPost(request, f.env, noNetwork);
      const body = await response.json() as { result: Record<string, unknown> };
      assert.equal(body.result.resultType, "complete", method);
      assert.equal(body.result.ttlMs, 0, method);
      assert.equal(body.result.cacheScope, "private", method);
    }
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM site_owner").get()!.count, 0);
  } finally { f.close(); }
});

test("panel supports direct sidebar and thread entrypoints without allocating compute", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    "colab_spike_panel", "get_runtime_settings", "set_runtime_settings", "prepare_runtime",
    "get_compute_status", "open_notebook", "import_file", "upsert_cell", "move_cell", "delete_cell", "run_cell",
    "get_notebook", "interrupt_cell", "close_notebook", "export_ipynb", "rename_notebook", "delete_notebook",
    "get_artifacts", "pin_artifact", "maintain_notebooks", "ui_upsert_cell", "ui_run_cell",
  ]);
  for (const name of ["delete_cell", "delete_notebook"]) {
    assert.equal(TOOLS.find((tool) => tool.name === name)!.annotations.destructiveHint, true, name);
  }
  const panel = TOOLS.find((tool) => tool.name === "colab_spike_panel")!;
  assert.equal(panel._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(panel._meta["openai/ui"].entrypoints, [{ type: "global" }, { type: "thread" }]);
  // export_ipynb records notebook activity, so it is not read-only.
  const exported = TOOLS.find((tool) => tool.name === "export_ipynb")!;
  assert.equal(exported.annotations.readOnlyHint, false);
  assert.equal(exported.annotations.destructiveHint, false);
});

test("static discovery works without visitor identity but tool execution fails closed", async () => {
  const f = fixture();
  try {
    const listing = await (await mcpPost(rpc("tools/list", {}, null), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(listing.result.tools.length, 22);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM site_owner").get()!.count, 0);
    const denied = await (await mcpPost(rpc("tools/call", { name: "colab_spike_panel" }, null), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(denied.result.isError, true);
    assert.equal(denied.result.structuredContent.error.code, "authenticated_identity_required");
    const allowed = await (await mcpPost(rpc("tools/call", { name: "colab_spike_panel" }), f.env, noNetwork)).json() as RpcResponse;
    assert.ok(Array.isArray(allowed.result.structuredContent.notebooks));
    assert.ok(!JSON.stringify(allowed).includes(OWNER.userId));
    assert.ok(!JSON.stringify(allowed).includes(OWNER.email));
    const other = await (await mcpPost(rpc("tools/call", { name: "colab_spike_panel" }, OTHER), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(other.result.structuredContent.error.code, "owner_required");
  } finally { f.close(); }
});

test("static resource needs no visitor ID and neither enrolls nor reads account data", async () => {
  const f = fixture();
  try {
    const resource = await (await mcpPost(rpc("resources/read", { uri: PANEL_URI }, null), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM site_owner").get()!.count, 0);
    const content = resource.result.contents[0];
    assert.equal(content.mimeType, PANEL_MIME);
    assert.ok(content.text.includes("ui/initialize"));
    assert.ok(content.text.includes("2026-01-26"));
    assert.ok(content.text.includes("ui/notifications/tool-result"));
    assert.ok(content.text.includes('window.__CCM_MODE__="mcp"'));
    assert.deepEqual(content._meta.ui.csp.connectDomains, []);
    assert.deepEqual((content._meta as unknown as Record<string, unknown>)["openai/ui"], {
      availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen",
    });
    assert.deepEqual((content._meta as unknown as Record<string, { redirect_domains: string[] }>)["openai/widgetCSP"].redirect_domains, [SITE_ORIGIN]);
    assert.ok(!content.text.includes("spike_ws_exec"));
  } finally { f.close(); }
});

test("removed feasibility tools are unknown and the panel rejects arguments", async () => {
  const f = fixture();
  try {
    for (const name of ["spike_runtime_info", "spike_colab_status", "spike_wait", "spike_ws_exec"]) {
      const response = await (await mcpPost(rpc("tools/call", { name, arguments: {} }), f.env, noNetwork)).json() as RpcResponse;
      assert.equal(response.result.isError, true);
      assert.equal(response.result.structuredContent.error.code, "unknown_tool");
    }
    const injected = await (await mcpPost(rpc("tools/call", { name: "colab_spike_panel", arguments: { allowSpend: true } }), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(injected.result.structuredContent.error.code, "unexpected_tool_arguments");
    const malformed = await (await mcpPost(rpc("tools/call", { name: "colab_spike_panel", arguments: [] }), f.env, noNetwork)).json() as RpcResponse;
    assert.equal(malformed.result.structuredContent.error.code, "invalid_tool_arguments");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM probe_runs").get()!.count, 0);
  } finally { f.close(); }
});

test("cross-site browser requests are rejected before any tool execution", async () => {
  const f = fixture();
  try {
    const request = rpc("tools/call", { name: "colab_spike_panel" });
    request.headers.set("Origin", "https://attacker.example.test");
    assert.equal((await mcpPost(request, f.env, noNetwork)).status, 403);
  } finally { f.close(); }
});

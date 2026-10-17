/**
 * Golden snapshots that pin externally visible behaviour during refactors:
 * the MCP tool listing, the MCP Apps panel resource, and the notebook
 * document / export JSON for a fixed synthetic flow. Regenerate only for an
 * intended change: UPDATE_GOLDEN=1 npm test, then review the diff.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { notebookCall } from "../lib/notebook/service.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import type { RunResult, RuntimeRow, SetupRowLike } from "./golden-types.ts";
import { CPU_COMPUTE } from "../lib/notebook/compute.ts";
import type { ComputeChoice, ObservedCompute } from "../lib/notebook/compute.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { mcpPost } from "../lib/mcp/transport.ts";
import { PANEL_URI } from "../lib/notebook/panel.ts";
import { encryptToken } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, noNetwork, OWNER, REFRESH, syntheticComputeStatus, tokenPayload } from "./helpers.ts";

const GOLDEN = new URL("./golden/", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";

function golden(name: string, actual: unknown): void {
  const path = new URL(name, GOLDEN);
  const text = `${JSON.stringify(actual, null, 2).replaceAll(SITE_ORIGIN, "https://site.example.test")}\n`;
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  assert.equal(text, readFileSync(path, "utf8"), `golden mismatch: ${name}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIXED_IDS = new Set([
  "11111111-1111-4111-8111-111111111111",
  "33333333-3333-4333-8333-333333333333",
]);
const VOLATILE_NUMBER = /(At|_at|Ms|Seconds|milliseconds|since)$/;

/** Replace clock values and random identifiers with stable placeholders. */
function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, normalize(v, k)]));
  }
  if (typeof value === "number" && VOLATILE_NUMBER.test(key)) return "<time>";
  if (typeof value === "string" && UUID.test(value) && !FIXED_IDS.has(value)) return "<uuid>";
  if (typeof value === "string" && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return "<iso-time>";
  return value;
}

function rpc(method: string, params: unknown = {}, owner: typeof OWNER | null = OWNER): Request {
  return new Request(`${SITE_ORIGIN}/mcp`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(owner ? {
      "oai-authenticated-user-id": owner.userId,
      "oai-authenticated-user-email": owner.email,
    } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

test("golden: tools/list is unchanged", async () => {
  const f = fixture();
  try {
    const response = await mcpPost(rpc("tools/list", {}, null), f.env, noNetwork);
    const body = await response.json() as { result: { tools: unknown[] } };
    golden("tools-list.json", body.result.tools);
  } finally { f.close(); }
});

test("golden: MCP Apps panel resource is unchanged", async () => {
  const f = fixture();
  try {
    const response = await mcpPost(rpc("resources/read", { uri: PANEL_URI }, null), f.env, noNetwork);
    const body = await response.json() as {
      result: { contents: { uri: string; mimeType: string; text: string; _meta?: unknown }[] };
    };
    golden("panel-resource.json", body.result.contents.map(({ text, ...rest }) => ({
      ...rest, textSha256: createHash("sha256").update(text.replaceAll(SITE_ORIGIN, "https://site.example.test")).digest("hex"), textLength: text.replaceAll(SITE_ORIGIN, "https://site.example.test").length,
    })));
  } finally { f.close(); }
});

class GoldenRuntime {
  runId = "";
  value: RunResult | null = null;
  async computeStatus() { return syntheticComputeStatus(); }
  async submitInput(): Promise<void> { throw new Error("unexpected_input"); }
  async pollInput(): Promise<null> { return null; }
  async submitSetup(): Promise<void> {}
  async pollSetup(_runtime: RuntimeRow, job: SetupRowLike) {
    return { protocol: 1, jobId: job.id, status: "ready", phase: "ready",
      packages: JSON.parse(job.config_json).map((name: string) => ({ name, version: "1.0.0", installed: false })),
      blender: null, error: null, startedAt: 1, finishedAt: 2 };
  }
  async allocate(_hash: string, _signal: AbortSignal, capture: (endpoint: string) => Promise<void>,
    attempt: (value: boolean) => void, choice: ComputeChoice = CPU_COMPUTE): Promise<ObservedCompute> {
    attempt(true);
    await capture("synthetic-golden-endpoint");
    return { ...choice, variant: choice.kind === "CPU" ? "DEFAULT" : "GPU" };
  }
  async startKernel(): Promise<string> { return "synthetic-kernel-id"; }
  async submit(_runtime: RuntimeRow, id: string): Promise<void> { this.runId = id; }
  async poll(): Promise<RunResult | null> { return this.value; }
  async readArtifact(): Promise<Uint8Array<ArrayBuffer>> { throw new Error("unexpected_artifact_read"); }
  async interrupt(): Promise<void> {}
  async release(): Promise<{ released: boolean }> { return { released: true }; }
}

test("golden: notebook document and ipynb export are unchanged", async () => {
  const f = fixture();
  try {
    const security = new Store(f.env);
    await security.owner(OWNER);
    await security.saveGrant({ owner_id: OWNER.userId, google_subject: "synthetic-google-subject",
      masked_email: "g…@e…st", encrypted_refresh_token: await encryptToken(REFRESH,
        f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, "synthetic-google-subject") });
    const remote = new GoldenRuntime();
    const call = (name: string, args: Record<string, unknown>) => notebookCall(name,
      validateNotebookArguments(name, args), f.env, OWNER, {
        fetcher: async () => Response.json(tokenPayload(f.env)), runtimeFactory: () => remote as never,
      });
    const notebookId = "11111111-1111-4111-8111-111111111111";
    const cellId = "33333333-3333-4333-8333-333333333333";
    await call("open_notebook", { notebookId, title: "Golden notebook", idempotencyKey: "golden-open-1" });
    await call("get_notebook", { notebookId });
    await call("get_notebook", { notebookId });
    const before = await call("get_notebook", { notebookId }) as { notebook: { version: number } };
    await call("upsert_cell", { notebookId, cellId, kind: "code", source: "x = 42\nprint(x)",
      expectedVersion: 0, notebookVersion: before.notebook.version });
    await call("run_cell", { notebookId, cellId, cellVersion: 1, idempotencyKey: "golden-run-1" });
    remote.value = { protocol: 1, runId: remote.runId, status: "ok",
      outputs: [{ output_type: "stream", name: "stdout", text: "42\n" }],
      startedAt: Date.now(), finishedAt: Date.now(), executionCount: 1, truncated: false,
      artifacts: { files: [], errors: [] } } as RunResult;
    const document = await call("get_notebook", { notebookId });
    golden("notebook-document.json", normalize(document));
    const exported = await call("export_ipynb", { notebookId });
    golden("notebook-export.json", normalize(exported));
  } finally { f.close(); }
});

/** Exercise the real MCP boundary and SQLite ledger without Colab network calls. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTool, TOOLS } from "../lib/mcp/registry.ts";
import { CPU_COMPUTE } from "../lib/notebook/compute.ts";
import { NotebookStore } from "../lib/notebook/store.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, noNetwork, OTHER, OWNER } from "./helpers.ts";

const notebookId = "11111111-1111-4111-8111-111111111111";
const cellId = "22222222-2222-4222-8222-222222222222";

test("manual UI aliases are app-only and preserve the underlying tool schema", () => {
  for (const name of ["upsert_cell", "run_cell"]) {
    const original = TOOLS.find((tool) => tool.name === name)!;
    const manual = TOOLS.find((tool) => tool.name === `ui_${name}`)!;
    assert.ok("visibility" in manual._meta.ui);
    assert.deepEqual(manual._meta.ui.visibility, ["app"]);
    assert.deepEqual(manual.inputSchema, original.inputSchema);
    assert.deepEqual(manual.annotations, original.annotations);
  }
});

for (const [prefix, actor] of [["ui_", "user"], ["", "assistant"]] as const) {
  test(`${actor} edits and run reservations retain their actor through MCP dispatch`, async () => {
    const f = fixture();
    try {
      await new Store(f.env).owner(OWNER);
      const store = new NotebookStore(f.env, OWNER.userId);
      const { runtime } = await store.reserveOpen(notebookId, "Synthetic attribution", "synthetic-open");
      await store.selectRuntimeCompute(runtime.id, CPU_COMPUTE);
      await store.observedRuntimeCompute(runtime.id, { ...CPU_COMPUTE, variant: "DEFAULT" });
      await store.opened(runtime.id, "synthetic-kernel");
      const args = { notebookId, cellId, kind: "code", source: "print(1 + 2)", expectedVersion: 0 };
      await callTool(`${prefix}upsert_cell`, args, f.env, OWNER, { fetcher: noNetwork });
      assert.equal((await store.cells(notebookId))[0].updated_by, actor);
      const runArgs = { notebookId, cellId, cellVersion: 1, idempotencyKey: "synthetic-run" };
      // No grant exists: dispatch fails before any network call. The real run ledger
      // must retain who initiated it, including this failure/unknown path.
      const outcome = await callTool(`${prefix}run_cell`, runArgs, f.env, OWNER, { fetcher: noNetwork });
      assert.equal((outcome.value.run as { actor: string }).actor, actor);
      assert.equal((await store.runByKey(notebookId, "synthetic-run"))?.actor, actor);
      const retry = await callTool(`${prefix}run_cell`, runArgs, f.env, OWNER, { fetcher: noNetwork });
      assert.equal(retry.value.cached, true);
      await assert.rejects(callTool(`${prefix}upsert_cell`, { ...args, expectedVersion: 1 }, f.env, OTHER,
        { fetcher: noNetwork }), /owner_required/);
      await assert.rejects(callTool(`${prefix}upsert_cell`, { ...args, actor: "user" }, f.env, OWNER,
        { fetcher: noNetwork }), /unexpected_notebook_argument/);
    } finally { f.close(); }
  });
}

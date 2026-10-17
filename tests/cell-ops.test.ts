/** Cell operations decided on 2026-10-17: cell-level CAS, structure CAS, delete, move, rename, notebook deletion. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FullCellView, NotebookView, OutlineCellView } from "../lib/notebook/contract.ts";
import { notebookCall } from "../lib/notebook/service.ts";
import { NotebookStore } from "../lib/notebook/store.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import { MAX_CELL_SOURCE, MAX_CELLS, MAX_NOTEBOOK_SOURCE } from "../lib/notebook/types.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, OWNER } from "./helpers.ts";

const notebookId = "11111111-1111-4111-8111-111111111111";
type Result = Record<string, unknown> & {
  notebook: NotebookView; savedCellId?: string; deletedCellId?: string; deleted?: boolean; requiresConfirmation?: boolean;
  artifactCount?: number; permanentCount?: number; totalBytes?: number; cellCount?: number; runCount?: number;
};
const ids = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

class ArrayBucket {
  keys = new Set<string>();
  deleteCalls: (string | string[])[] = [];
  async delete(keys: string | string[]) {
    this.deleteCalls.push(keys);
    for (const key of Array.isArray(keys) ? keys : [keys]) this.keys.delete(key);
  }
}

async function setup() {
  const f = fixture();
  const bucket = new ArrayBucket();
  f.env.BUCKET = bucket as unknown as R2Bucket;
  await new Store(f.env).owner(OWNER);
  const now = Date.now();
  f.sqlite.prepare("INSERT INTO notebooks(id,owner_id,title,version,state,created_at,updated_at) VALUES(?,?,?,1,'closed',?,?)")
    .run(notebookId, OWNER.userId, "Synthetic notebook", now, now);
  const call = async (name: string, args: Record<string, unknown>, actor: "user" | "assistant" = "assistant") =>
    notebookCall(name, validateNotebookArguments(name, args), f.env, OWNER, { actor }) as Promise<Result>;
  const order = () => (f.sqlite.prepare("SELECT id, position FROM notebook_cells WHERE notebook_id=? ORDER BY position")
    .all(notebookId) as { id: string; position: number }[]).map(({ id, position }) => ({ id, position }));
  const structure = () => Number(f.sqlite.prepare("SELECT structure_version AS v FROM notebooks WHERE id=?").get(notebookId)!.v);
  const add = (n: number, source = `print(${n})`, actor: "user" | "assistant" = "assistant") =>
    call("upsert_cell", { notebookId, cellId: ids(n), kind: "code", source, expectedVersion: 0 }, actor);
  return { ...f, bucket, call, order, structure, add, store: new NotebookStore(f.env, OWNER.userId) };
}

test("content edits compare only the edited cell; stale edits never overwrite", async () => {
  const f = await setup();
  try {
    await f.add(1); await f.add(2);
    const [a, b] = await Promise.all([
      f.call("upsert_cell", { notebookId, cellId: ids(1), kind: "code", source: "a = 1", expectedVersion: 1 }, "user"),
      f.call("upsert_cell", { notebookId, cellId: ids(2), kind: "code", source: "b = 2", expectedVersion: 1 }),
    ]);
    assert.equal(a.savedCellId, ids(1)); assert.equal(b.savedCellId, ids(2));
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId: ids(1), kind: "code", source: "stale", expectedVersion: 1 }),
      /version_conflict/);
    const doc = await f.call("get_notebook", { notebookId, view: "full" });
    const cells = doc.notebook.cells;
    assert.deepEqual(cells.map((c) => [(c as FullCellView).source, c.version, c.updatedBy]), [["a = 1", 2, "user"], ["b = 2", 2, "assistant"]]);
    // Older clients still send notebookVersion; it is accepted and ignored.
    await f.call("upsert_cell", { notebookId, cellId: ids(1), kind: "markdown", source: "# note", expectedVersion: 2, notebookVersion: 1 });
    assert.equal((await f.store.cells(notebookId))[0].kind, "markdown");
  } finally { f.close(); }
});

test("new cells append freely or insert at an index under structure CAS", async () => {
  const f = await setup();
  try {
    await f.add(1); await f.add(2); await f.add(3);
    assert.equal(f.structure(), 4);
    await f.call("upsert_cell", { notebookId, cellId: ids(9), kind: "code", source: "x", expectedVersion: 0, index: 1, structureVersion: 4 });
    assert.deepEqual(f.order(), [[ids(1), 0], [ids(9), 1], [ids(2), 2], [ids(3), 3]].map(([id, position]) => ({ id, position })));
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId: ids(10), kind: "code", source: "y", expectedVersion: 0, index: 0, structureVersion: 4 }),
      /structure_version_conflict/);
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId: ids(10), kind: "code", source: "y", expectedVersion: 0, index: 0 }),
      /structure_version_required/);
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId: ids(10), kind: "code", source: "y", expectedVersion: 0, index: 9, structureVersion: 5 }),
      /version_conflict_or_document_limit/);
    assert.equal(f.order().length, 4);
  } finally { f.close(); }
});

test("move_cell reorders contiguously and rejects stale structure or bad indexes", async () => {
  const f = await setup();
  try {
    for (const n of [1, 2, 3, 4]) await f.add(n);
    const moved = await f.call("move_cell", { notebookId, cellId: ids(4), toIndex: 0, structureVersion: f.structure() });
    assert.deepEqual(moved.notebook.cells.map((c) => c.id), [ids(4), ids(1), ids(2), ids(3)]);
    await f.call("move_cell", { notebookId, cellId: ids(1), toIndex: 3, structureVersion: f.structure() });
    assert.deepEqual(f.order(), [ids(4), ids(2), ids(3), ids(1)].map((id, position) => ({ id, position })));
    await assert.rejects(f.call("move_cell", { notebookId, cellId: ids(2), toIndex: 0, structureVersion: 1 }), /structure_version_conflict/);
    await assert.rejects(f.call("move_cell", { notebookId, cellId: ids(2), toIndex: 4, structureVersion: f.structure() }), /cell_index_out_of_range/);
    await assert.rejects(f.call("move_cell", { notebookId, cellId: ids(77), toIndex: 0, structureVersion: f.structure() }), /cell_not_found/);
  } finally { f.close(); }
});

test("delete_cell keeps run history and artifacts, and refuses a running cell", async () => {
  const f = await setup();
  try {
    for (const n of [1, 2, 3]) await f.add(n);
    const now = Date.now();
    f.sqlite.prepare(`INSERT INTO notebook_runs(id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,created_at,updated_at,artifacts_state)
      VALUES('run-done',?,'rt',?,1,'k1','print(2)','assistant','ok',?,?,'saved')`).run(notebookId, ids(2), now, now);
    f.sqlite.prepare(`INSERT INTO notebook_artifacts(id,owner_id,notebook_id,run_id,path,size,sha256,object_key,media_type,state,created_at)
      VALUES('art-1',?,?,'run-done','outputs/a.png',10,'00','obj-1','image/png','ready',?)`).run(OWNER.userId, notebookId, now);
    const deleted = await f.call("delete_cell", { notebookId, cellId: ids(2), structureVersion: f.structure() });
    assert.equal(deleted.deletedCellId, ids(2));
    assert.deepEqual(f.order(), [ids(1), ids(3)].map((id, position) => ({ id, position })));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runs WHERE cell_id=?").get(ids(2))!.n, 1);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_artifacts WHERE id='art-1'").get()!.n, 1);

    f.sqlite.prepare(`INSERT INTO notebook_runs(id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,created_at,updated_at)
      VALUES('run-live',?,'rt',?,1,'k2','print(3)','user','running',?,?)`).run(notebookId, ids(3), now, now);
    f.sqlite.prepare("UPDATE notebooks SET active_run_id='run-live' WHERE id=?").run(notebookId);
    await assert.rejects(f.call("delete_cell", { notebookId, cellId: ids(3), structureVersion: f.structure() }), /cell_running/);
    await assert.rejects(f.call("delete_cell", { notebookId, cellId: ids(1), structureVersion: 1 }), /structure_version_conflict/);
    assert.equal(f.order().length, 2);
  } finally { f.close(); }
});

test("rename keeps cell versions; either actor may rename", async () => {
  const f = await setup();
  try {
    await f.add(1);
    const renamed = await f.call("rename_notebook", { notebookId, title: "動量訊號回測" });
    assert.equal(renamed.notebook.title, "動量訊號回測");
    assert.equal(renamed.notebook.cells[0].version, 1);
    await f.call("rename_notebook", { notebookId, title: "最後的名稱" }, "user");
    assert.equal((await f.store.notebook(notebookId)).title, "最後的名稱");
  } finally { f.close(); }
});

test("delete_notebook previews on a count mismatch, refuses open runtimes, then removes everything", async () => {
  const f = await setup();
  try {
    await f.add(1);
    const now = Date.now();
    f.sqlite.prepare(`INSERT INTO notebook_runs(id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,created_at,updated_at,artifacts_state)
      VALUES('run-done',?,'rt-1',?,1,'k1','print(1)','assistant','ok',?,?,'saved')`).run(notebookId, ids(1), now, now);
    for (const [id, permanent, size] of [["art-1", 0, 100], ["art-2", 1, 250]] as const) {
      f.sqlite.prepare(`INSERT INTO notebook_artifacts(id,owner_id,notebook_id,run_id,path,size,sha256,object_key,media_type,state,permanent,created_at)
        VALUES(?,?,?,'run-done',?,?,'00',?,'image/png','ready',?,?)`).run(id, OWNER.userId, notebookId, `outputs/${id}.png`, size, `obj-${id}`, permanent, now);
      f.bucket.keys.add(`obj-${id}`);
    }
    f.sqlite.prepare("INSERT INTO artifact_downloads(token_hash,artifact_id,owner_id,expires_at) VALUES('tok','art-1',?,?)").run(OWNER.userId, now + 1000);

    const dry = await f.call("delete_notebook", { notebookId, confirmArtifactCount: 2, dryRun: true });
    assert.equal(dry.deleted, false); assert.equal(dry.artifactCount, 2);
    const preview = await f.call("delete_notebook", { notebookId, confirmArtifactCount: 0 });
    assert.equal(preview.deleted, false); assert.equal(preview.requiresConfirmation, true);
    assert.deepEqual([preview.artifactCount, preview.permanentCount, preview.totalBytes, preview.cellCount, preview.runCount], [2, 1, 350, 1, 1]);
    assert.equal(f.bucket.keys.size, 2);

    f.sqlite.prepare(`INSERT INTO notebook_runtimes(id,notebook_id,owner_id,request_key,state,notebook_hash,released,created_at,updated_at)
      VALUES('rt-1',?,?,'open-1','open','hash',0,?,?)`).run(notebookId, OWNER.userId, now, now);
    await assert.rejects(f.call("delete_notebook", { notebookId, confirmArtifactCount: 2 }), /notebook_runtime_open/);
    assert.equal((await f.store.notebook(notebookId)).state, "closed");

    f.sqlite.prepare("UPDATE notebook_runtimes SET released=1,state='closed' WHERE id='rt-1'").run();
    const done = await f.call("delete_notebook", { notebookId, confirmArtifactCount: 2 }, "user");
    assert.equal(done.deleted, true);
    assert.equal(f.bucket.keys.size, 0);
    for (const table of ["notebooks", "notebook_cells", "notebook_runs", "notebook_artifacts", "artifact_downloads", "notebook_runtimes"]) {
      assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0, table);
    }
    await assert.rejects(f.store.notebook(notebookId), /notebook_not_found/);
  } finally { f.close(); }
});

test("an interrupted deletion resumes and maintenance ignores deleting notebooks", async () => {
  const f = await setup();
  try {
    await f.add(1);
    f.sqlite.prepare("UPDATE notebooks SET state='deleting',runtime_id='rt-x' WHERE id=?").run(notebookId);
    assert.deepEqual(await f.store.live(), []);
    assert.equal(await f.store.liveCount(), 0);
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId: ids(2), kind: "code", source: "x", expectedVersion: 0 }),
      /version_conflict_or_document_limit/);
    const resumed = await f.call("delete_notebook", { notebookId, confirmArtifactCount: 999 });
    assert.equal(resumed.deleted, true);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebooks").get()!.n, 0);
  } finally { f.close(); }
});

test("documents allow 200 cells and 400,000 characters, and nothing beyond", async () => {
  const f = await setup();
  try {
    const big = "x".repeat(MAX_CELL_SOURCE);
    const count = MAX_NOTEBOOK_SOURCE / MAX_CELL_SOURCE;
    for (let n = 0; n < count; n++) {
      await f.store.upsertCell({ notebookId, cellId: ids(n), kind: "code", source: big, expectedVersion: 0, actor: "user" });
    }
    await assert.rejects(f.store.upsertCell({ notebookId, cellId: ids(999), kind: "code", source: "y", expectedVersion: 0, actor: "user" }),
      /document_limit/);
    f.sqlite.prepare("UPDATE notebook_cells SET source='' WHERE notebook_id=?").run(notebookId);
    for (let n = count; n < MAX_CELLS; n++) {
      await f.store.upsertCell({ notebookId, cellId: ids(n), kind: "code", source: "1", expectedVersion: 0, actor: "user" });
    }
    assert.equal((await f.store.cells(notebookId)).length, MAX_CELLS);
    await assert.rejects(f.store.upsertCell({ notebookId, cellId: ids(999), kind: "code", source: "1", expectedVersion: 0, actor: "user" }),
      /document_limit/);
  } finally { f.close(); }
});

test("large documents give the model an outline plus requested cells; full view stays complete", async () => {
  const f = await setup();
  try {
    for (let n = 0; n < 61; n++) {
      await f.store.upsertCell({ notebookId, cellId: ids(n), kind: "code", source: `line_a_${n}\nline_b\nline_c\nline_d`, expectedVersion: 0, actor: "assistant" });
    }
    const outline = await f.call("get_notebook", { notebookId, cellIds: [ids(5)] });
    assert.equal(outline.notebook.view, "outline");
    const five = outline.notebook.cells.find((c) => c.id === ids(5)) as FullCellView;
    const six = outline.notebook.cells.find((c) => c.id === ids(6)) as OutlineCellView;
    assert.equal(five.source, "line_a_5\nline_b\nline_c\nline_d");
    assert.equal(six.outline, true); assert.equal("source" in six, false);
    assert.equal(six.preview, "line_a_6\nline_b\nline_c"); assert.equal(six.lineCount, 4);
    const full = await f.call("get_notebook", { notebookId, view: "full" });
    assert.equal(full.notebook.view, "full");
    assert.ok(full.notebook.cells.every((c) => "source" in c && typeof c.source === "string" && !c.outline));
    const small = await setup();
    try {
      await small.add(1);
      assert.equal((await small.call("get_notebook", { notebookId })).notebook.view, "full");
    } finally { small.close(); }
  } finally { f.close(); }
});

test("new argument validation bounds", () => {
  assert.throws(() => validateNotebookArguments("get_notebook", { notebookId, cellIds: Array.from({ length: 41 }, (_, n) => ids(n)) }),
    /invalid_notebook_argument_value/);
  assert.throws(() => validateNotebookArguments("get_notebook", { notebookId, view: "everything" }), /invalid_notebook_argument_value/);
  assert.throws(() => validateNotebookArguments("move_cell", { notebookId, cellId: ids(1), toIndex: MAX_CELLS + 1, structureVersion: 1 }),
    /invalid_notebook_argument_value/);
  assert.throws(() => validateNotebookArguments("delete_notebook", { notebookId }), /missing_notebook_argument/);
  assert.throws(() => validateNotebookArguments("rename_notebook", { notebookId, title: "" }), /invalid_notebook_argument_value/);
});

test("cell edits and structure changes never touch the mutation token used by close/idle claims", async () => {
  const f = await setup();
  try {
    f.sqlite.prepare("UPDATE notebooks SET mutation_id='close-claim' WHERE id=?").run(notebookId);
    await f.add(1); await f.add(2);
    await f.call("upsert_cell", { notebookId, cellId: ids(1), kind: "code", source: "edited", expectedVersion: 1 });
    await f.call("move_cell", { notebookId, cellId: ids(2), toIndex: 0, structureVersion: f.structure() });
    await f.call("delete_cell", { notebookId, cellId: ids(1), structureVersion: f.structure() });
    await f.call("rename_notebook", { notebookId, title: "renamed" });
    assert.equal(f.sqlite.prepare("SELECT mutation_id AS m FROM notebooks WHERE id=?").get(notebookId)!.m, "close-claim");
  } finally { f.close(); }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ArtifactStore, artifactManifest, artifactPath } from "../lib/notebook/artifact-store.ts";
import { archiveRun, hex, previewArtifact } from "../lib/notebook/artifacts.ts";
import { notebookCall, maintenanceCall } from "../lib/notebook/service.ts";
import { NotebookStore } from "../lib/notebook/store.ts";
import { artifactDownload } from "../lib/notebook/download.ts";
import { maintenanceApi } from "../lib/notebook/maintenance-api.ts";
import { CPU_IDLE_MS, GPU_IDLE_MS, ARTIFACT_RETENTION_MS, DOWNLOAD_TTL_MS, effectiveIdlePolicy, idleDue } from "../lib/notebook/policy.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import type { ArtifactManifest, ArtifactRow, RunResult, RuntimeRow } from "../lib/notebook/types.ts";
import type { SpikeEnv } from "../lib/platform/config.ts";
import { encryptToken } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { fixture, noNetwork, OTHER, OWNER, ownerRequest, REFRESH, syntheticComputeStatus, tokenPayload } from "./helpers.ts";

const notebookId = "11111111-1111-4111-8111-111111111111";
const cellId = "22222222-2222-4222-8222-222222222222";

test("artifact previews require a bounded PNG header even when the stored hash matches", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  for (const change of ["valid", "signature", "IHDR", "size"]) {
    const data = new Uint8Array(png);
    if (change === "signature") data[0] = 0;
    if (change === "IHDR") data[12] = 0;
    if (change === "size") new DataView(data.buffer).setUint32(16, 20000);
    const row = { size: data.length, media_type: "image/png", object_key: "synthetic-preview",
      sha256: hex(await crypto.subtle.digest("SHA-256", data)) } as ArtifactRow;
    const env = { BUCKET: { get: async () => ({ size: data.length, arrayBuffer: async () => data.buffer }) } } as unknown as SpikeEnv;
    const preview = await previewArtifact(env, row, new AbortController().signal);
    assert.equal(preview, change === "valid" ? `data:image/png;base64,${png.toString("base64")}` : null);
  }
});

class Bucket {
  files = new Map<string, { data: Uint8Array<ArrayBuffer>; sha256: ArrayBuffer; customMetadata: Record<string, string> }>();
  puts = 0; deletes = 0; failPut = false;
  async head(key: string) {
    const row = this.files.get(key); if (!row) return null;
    return { key, size: row.data.byteLength, checksums: { sha256: row.sha256 }, customMetadata: row.customMetadata };
  }
  async put(key: string, value: Uint8Array<ArrayBuffer>, options: R2PutOptions) {
    this.puts++; if (this.failPut) throw new Error("synthetic storage failure containing private URL");
    const sha256 = await crypto.subtle.digest("SHA-256", value);
    assert.equal(hex(sha256), hex(options.sha256 as ArrayBuffer));
    this.files.set(key, { data: new Uint8Array(value), sha256, customMetadata: options.customMetadata! });
    return this.head(key);
  }
  async get(key: string) {
    const row = this.files.get(key); if (!row) return null;
    return { ...await this.head(key), body: new ReadableStream({ start(controller) { controller.enqueue(row.data); controller.close(); } }),
      arrayBuffer: async () => row.data.slice().buffer };
  }
  async delete(key: string) { this.deletes++; this.files.delete(key); }
}
async function prepared(paths = ["result.txt"]) {
  const f = fixture(), bucket = new Bucket(); f.env.BUCKET = bucket as unknown as R2Bucket;
  const security = new Store(f.env); await security.owner(OWNER);
  await security.saveGrant({ owner_id: OWNER.userId, google_subject: "synthetic-google-subject", masked_email: "s…",
    encrypted_refresh_token: await encryptToken(REFRESH, f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, "synthetic-google-subject") });
  const store = new NotebookStore(f.env, OWNER.userId), artifacts = new ArtifactStore(f.env, OWNER.userId);
  const { runtime } = await store.reserveOpen(notebookId, "Synthetic artifacts", "synthetic-open");
  await store.selectRuntimeCompute(runtime.id, { kind: "CPU", accelerator: "CPU" });
  await store.observedRuntimeCompute(runtime.id, { kind: "CPU", accelerator: "CPU", variant: "DEFAULT" });
  await store.endpoint(runtime.id, "synthetic-owned-endpoint"); await store.opened(runtime.id, "synthetic-kernel");
  await store.upsertCell({ notebookId, cellId, kind: "code", source: "print(42)", actor: "user", expectedVersion: 0 });
  const { run } = await store.reserveRun({ notebookId, cellId, cellVersion: 1, idempotencyKey: "synthetic-run", actor: "assistant" });
  const files = new Map(paths.map((path) => [path, new TextEncoder().encode(`synthetic ${path}`)]));
  const manifest: ArtifactManifest = { files: await Promise.all([...files].map(async ([path, data]) => ({ path,
    size: data.length, sha256: hex(await crypto.subtle.digest("SHA-256", data)) }))), errors: [] };
  const now = Date.now();
  const result: RunResult = { protocol: 1, runId: run.id, status: "ok", outputs: [], truncated: false,
    startedAt: now, finishedAt: now, executionCount: 1, artifacts: manifest };
  await store.updateRun(run.id, "ok", result);
  let releases = 0, reads = 0, failRead = false, releaseConfirmed = true;
  const remote = {
    submitSetup: async () => {}, pollSetup: async () => null,
    submitInput: async () => { throw new Error("unexpected_input_dispatch"); }, pollInput: async () => null,
    computeStatus: async () => syntheticComputeStatus(),
    allocate: async () => { throw new Error("maintenance_must_not_allocate"); }, startKernel: async () => "unused",
    submit: async () => { throw new Error("maintenance_must_not_dispatch"); }, poll: async () => result,
    interrupt: async () => {},
    readArtifact: async (_runtime: RuntimeRow, path: string) => {
      reads++; if (failRead) throw new Error("synthetic remote no longer available"); return files.get(path)!;
    },
    release: async () => { releases++; return { released: releaseConfirmed }; },
  };
  const options = { fetcher: async () => Response.json(tokenPayload(f.env)), runtimeFactory: () => remote };
  const maintain = (clock = Date.now()) => maintenanceCall(f.env, OWNER.userId, { ...options, now: () => clock });
  const archive = async () => archiveRun(f.env, OWNER.userId, await store.run(run.id), await store.runtime(runtime.id), remote,
    new AbortController().signal, Date.now);
  return { ...f, bucket, store, artifacts, run, runtime, files, manifest, result, remote, options, maintain, archive,
    info: () => ({ releases, reads }), failRead: () => { failRead = true; }, failRelease: () => { releaseConfirmed = false; },
    confirmRelease: () => { releaseConfirmed = true; } };
}

async function addRuntime(store: NotebookStore, id: string, accelerator = "CPU") {
  const kind = accelerator === "CPU" ? "CPU" : "GPU";
  const { runtime } = await store.reserveOpen(id, "Synthetic extra notebook", `open-${id}`, accelerator);
  await store.selectRuntimeCompute(runtime.id, { kind, accelerator });
  await store.observedRuntimeCompute(runtime.id, { kind, accelerator, variant: kind === "CPU" ? "DEFAULT" : "GPU" });
  await store.endpoint(runtime.id, `synthetic-${id}`); await store.opened(runtime.id, "synthetic-kernel");
  return runtime;
}

test("one file checkpoint preserves active slot until every hash-verified R2 object is acknowledged", async () => {
  const f = await prepared(["one.txt", "nested/two.txt"]);
  try {
    assert.equal((await f.store.notebook(notebookId)).active_run_id, f.run.id);
    const first = await f.maintain(); assert.equal(first.processed, 1); assert.equal(first.actionablePending, 1); assert.equal(first.runningCount, 0);
    await assert.rejects(f.store.reserveRun({ notebookId, cellId, cellVersion: 1, idempotencyKey: "must-wait-for-files", actor: "user" }), /busy/);
    const second = await f.maintain(); assert.equal(second.processed, 1); assert.equal(second.actionablePending, 0);
    assert.equal((await f.store.notebook(notebookId)).active_run_id, null);
    assert.equal((await f.store.run(f.run.id)).artifacts_state, "saved");
    assert.equal(f.bucket.puts, 2); assert.equal((await f.artifacts.list(notebookId)).every((row) => row.state === "ready"), true);
    const latest = await f.store.latestMaintenance(); assert.equal((latest!.result as any).maintenanceRunId, second.maintenanceRunId);
  } finally { f.close(); }
});

test("storage/changed-byte failure blocks idle cleanup and does not leak raw errors", async () => {
  const f = await prepared();
  try {
    f.bucket.failPut = true; const failed = await f.maintain(Date.now() + CPU_IDLE_MS + 1000);
    assert.equal(failed.ok, false); assert.equal(f.info().releases, 0); assert.ok(!JSON.stringify(failed).includes("private URL"));
    assert.equal((await f.store.run(f.run.id)).artifacts_state, "blocked");
    f.bucket.failPut = false; f.files.set("result.txt", new TextEncoder().encode("different"));
    const changed = await f.archive(); assert.equal(changed.saved, false); assert.equal(changed.error!.code, "artifact_checksum_mismatch");
    assert.equal((await f.store.notebook(notebookId)).active_run_id, f.run.id);
  } finally { f.close(); }
});

test("R2 write acknowledged but D1 save failed can resume from R2 without reading the lost VM again", async () => {
  const f = await prepared(); const original = f.env.DB!;
  try {
    const failing = { bind() { return failing; }, async run() { throw new Error("synthetic D1 save failure"); } };
    f.env.DB = { prepare(sql: string) { return sql.includes("state='ready',media_type") ? failing : original.prepare(sql); }, batch: original.batch.bind(original) } as D1Database;
    assert.equal((await f.archive()).saved, false); assert.equal(f.bucket.puts, 1);
    f.env.DB = original; f.failRead(); const retried = await f.archive();
    assert.equal(retried.saved, true); assert.equal(f.bucket.puts, 1); assert.equal(f.info().reads, 1);
  } finally { f.env.DB = original; f.close(); }
});

test("idle policy uses last meaningful activity/terminal time, read polls do not reset it, CAS rejects races", async () => {
  const f = await prepared();
  try {
    await f.archive(); const before = await f.store.notebook(notebookId), runtime = await f.store.runtime(f.runtime.id);
    await notebookCall("get_notebook", { notebookId }, f.env, OWNER, f.options);
    assert.equal((await f.store.notebook(notebookId)).last_activity_at, before.last_activity_at);
    assert.equal(idleDue(before, runtime, before.last_activity_at + CPU_IDLE_MS - 1), false);
    const afterActivity = Math.max(before.last_activity_at, before.last_terminal_at!) + 1;
    await f.store.touch(notebookId, afterActivity);
    assert.equal(await f.store.beginIdleClose(before, before.last_activity_at + CPU_IDLE_MS), null);
    const exportedAt = afterActivity + 100;
    await notebookCall("export_ipynb", { notebookId }, f.env, OWNER, { ...f.options, now: () => exportedAt });
    assert.equal((await f.store.notebook(notebookId)).last_activity_at, exportedAt);
    const released = await f.maintain(exportedAt + CPU_IDLE_MS + 1);
    assert.equal(released.released, 1); assert.equal(f.info().releases, 1);
    assert.equal((released.notebooks as any[])[0].reason, "idle_due");
  } finally { f.close(); }
});

test("obsolete canary environment cannot change production CPU/GPU policies; only tests inject clock", async () => {
  const f = await prepared([]);
  try {
    await f.archive(); const now = Date.now(), notebook = await f.store.notebook(notebookId), runtime = await f.store.runtime(f.runtime.id);
    Object.assign(f.env, { IDLE_CANARY_JSON: JSON.stringify({ notebookId, idleSeconds: 120, expiresAt: now + 600_000 }) });
    assert.equal((await f.maintain(now + 119_000)).released, 0);
    assert.equal((await f.maintain(now + 121_000)).released, 0);
    const due = await f.maintain(now + CPU_IDLE_MS + 1); assert.equal(due.released, 1);
    assert.equal((due.notebooks as any[])[0].idlePolicy.source, "production");
    assert.equal(effectiveIdlePolicy(runtime).milliseconds, CPU_IDLE_MS);
    assert.equal(effectiveIdlePolicy({ ...runtime, accelerator: "H100", machine_kind: "GPU" }).milliseconds, GPU_IDLE_MS);
    assert.throws(() => validateNotebookArguments("maintain_notebooks", { now, idleSeconds: 1 }), /unexpected/);
  } finally { f.close(); }
});

test("a started idle close and failed confirmation remain retryable, unknown allocation never becomes cleanup intent", async () => {
  const f = await prepared([]);
  try {
    await f.archive(); f.failRelease(); const now = Date.now() + CPU_IDLE_MS + 1000;
    const failed = await f.maintain(now); assert.equal(failed.ok, false); assert.equal(f.info().releases, 1);
    assert.equal((await f.store.notebook(notebookId)).state, "unknown");
    f.confirmRelease(); const retried = await f.maintain(now + 1); assert.equal(retried.released, 1);
    assert.equal((retried.notebooks as any[])[0].reason, "idle_cleanup_retry");
    assert.equal(f.info().releases, 2);
    await f.store.finishRuntime(f.runtime.id, false, { code: "late_failure", stage: "maintenance" });
    assert.equal((await f.store.runtime(f.runtime.id)).released, 1);
  } finally { f.close(); }
});

test("more than four notebooks are fairly paged; a running page does not create a perpetual actionable loop", async () => {
  const f = await prepared([]);
  try {
    await f.archive();
    const ids = [notebookId];
    for (let i = 2; i <= 8; i++) {
      const id = `${i}0000000-2222-4222-8222-222222222222`;
      ids.push(id); await addRuntime(f.store, id);
    }
    for (const id of ids.slice(0, 4)) {
      const cell = id === notebookId ? cellId : crypto.randomUUID();
      if (id !== notebookId) await f.store.upsertCell({ notebookId: id, cellId: cell, kind: "code", source: "pass",
        expectedVersion: 0, actor: "user" });
      const { run } = await f.store.reserveRun({ notebookId: id, cellId: cell, cellVersion: 1,
        idempotencyKey: `running-${id}`, actor: "assistant" });
      await f.store.updateRun(run.id, "submitted", null);
    }
    f.remote.poll = async (...args: unknown[]): Promise<RunResult> => ({ ...f.result,
      runId: args[1] as string, status: "running", finishedAt: null });
    const first = await f.maintain();
    assert.equal(first.scanned, 4); assert.equal(first.runningCount, 4);
    assert.equal(first.scanRemaining, 4); assert.equal(first.actionablePending, 4);
    const second = await f.maintain();
    assert.equal(second.scanned, 4); assert.equal(second.runningCount, 0);
    assert.equal(second.scanRemaining, 0); assert.equal(second.actionablePending, 0); assert.equal(second.sweepComplete, true);
    assert.equal(new Set([...(first.notebooks as any[]), ...(second.notebooks as any[])].map((row) => row.notebookId)).size, 8);
    assert.equal(f.info().releases, 0);
    assert.equal(f.sqlite.prepare("SELECT after_id FROM maintenance_scan").get()!.after_id, "");
  } finally { f.close(); }
});

test("each maintenance request releases at most one runtime and the cursor reaches every due notebook", async () => {
  const f = await prepared([]);
  try {
    await f.archive();
    for (let i = 2; i <= 6; i++) await addRuntime(f.store, `${i}0000000-2222-4222-8222-222222222222`, i === 2 ? "H100" : "CPU");
    const clock = Date.now() + CPU_IDLE_MS + 1000;
    const visited: string[] = [];
    for (let i = 0; i < 6; i++) {
      const outcome = await f.maintain(clock);
      assert.equal(outcome.released, 1); assert.equal(outcome.scanned, 1);
      assert.equal(outcome.scanRemaining, 5 - i);
      assert.equal(f.info().releases, i + 1);
      visited.push((outcome.notebooks as any[])[0].notebookId);
    }
    assert.equal(new Set(visited).size, 6);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes WHERE released=0").get()!.n, 0);
  } finally { f.close(); }
});

test("a failed retiring object cannot block due runtime cleanup or fair cursor progression", async () => {
  const f = await prepared();
  try {
    await f.archive(); await addRuntime(f.store, "22222222-2222-4222-8222-222222222222");
    f.bucket.delete = async () => { throw new Error("synthetic secret-bearing storage failure"); };
    const clock = Date.now() + ARTIFACT_RETENTION_MS + 1000;
    const first = await f.maintain(clock);
    assert.equal(first.ok, false); assert.equal(first.released, 1); assert.equal(first.scanRemaining, 1);
    assert.equal(f.sqlite.prepare("SELECT after_id FROM maintenance_scan").get()!.after_id, notebookId);
    assert.equal((await f.artifacts.list(notebookId))[0].state, "deleting");
    const second = await f.maintain(clock);
    assert.equal(second.released, 1); assert.equal(f.info().releases, 2);
    assert.ok(!JSON.stringify(first).includes("secret-bearing"));
  } finally { f.close(); }
});

test("a stalled retiring delete gets a short wait and preserves the live runtime cleanup budget", async (t) => {
  const f = await prepared();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await f.archive();
    let deleting = false;
    f.bucket.delete = async () => { deleting = true; return new Promise<void>(() => {}); };
    const maintenance = f.maintain(Date.now() + ARTIFACT_RETENTION_MS + 1000);
    while (!deleting) await setImmediate();
    t.mock.timers.tick(2001);
    const outcome = await maintenance;
    assert.equal(outcome.released, 1); assert.equal(outcome.ok, false);
    assert.equal((outcome.errors as any[])[0].code, "step_timeout");
    assert.equal((outcome.errors as any[])[0].stage, "maintenanceArtifactDelete");
    assert.equal(f.info().releases, 1);
  } finally { t.mock.timers.reset(); f.close(); }
});

test("concurrent maintenance respects its short lease and a completed scan releases it", async () => {
  const f = await prepared([]);
  let unblock!: () => void;
  try {
    f.sqlite.prepare("UPDATE notebook_runs SET state='submitted',result_json=NULL WHERE id=?").run(f.run.id);
    let polling = false;
    f.remote.poll = async () => { polling = true; await new Promise<void>((resolve) => { unblock = resolve; }); return f.result; };
    const first = f.maintain(); while (!polling) await setImmediate();
    const duplicate = await f.maintain();
    assert.equal(duplicate.busy, true); assert.equal(duplicate.actionablePending, 0); assert.equal(duplicate.released, 0);
    unblock(); await first;
    assert.equal(f.sqlite.prepare("SELECT lease_token FROM maintenance_scan").get()!.lease_token, null);
    f.sqlite.prepare("UPDATE maintenance_scan SET lease_token='expired-synthetic',lease_expires_at=0").run();
    assert.ok(await f.store.beginScan());
  } finally { unblock?.(); f.close(); }
});

test("running work is pending but not actionable, terminal clock tampering and active gates forbid release", async () => {
  const f = await prepared([]);
  try {
    f.sqlite.prepare("UPDATE notebook_runs SET state='running',result_json=? WHERE id=?")
      .run(JSON.stringify({ ...f.result, status: "running", finishedAt: null }), f.run.id);
    f.remote.poll = async () => ({ ...f.result, status: "running", finishedAt: null });
    const running = await f.maintain(Date.now() + CPU_IDLE_MS + 1000);
    assert.equal(running.runningCount, 1); assert.equal(running.actionablePending, 0); assert.equal(f.info().releases, 0);
    await assert.rejects(f.store.updateRun(f.run.id, "ok", { ...f.result, finishedAt: 1 }), /clock_untrusted/);
    assert.equal((await f.store.notebook(notebookId)).active_run_id, f.run.id);
  } finally { f.close(); }
});

test("pin/30-day expiry CAS, owner-only expiring download, and bounded expired-token cleanup", async () => {
  const f = await prepared(["keep.txt", "expire.txt"]);
  try {
    await f.archive(); await f.archive(); const rows = await f.artifacts.list(notebookId), now = Date.now();
    await f.artifacts.pin(rows[0].id, true, now);
    const link = await f.artifacts.downloadToken(rows[1].id, now);
    await assert.rejects(new ArtifactStore(f.env, OTHER.userId).authorizeDownload(rows[1].id, link.token, now), /invalid/);
    await assert.rejects(f.artifacts.authorizeDownload(rows[1].id, link.token, now + DOWNLOAD_TTL_MS), /expired/);
    const download = await artifactDownload(ownerRequest(`/api/artifacts/${rows[1].id}?token=${link.token}`), f.env, rows[1].id);
    assert.equal(download.status, 200); assert.ok(download.headers.get("Content-Disposition")!.startsWith("attachment"));
    assert.equal(await download.text(), `synthetic ${rows[1].path}`);
    const anonymous = await artifactDownload(new Request(`${SITE_ORIGIN}/api/artifacts/${rows[1].id}?token=${link.token}`), f.env, rows[1].id);
    assert.equal(anonymous.status, 401);
    const future = now + ARTIFACT_RETENTION_MS + 1000, retired = await f.maintain(future);
    assert.equal(retired.retired, 1); assert.equal(f.bucket.files.size, 1);
    assert.equal((await f.artifacts.artifact(rows[0].id)).state, "ready");
    assert.equal((await f.artifacts.artifact(rows[1].id)).state, "expired");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM artifact_downloads").get()!.n, 0);
    await assert.rejects(f.artifacts.pin(rows[1].id, true, future), /expired_or_retiring/);
  } finally { f.close(); }
});

test("manifest bounds and path traversal/links never silently become saved", async () => {
  for (const path of ["../private", "/absolute", "a/../x", "a\\b", "a/%2e%2e/x", "a\u0000b"]) assert.throws(() => artifactPath(path), /path_invalid/);
  assert.throws(() => artifactManifest({ files: [{ path: "too-big", size: 16 * 1024 * 1024 + 1, sha256: "a".repeat(64) }], errors: [] }), /manifest_invalid/);
  const f = await prepared([]);
  try {
    f.sqlite.prepare("UPDATE notebook_runs SET result_json=? WHERE id=?").run(JSON.stringify({ ...f.result,
      artifacts: { files: [], errors: [{ code: "artifact_file_too_large", path: "video.mp4" }] } }), f.run.id);
    const blocked = await f.archive(); assert.equal(blocked.saved, false); assert.equal(blocked.error!.code, "artifact_manifest_blocked");
    assert.equal((await f.store.notebook(notebookId)).active_run_id, f.run.id);
  } finally { f.close(); }
});

test("maintenance application route cannot enroll owners, accept overrides, or bypass a visitor mismatch", async () => {
  const f = fixture();
  const request = (args: unknown = {}, owner: typeof OWNER | null = null) => new Request(`${SITE_ORIGIN}/api/maintenance`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(owner ? {
      "oai-authenticated-user-id": owner.userId, "oai-authenticated-user-email": owner.email,
    } : {}) }, body: JSON.stringify(args),
  });
  try {
    const missing = await (await maintenanceApi(request(), f.env, noNetwork)).json() as any;
    assert.equal(missing.error.code, "maintenance_owner_not_enrolled");
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM site_owner").get()!.n, 0);
    await new Store(f.env).owner(OWNER);
    assert.equal(((await (await maintenanceApi(request({ now: 1 }), f.env, noNetwork)).json()) as any).error.code, "maintenance_arguments_forbidden");
    assert.equal(((await (await maintenanceApi(request({}, OTHER), f.env, noNetwork)).json()) as any).error.code, "owner_required");
    // Outer private service authorization belongs to Sites; this test verifies only the scoped application action.
    const service = await (await maintenanceApi(request(), f.env, noNetwork)).json() as any;
    assert.equal(service.ok, true); assert.equal(service.released, 0); assert.ok(service.maintenanceRunId);
  } finally { f.close(); }
});

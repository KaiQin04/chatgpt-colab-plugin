import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { notebookCall } from "../lib/notebook/service.ts";
import { NotebookStore } from "../lib/notebook/store.ts";
import { parseRunResult } from "../lib/notebook/runtime.ts";
import type { RunResult, RuntimeRow } from "../lib/notebook/types.ts";
import { MAX_RESULT_BYTES, MAX_RETURN_OUTPUT_BYTES, MAX_EXPORT_OUTPUT_BYTES } from "../lib/notebook/types.ts";
import { syntheticPng } from "./png-fixture.ts";
import { CPU_COMPUTE } from "../lib/notebook/compute.ts";
import type { ComputeChoice, ObservedCompute } from "../lib/notebook/compute.ts";
import type { InputFile, InputResult } from "../lib/notebook/inputs.ts";
import type { SetupResult, SetupRow } from "../lib/notebook/setup.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import { notebookApi } from "../lib/notebook/api.ts";
import { SITE_ORIGIN } from "../lib/platform/config.ts";
import { encryptToken, SpikeError } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, noNetwork, OTHER, OWNER, REFRESH, syntheticComputeStatus, tokenPayload } from "./helpers.ts";

const notebookId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const cellId = "33333333-3333-4333-8333-333333333333";
const openArgs = { notebookId, title: "Synthetic notebook", idempotencyKey: "open-synthetic-1" };
const runArgs = { notebookId, cellId, cellVersion: 1, idempotencyKey: "run-synthetic-1" };

function result(runId: string, status: RunResult["status"] = "ok", text = "42\n"): RunResult {
  return { protocol: 1, runId, status, outputs: [{ output_type: "stream", name: "stdout", text }],
    startedAt: Date.now(), finishedAt: status === "running" ? null : Date.now(), executionCount: 1, truncated: false,
    artifacts: { files: [], errors: [] } };
}
class FakeRuntime {
  allocations = 0; submissions = 0; releases = 0; interrupts = 0;
  choices: ComputeChoice[] = [];
  inputSubmissions = 0; inputId = ""; inputResult: InputResult | null = null;
  setupSubmissions = 0; setupPending = false;
  value: RunResult | null = null;
  runId = "";
  failAllocate = false; failKernel = false; failObserved = false; unknownAck = false; failRelease = false;
  onSubmit?: () => Promise<void>;
  onInterrupt?: () => Promise<void>;
  beforeRelease?: () => void;
  async computeStatus() { return syntheticComputeStatus(); }
  async submitInput(_runtime: RuntimeRow, id: string, _file: InputFile): Promise<void> {
    this.inputSubmissions++; this.inputId = id;
    if (this.unknownAck) throw new SpikeError("dispatch_ack_unknown", "submit");
  }
  async pollInput(): Promise<InputResult | null> { return this.inputResult; }
  async submitSetup(): Promise<void> { this.setupSubmissions++; }
  async pollSetup(_runtime: RuntimeRow, job: SetupRow): Promise<SetupResult | null> {
    if (this.setupPending) return null;
    return { protocol: 1, jobId: job.id, status: "ready", phase: "ready",
      packages: JSON.parse(job.config_json).map((name: string) => ({ name, version: "1.0.0", installed: false })),
      blender: null, error: null, startedAt: Date.now(), finishedAt: Date.now() };
  }
  async allocate(_hash: string, _signal: AbortSignal, capture: (endpoint: string) => Promise<void>,
    attempt: (value: boolean) => void, choice = CPU_COMPUTE): Promise<ObservedCompute> {
    this.allocations++; attempt(true);
    this.choices.push(choice);
    if (this.failAllocate) throw new SpikeError("transport_failed", "notebookAssignPost");
    await capture(this.allocations === 1 ? "synthetic-owned-endpoint" : `synthetic-owned-endpoint-${this.allocations}`);
    if (this.failObserved) throw new SpikeError("assignment_compute_mismatch", "open");
    return { ...choice, variant: choice.kind === "CPU" ? "DEFAULT" : "GPU" };
  }
  async startKernel(): Promise<string> {
    if (this.failKernel) throw new SpikeError("upstream_http_error", "notebookKernelStart", 500);
    return "synthetic-kernel-id";
  }
  async submit(_runtime: RuntimeRow, id: string): Promise<void> {
    this.submissions++; this.runId = id;
    if (this.onSubmit) await this.onSubmit();
    if (this.unknownAck) throw new SpikeError("dispatch_ack_unknown", "submit");
  }
  async poll(): Promise<RunResult | null> { return this.value; }
  async readArtifact(): Promise<Uint8Array<ArrayBuffer>> { throw new Error("unexpected_artifact_read"); }
  async interrupt(): Promise<void> {
    this.interrupts++; if (this.onInterrupt) await this.onInterrupt();
  }
  async release(): Promise<{ released: boolean }> {
    this.beforeRelease?.(); this.releases++; return { released: !this.failRelease };
  }
}
async function setup() {
  const f = fixture();
  const security = new Store(f.env);
  await security.owner(OWNER);
  await security.saveGrant({ owner_id: OWNER.userId, google_subject: "synthetic-google-subject",
    masked_email: "g…@e…st", encrypted_refresh_token: await encryptToken(REFRESH,
      f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, "synthetic-google-subject") });
  const remote = new FakeRuntime();
  const store = new NotebookStore(f.env, OWNER.userId);
  const invoke = (name: string, args: Record<string, unknown>) => notebookCall(name,
    validateNotebookArguments(name, args), f.env, OWNER, {
      fetcher: async () => Response.json(tokenPayload(f.env)), runtimeFactory: () => remote,
    });
  const call = async (name: string, args: Record<string, unknown>) => {
    let response = await invoke(name, args);
    if (name === "open_notebook" && (response.notebook as any)?.state === "preparing") {
      await invoke("get_notebook", { notebookId: args.notebookId });
      response = { ...response, ...await invoke("get_notebook", { notebookId: args.notebookId }) };
    }
    return response;
  };
  const opened = await call("open_notebook", openArgs);
  assert.equal((opened.notebook as any).state, "open");
  await call("upsert_cell", { notebookId, cellId, kind: "code", source: "x = 42\nprint(x)",
    expectedVersion: 0, notebookVersion: 1 });
  return { ...f, call, invoke, remote, store };
}

test("persistent owner documents, cell CAS, and multiple independently owned runtimes", async () => {
  const f = await setup();
  try {
    const cached = await f.call("open_notebook", openArgs);
    assert.equal(cached.cached, true); assert.equal(f.remote.allocations, 1);
    const second = await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "open-another-1" });
    assert.equal((second.notebook as any).state, "open"); assert.equal(f.remote.allocations, 2);
    await assert.rejects(new NotebookStore(f.env, OTHER.userId).notebook(notebookId), /notebook_not_found/);
    await assert.rejects(f.call("upsert_cell", { notebookId, cellId, kind: "code", source: "bad overwrite",
      expectedVersion: 0, notebookVersion: 1 }), /version_conflict/);
    assert.equal((await f.store.cells(notebookId))[0].source, "x = 42\nprint(x)");
    const saved = await f.call("upsert_cell", { notebookId, cellId: otherId, kind: "markdown", source: "# Note <script>bad</script>",
      expectedVersion: 0, notebookVersion: 2 });
    assert.equal((saved.notebook as any).cells.length, 2);
    const list = await f.call("get_notebook", {});
    assert.equal((list.notebooks as any[]).some((row) => row.id === notebookId), true);
    assert.ok(!JSON.stringify(saved).includes(OWNER.userId));
  } finally { f.close(); }
});

test("concurrent duplicate run keys dispatch once; new keys wait for terminal", async () => {
  const f = await setup();
  try {
    const [first, second] = await Promise.all([f.call("run_cell", runArgs), f.call("run_cell", runArgs)]);
    assert.equal((first.run as any).id, (second.run as any).id);
    assert.equal(f.remote.submissions, 1);
    await assert.rejects(f.call("run_cell", { ...runArgs, idempotencyKey: "run-new-key-2" }), /notebook_busy/);
    f.remote.value = result(f.remote.runId);
    await f.call("get_notebook", { notebookId });
    const retry = await f.call("run_cell", runArgs); assert.equal(retry.cached, true);
    const fresh = await f.call("run_cell", { ...runArgs, idempotencyKey: "run-new-key-2" });
    assert.notEqual((fresh.run as any).id, (first.run as any).id); assert.equal(f.remote.submissions, 2);
  } finally { f.close(); }
});

test("a delayed duplicate after the first run unlocks cannot dispatch again", async () => {
  const f = await setup();
  try {
    const original = f.store.runByKey.bind(f.store);
    let reads = 0;
    f.store.runByKey = async (...args) => { if (++reads === 1) return null; return original(...args); };
    // Unique notebook/request key protects a caller whose optimistic read was stale.
    await f.call("run_cell", runArgs); f.remote.value = result(f.remote.runId);
    await f.call("get_notebook", { notebookId });
    const duplicate = await f.store.reserveRun({ ...runArgs, actor: "assistant" });
    assert.equal(duplicate.cached, true); assert.equal(f.remote.submissions, 1);
    assert.equal((await f.store.notebook(notebookId)).active_run_id, null);
  } finally { f.close(); }
});

test("unknown ACK is durable and cannot be redispatched, then remote files recover it", async () => {
  const f = await setup();
  try {
    f.remote.unknownAck = true;
    const first = await f.call("run_cell", runArgs);
    assert.equal((first.run as any).state, "unknown");
    assert.equal((first.error as any).code, "dispatch_ack_unknown");
    assert.equal((await f.call("run_cell", runArgs)).cached, true);
    assert.equal(f.remote.submissions, 1);
    f.remote.value = result(f.remote.runId, "running", "starting\n");
    const running = await f.call("get_notebook", { notebookId });
    assert.equal((running.notebook as any).cells[0].lastRun.state, "running");
    await f.store.updateRun(f.remote.runId, "submitted", null);
    await f.store.updateRun(f.remote.runId, "unknown", null);
    assert.equal((await f.store.run(f.remote.runId)).state, "running");
    f.remote.value = result(f.remote.runId, "error", "partial\n");
    await f.call("get_notebook", { notebookId });
    assert.equal((await f.store.run(f.remote.runId)).state, "error");
    assert.equal((await f.store.notebook(notebookId)).active_run_id, null);
  } finally { f.close(); }
});

test("interrupt holds control until HTTP ACK even when a poll finds the old run terminal", async () => {
  const f = await setup();
  let unblock!: () => void;
  try {
    await f.call("run_cell", runArgs);
    f.remote.onInterrupt = () => new Promise<void>((resolve) => { unblock = resolve; });
    const interrupt = f.call("interrupt_cell", { notebookId });
    while (f.remote.interrupts === 0) await setImmediate();
    f.remote.value = result(f.remote.runId, "interrupted");
    await f.call("get_notebook", { notebookId });
    assert.equal((await f.store.notebook(notebookId)).state, "interrupting");
    await assert.rejects(f.call("run_cell", { ...runArgs, idempotencyKey: "run-after-interrupt" }), /notebook_busy/);
    unblock(); await interrupt;
    assert.equal((await f.store.notebook(notebookId)).state, "open");
    await f.call("run_cell", { ...runArgs, idempotencyKey: "run-after-interrupt" });
    assert.equal(f.remote.submissions, 2);
  } finally { unblock?.(); f.close(); }
});

test("unknown interrupt retains control; close saves terminal output before release", async () => {
  const f = await setup();
  try {
    await f.call("run_cell", runArgs);
    f.remote.onInterrupt = async () => { throw new SpikeError("request_timeout", "notebookInterrupt"); };
    await assert.rejects(f.call("interrupt_cell", { notebookId }), /request_timeout/);
    f.remote.value = result(f.remote.runId, "interrupted");
    await f.call("get_notebook", { notebookId });
    assert.equal((await f.store.notebook(notebookId)).state, "interrupting");
    await assert.rejects(f.call("run_cell", { ...runArgs, idempotencyKey: "run-after-unknown" }), /notebook_busy/);
    f.remote.beforeRelease = () => assert.equal(
      JSON.parse(String(f.sqlite.prepare("SELECT result_json FROM notebook_runs WHERE id=?").get(f.remote.runId)!.result_json)).status, "interrupted",
    );
    const closed = await f.call("close_notebook", { notebookId });
    assert.equal(closed.released, true); assert.equal(closed.outputsPersisted, true);
    assert.equal((await f.store.notebook(notebookId)).active_run_id, null);
  } finally { f.close(); }
});

test("close and dispatch CAS, output rescue default, explicit discard, reopen and monotonic release", async () => {
  const f = await setup();
  let unblock!: () => void;
  try {
    f.remote.onSubmit = () => new Promise<void>((resolve) => { unblock = resolve; });
    const submitting = f.call("run_cell", runArgs);
    while (f.remote.submissions === 0) await setImmediate();
    await assert.rejects(f.call("close_notebook", { notebookId }), /dispatch_in_progress/);
    unblock(); await submitting;
    const refused = await f.call("close_notebook", { notebookId });
    assert.equal((refused.error as any).code, "outputs_not_persisted"); assert.equal(f.remote.releases, 0);
    const oldRuntime = (await f.store.notebook(notebookId)).runtime_id!;
    const discarded = await f.call("close_notebook", { notebookId, discardOutputs: true });
    assert.equal(discarded.released, true); assert.equal(discarded.outputsPersisted, false);
    assert.equal((await f.store.run(f.remote.runId)).state, "incomplete");
    assert.equal((await f.store.notebook(notebookId)).active_run_id, null);
    f.remote.onSubmit = undefined;
    await f.call("open_notebook", { ...openArgs, idempotencyKey: "reopen-synthetic-2" });
    await f.store.finishRuntime(oldRuntime, false, { code: "late_error", stage: "close" });
    assert.equal((await f.store.runtime(oldRuntime)).released, 1);
    assert.equal((await f.store.notebook(notebookId)).state, "open");
    assert.equal(f.remote.allocations, 2);
  } finally { unblock?.(); f.close(); }
});

test("unknown allocation never reallocates; kernel failure releases only the captured endpoint", async () => {
  for (const kind of ["allocation", "kernel"]) {
    const f = await setup();
    try {
      await f.call("close_notebook", { notebookId });
      f.remote.failAllocate = kind === "allocation"; f.remote.failKernel = kind === "kernel";
      const args = { ...openArgs, idempotencyKey: "failed-open-key" };
      const failed = await f.call("open_notebook", args);
      assert.equal(failed.released, kind === "kernel");
      assert.equal(failed.allocationOutcomeUnknown, kind === "allocation" ? true : undefined);
      const allocations = f.remote.allocations;
      assert.equal((await f.call("open_notebook", args)).cached, true);
      assert.equal(f.remote.allocations, allocations);
      if (kind === "allocation") await assert.rejects(f.call("open_notebook", { ...args, idempotencyKey: "different-failed-open" }), /runtime_slot_unavailable/);
    } finally { f.close(); }
  }
});

test("late reservation completion cannot allocate and close recovers only its expired pre-allocation record", async (t) => {
  const f = await setup(), original = f.env.DB!;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resume!: () => void;
  try {
    f.env.DB = { prepare: original.prepare.bind(original), async batch(statements) {
      if (statements.some((statement) => (statement as unknown as { sql: string }).sql.includes("INSERT INTO notebook_runtimes"))) {
        await new Promise<void>((resolve) => { resume = resolve; });
      }
      return original.batch(statements);
    } } as D1Database;
    const args = { ...openArgs, notebookId: otherId, idempotencyKey: "late-reservation-key" };
    const pending = f.invoke("open_notebook", args);
    while (!resume) await setImmediate();
    t.mock.timers.tick(5000);
    const failed = await pending;
    assert.deepEqual(failed.error, { code: "step_timeout", stage: "notebookReserveOpen" });
    assert.equal(failed.reservationUnconfirmed, true); assert.equal(failed.allocationNotStartedByThisRequest, true);
    resume(); await setImmediate();
    assert.equal(f.remote.allocations, 1);
    const row = await f.store.notebook(otherId), runtime = await f.store.runtime(row.runtime_id!);
    assert.equal(row.state, "opening"); assert.equal(runtime.selected_accelerator, null);
    assert.equal((await f.call("open_notebook", args)).cached, true);
    await assert.rejects(f.call("close_notebook", { notebookId: otherId }), /open_or_dispatch_in_progress/);
    f.sqlite.prepare("UPDATE notebook_runtimes SET created_at=? WHERE id=?").run(Date.now() - 46_000, runtime.id);
    const recovered = await f.call("close_notebook", { notebookId: otherId });
    assert.equal(recovered.reservationCancelled, true); assert.equal(recovered.releaseRequired, false);
    assert.equal(recovered.released, true); assert.equal((recovered.notebook as any).state, "closed");
    assert.equal(f.remote.releases, 0); assert.equal(f.remote.allocations, 1);
    assert.equal((await f.call("open_notebook", args)).cached, true);
    await assert.rejects(f.store.selectRuntimeCompute(runtime.id, CPU_COMPUTE), /runtime_reservation_not_active/);
    assert.equal((await f.store.notebook(notebookId)).state, "open");
  } finally { resume?.(); f.env.DB = original; f.close(); }
});

test("stale opening recovery excludes allocation markers, active work, other owners and late allocation claims", async () => {
  const f = await setup();
  try {
    const { runtime } = await f.store.reserveOpen(otherId, "Stale synthetic", "stale-reservation-key");
    f.sqlite.prepare("UPDATE notebook_runtimes SET created_at=? WHERE id=?").run(Date.now() - 46_000, runtime.id);
    const row = await f.store.notebook(otherId);
    for (const [column, value] of [["selected_accelerator", "CPU"], ["endpoint", "uncertain-endpoint"],
      ["kernel_id", "uncertain-kernel"], ["compute_verified", 1]] as const) {
      f.sqlite.prepare(`UPDATE notebook_runtimes SET ${column}=? WHERE id=?`).run(value, runtime.id);
      assert.equal(await f.store.cancelStaleOpen(row, Date.now()), false);
      f.sqlite.prepare(`UPDATE notebook_runtimes SET ${column}=? WHERE id=?`).run(column === "compute_verified" ? 0 : null, runtime.id);
    }
    f.sqlite.prepare("UPDATE notebooks SET control_token='pending-control' WHERE id=?").run(otherId);
    assert.equal(await f.store.cancelStaleOpen(row, Date.now()), false);
    f.sqlite.prepare("UPDATE notebooks SET control_token=NULL WHERE id=?").run(otherId);
    assert.equal(await new NotebookStore(f.env, OTHER.userId).cancelStaleOpen(row, Date.now()), false);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(f.store.selectRuntimeCompute(runtime.id, CPU_COMPUTE, aborted.signal), /operation_deadline_exceeded/);
    assert.equal((await f.store.runtime(runtime.id)).selected_accelerator, null);
    // The allocation marker and stale-close claims race on the same persisted state.
    const claims = await Promise.allSettled([
      f.store.selectRuntimeCompute(runtime.id, CPU_COMPUTE), f.store.cancelStaleOpen(row, Date.now()),
    ]);
    const selected = (await f.store.runtime(runtime.id)).selected_accelerator === "CPU";
    assert.equal(claims[1].status === "fulfilled" && claims[1].value, !selected);
    assert.equal(claims[0].status === "fulfilled", selected);
    assert.equal(f.remote.allocations, 1); assert.equal(f.remote.releases, 0);
  } finally { f.close(); }
});

test("unconfirmed release retains this notebook lock without blocking other notebooks", async () => {
  const f = await setup();
  try {
    f.remote.failRelease = true;
    const failed = await f.call("close_notebook", { notebookId });
    assert.equal(failed.released, false); assert.equal(failed.recoveryEndpoint, "synthetic-owned-endpoint");
    await assert.rejects(f.call("open_notebook", { ...openArgs, idempotencyKey: "open-while-unreleased" }), /runtime_slot_unavailable/);
    await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "open-other-while-unreleased" });
    f.remote.failRelease = false; assert.equal((await f.call("close_notebook", { notebookId })).released, true);
    assert.equal((await f.store.notebook(otherId)).state, "open");
  } finally { f.close(); }
});

test("failure to persist terminal output retains runtime until a verified save succeeds", async () => {
  const f = await setup();
  const original = f.env.DB!;
  try {
    await f.call("run_cell", runArgs); f.remote.value = result(f.remote.runId);
    f.env.DB = { prepare: original.prepare.bind(original), async batch(statements) {
      if (statements.some((statement) => (statement as unknown as { sql: string }).sql.includes("result_json=COALESCE"))) {
        throw new Error("synthetic_D1_failure");
      }
      return original.batch(statements);
    } } as D1Database;
    const refused = await f.call("close_notebook", { notebookId });
    assert.equal((refused.error as any).code, "outputs_not_persisted");
    assert.equal(f.remote.releases, 0); assert.equal((await f.store.runtime((await f.store.notebook(notebookId)).runtime_id!)).released, 0);
    f.env.DB = original;
    const closed = await f.call("close_notebook", { notebookId });
    assert.equal(closed.outputsPersisted, true); assert.equal(closed.released, true);
  } finally { f.env.DB = original; f.close(); }
});

test("concurrent open retries allocate once", async () => {
  const f = await setup();
  try {
    await f.call("close_notebook", { notebookId });
    const args = { ...openArgs, idempotencyKey: "concurrent-reopen" };
    const [a, b] = await Promise.all([f.call("open_notebook", args), f.call("open_notebook", args)]);
    assert.equal((a.notebook as any).runtime.id, (b.notebook as any).runtime.id);
    assert.equal(f.remote.allocations, 2); // initial + one reopen
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes WHERE released=0").get()!.n, 1);
  } finally { f.close(); }
});

test("distinct notebooks open concurrently, one notebook cannot reserve competing attempts, compute is part of idempotency", async () => {
  const f = await setup();
  try {
    const third = crypto.randomUUID();
    await Promise.all([
      f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "parallel-gpu-open", compute: "AUTO" }),
      f.call("open_notebook", { ...openArgs, notebookId: third, idempotencyKey: "parallel-cpu-open" }),
    ]);
    assert.equal(f.remote.allocations, 3);
    assert.equal((await f.store.runtime((await f.store.notebook(otherId)).runtime_id!)).accelerator, "L4");
    assert.equal((await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "parallel-gpu-open", compute: "AUTO" })).cached, true);
    await assert.rejects(f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "parallel-gpu-open", compute: "L4" }), /idempotency_key_conflict/);
    await assert.rejects(f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "parallel-gpu-open", compute: "CPU" }), /idempotency_key_conflict/);
    const competingId = crypto.randomUUID();
    const contenders = await Promise.allSettled(["contender-a-key", "contender-b-key"].map((idempotencyKey) => f.call(
      "open_notebook", { ...openArgs, notebookId: competingId, idempotencyKey },
    )));
    assert.equal(contenders.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal(f.remote.allocations, 4);
    await f.call("close_notebook", { notebookId: otherId });
    // Even after release, a stale retry cannot reinterpret AUTO as a new request.
    await assert.rejects(f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "parallel-gpu-open", compute: "L4" }), /idempotency_key_conflict/);
  } finally { f.close(); }
});

test("ineligible GPU does not allocate; failed observed machine cleans up only its captured runtime", async () => {
  const f = await setup();
  try {
    const ineligible = await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "ineligible-gpu-open", compute: "H100" });
    assert.equal((ineligible.error as any).code, "gpu_not_eligible"); assert.equal(ineligible.released, true);
    assert.equal(f.remote.allocations, 1); assert.equal(f.remote.releases, 0);
    f.remote.failObserved = true; f.remote.failRelease = true;
    const failed = await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "mismatched-gpu-open", compute: "L4" });
    assert.equal((failed.error as any).code, "assignment_compute_mismatch"); assert.equal(failed.released, false);
    const runtime = await f.store.runtime((await f.store.notebook(otherId)).runtime_id!);
    assert.equal(runtime.compute_verified, 0); assert.equal(runtime.state, "unknown");
    assert.equal(f.remote.allocations, 2); assert.equal(f.remote.releases, 1);
    assert.equal((await f.store.notebook(notebookId)).state, "open");
    assert.equal((await f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "mismatched-gpu-open", compute: "L4" })).cached, true);
    await assert.rejects(f.call("open_notebook", { ...openArgs, notebookId: otherId, idempotencyKey: "do-not-reallocate", compute: "L4" }), /runtime_slot_unavailable/);
  } finally { f.close(); }
});

test("a retained legacy operation lock still blocks new notebook allocation", async () => {
  const f = fixture();
  try {
    // The retired feasibility probe used this singleton lock; production D1 may still hold one.
    f.sqlite.prepare("INSERT INTO operation_lock(singleton, operation_id) VALUES(1, 'legacy-probe')").run();
    const store = new NotebookStore(f.env, OWNER.userId);
    await assert.rejects(store.reserveOpen(notebookId, "Synthetic race", "synthetic-open-race"));
    assert.equal(Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes WHERE released=0").get()!.n), 0);
    f.sqlite.prepare("DELETE FROM operation_lock").run();
    await store.reserveOpen(notebookId, "Synthetic race", "synthetic-open-race");
    assert.equal(Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes WHERE released=0").get()!.n), 1);
  } finally { f.close(); }
});

test("compute status paginates every owned live notebook and cache failure preserves fresh upstream information", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 31; i++) await f.store.reserveOpen(crypto.randomUUID(), `Synthetic ${i}`, `synthetic-status-${i}`);
    await new NotebookStore(f.env, OTHER.userId).reserveOpen(crypto.randomUUID(), "Other owner secret title", "other-owner-status");
    const first = await f.call("get_compute_status", {});
    assert.equal(first.ownerRuntimeCount, 32); assert.equal((first.notebooks as any[]).length, 30);
    assert.equal(first.hasMore, true); assert.equal(first.serverRuntimeCap, null); assert.equal(first.queueEnabled, false);
    const second = await f.call("get_compute_status", { afterNotebookId: first.nextAfterNotebookId });
    assert.equal((second.notebooks as any[]).length, 2); assert.equal(second.hasMore, false);
    assert.equal(new Set([...(first.notebooks as any[]), ...(second.notebooks as any[])].map((row) => row.id)).size, 32);
    assert.ok(!JSON.stringify(first).includes("Other owner secret title")); assert.ok(!JSON.stringify(first).includes(OWNER.userId));
    assert.equal((first.notebooks as any[]).filter((row) => !row.runtime.computeVerified).every((row) => row.runtime.accelerator === null), true);
    const original = f.env.DB!;
    f.env.DB = { ...original, batch: original.batch.bind(original), prepare(sql) {
      const statement = original.prepare(sql);
      if (sql.includes("INSERT INTO latest_status")) return { bind() { return { async run() { throw new Error("synthetic cache failure"); } }; } } as unknown as D1PreparedStatement;
      return statement;
    } } as D1Database;
    const fresh = await f.call("get_compute_status", {});
    assert.equal(fresh.currentBalance, 100); assert.equal(fresh.error, undefined); assert.ok(fresh.storageWarning);
  } finally { f.close(); }
});

test("ipynb attaches outputs only to their exact saved source version and preserves audit", async () => {
  const f = await setup();
  try {
    await f.call("run_cell", runArgs); f.remote.value = result(f.remote.runId); await f.call("get_notebook", { notebookId });
    const before = await f.call("export_ipynb", { notebookId });
    assert.equal((before.ipynb as any).cells[0].outputs[0].text, "42\n");
    await f.call("upsert_cell", { notebookId, cellId, kind: "code", source: "print('new saved source')", expectedVersion: 1, notebookVersion: 2 });
    const after = await f.call("export_ipynb", { notebookId });
    assert.deepEqual((after.ipynb as any).cells[0].outputs, []);
    assert.equal((after.ipynb as any).cells[0].execution_count, null);
    const audit = await f.call("get_notebook", { notebookId, runId: f.remote.runId });
    assert.equal((audit.run as any).source, "x = 42\nprint(x)");
    assert.equal((audit.run as any).result.outputs[0].text, "42\n");
  } finally { f.close(); }
});

test("large PNG survives persistence, runtime close, document reload and ipynb export", async () => {
  const f = await setup();
  try {
    const png = syntheticPng();
    assert.ok(png.length > 377_000 && png.length < 512 * 1024);
    await f.call("run_cell", runArgs);
    const saved: RunResult = { ...result(f.remote.runId), outputs: [{
      output_type: "display_data", data: { "image/png": png }, metadata: {},
    }] };
    f.remote.value = parseRunResult(JSON.stringify(saved), f.remote.runId);
    await f.call("get_notebook", { notebookId });
    const closed = await f.call("close_notebook", { notebookId });
    assert.equal(closed.released, true); assert.equal(closed.outputsPersisted, true);
    const reloaded = await f.call("get_notebook", { notebookId });
    assert.equal((reloaded.notebook as any).cells[0].lastRun.result.outputs[0].data["image/png"], png);
    const exported = await f.call("export_ipynb", { notebookId });
    assert.equal((exported.ipynb as any).cells[0].outputs[0].data["image/png"], png);
    assert.equal(f.remote.allocations, 1);
  } finally { f.close(); }
});

test("document and export budgets omit whole outputs before D1 returns them; individual load still works", async () => {
  const f = await setup();
  try {
    const png = syntheticPng();
    const runtime = (await f.store.notebook(notebookId)).runtime_id!;
    let selected = "";
    for (let i = 0; i < 24; i++) {
      const cell = crypto.randomUUID(), run = crypto.randomUUID();
      if (i === 0) selected = run;
      f.sqlite.prepare("INSERT INTO notebook_cells(id,notebook_id,kind,source,version,position,updated_at) VALUES(?,?,'code','image',1,?,1)")
        .run(cell, notebookId, i + 1);
      const value = { ...result(run), outputs: [{ output_type: "display_data", data: { "image/png": png }, metadata: {} }] };
      f.sqlite.prepare(`INSERT INTO notebook_runs(id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,result_json,created_at,updated_at)
        VALUES(?,?,?,?,1,?,'image','user','ok',?,?,1)`)
        .run(run, notebookId, runtime, cell, run, JSON.stringify(value), i + 1);
    }
    const rows = await f.store.runs(notebookId, MAX_RETURN_OUTPUT_BYTES);
    assert.ok(rows.some((run) => run.result_omitted === 1 && run.result_json === null));
    assert.ok(rows.reduce((sum, run) => sum + Buffer.byteLength(run.result_json ?? ""), 0) <= MAX_RETURN_OUTPUT_BYTES);
    const document = await f.call("get_notebook", { notebookId });
    const cells = (document.notebook as any).cells;
    assert.ok(cells.some((cell: any) => cell.lastRun?.outputsOmitted));
    const detail = await f.call("get_notebook", { notebookId, runId: selected });
    assert.equal((detail.run as any).result.outputs[0].data["image/png"], png);
    const exported = await f.call("export_ipynb", { notebookId });
    const exportedCells = (exported.ipynb as any).cells;
    assert.ok(exportedCells.some((cell: any) => cell.metadata.colab_site.outputsOmitted && !cell.outputs.length));
    assert.ok(exportedCells.filter((cell: any) => cell.outputs.length).length > cells.filter((cell: any) => cell.lastRun?.result).length);
    assert.ok(exportedCells.reduce((sum: number, cell: any) => sum + Buffer.byteLength(JSON.stringify(cell.outputs)), 0) < MAX_EXPORT_OUTPUT_BYTES);
  } finally { f.close(); }
});

test("storage rejects oversized serialized results before updating a run", async () => {
  const f = await setup();
  try {
    await f.call("run_cell", runArgs);
    await assert.rejects(f.store.updateRun(f.remote.runId, "ok", result(f.remote.runId, "ok", "x".repeat(MAX_RESULT_BYTES))), /result_limit/);
    assert.equal((await f.store.run(f.remote.runId)).result_json, null);
  } finally { f.close(); }
});

test("result limits accept worst-case JSON controls, reject oversize, and strip HTML", () => {
  const runId = crypto.randomUUID();
  const controls = result(runId, "ok", "\u0000".repeat(24_000));
  assert.ok(JSON.stringify(controls).length > 48_000);
  assert.equal(parseRunResult(JSON.stringify(controls), runId).outputs.length, 1);
  assert.throws(() => parseRunResult(JSON.stringify(result(runId, "ok", "中".repeat(9000))), runId), /output_limit/);
  assert.throws(() => parseRunResult(" ".repeat(MAX_RESULT_BYTES + 1), runId), /result_limit/);
  assert.throws(() => parseRunResult(JSON.stringify(controls), otherId), /result_invalid/);
  const display = { ...result(runId), outputs: [{ output_type: "display_data", data: { "text/html": "<script>bad</script>", "image/svg+xml": "bad", "text/plain": "safe" } }] };
  assert.deepEqual((parseRunResult(JSON.stringify(display), runId).outputs[0] as any).data, { "text/plain": "safe" });
});

test("browser API requires exact same origin, owner and valid bounded UUID arguments", async () => {
  const f = await setup();
  const request = (origin: string | null, owner = OWNER, base = SITE_ORIGIN) => new Request(`${base}/api/notebooks`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}),
      "oai-authenticated-user-id": owner.userId, "oai-authenticated-user-email": owner.email },
    body: JSON.stringify({ name: "get_notebook", arguments: {} }),
  });
  try {
    assert.equal((await notebookApi(request(null), f.env, noNetwork)).status, 403);
    assert.equal((await notebookApi(request("https://attacker.example"), f.env, noNetwork)).status, 403);
    const other = await (await notebookApi(request(SITE_ORIGIN, OTHER), f.env, noNetwork)).json() as any;
    assert.equal(other.error.code, "owner_required");
    const local = "http://127.0.0.1:5173";
    assert.equal((await notebookApi(request(local, OWNER, local), f.env, noNetwork)).status, 200);
    assert.throws(() => validateNotebookArguments("get_notebook", { notebookId: "../../oauth" }), /argument_value/);
    assert.throws(() => validateNotebookArguments("open_notebook", { ...openArgs, ownerId: OTHER.userId }), /unexpected/);
    assert.throws(() => validateNotebookArguments("upsert_cell", { notebookId, cellId, kind: "code", source: "a".repeat(16001), expectedVersion: 0, notebookVersion: 1 }), /argument_value/);
  } finally { f.close(); }
});

test("attachment retries are URL-free, imports exclude running cells, unknown ACK recovers and expiry can retry", async () => {
  const f = await setup();
  const file = { download_url: "https://files.example.com/synthetic.csv?signature=do-not-persist",
    file_id: "file_synthetic", file_name: "data.csv", mime_type: "text/csv" };
  const args = { notebookId, idempotencyKey: "synthetic-input-key", file };
  try {
    await f.call("run_cell", runArgs);
    await assert.rejects(f.call("import_file", args), /busy/);
    f.remote.value = result(f.remote.runId); await f.call("get_notebook", { notebookId });
    f.remote.unknownAck = true;
    const [first, retry] = await Promise.all([f.call("import_file", args), f.call("import_file", args)]);
    assert.equal((first.input as any).id, (retry.input as any).id); assert.equal(f.remote.inputSubmissions, 1);
    await assert.rejects(f.call("run_cell", { ...runArgs, idempotencyKey: "during-input-run" }), /busy/);
    await assert.rejects(f.call("close_notebook", { notebookId }), /input_import_in_progress/);
    await assert.rejects(f.call("import_file", { ...args, file: { ...file, file_id: "different_file" } }), /idempotency_key_conflict/);
    const refreshed = await f.call("import_file", { ...args, file: { ...file, download_url: "https://files.example.com/fresh-url" } });
    assert.equal(refreshed.cached, true); assert.equal(f.remote.inputSubmissions, 1);
    f.remote.inputResult = { protocol: 1, inputId: f.remote.inputId, status: "error", size: null, sha256: null,
      startedAt: Date.now(), finishedAt: Date.now(), error: { code: "download_expired", httpStatus: 403 } };
    const expired = await f.call("get_notebook", { notebookId });
    assert.equal((expired.notebook as any).state, "open");
    assert.equal((expired.notebook as any).inputs[0].error.code, "download_expired");
    f.remote.unknownAck = false;
    const fresh = await f.call("import_file", { ...args, idempotencyKey: "synthetic-input-fresh", file: { ...file, download_url: "https://files.example.com/fresh-url" } });
    assert.notEqual((fresh.input as any).path, (first.input as any).path);
    f.remote.inputResult = { ...f.remote.inputResult, inputId: f.remote.inputId, status: "ready", size: 24, sha256: "a".repeat(64), error: null };
    const complete = await f.call("get_notebook", { notebookId });
    assert.equal((complete.notebook as any).state, "open");
    assert.equal((complete.notebook as any).inputs.find((row: any) => row.id === f.remote.inputId).bytes, 24);
    const stored = JSON.stringify(f.sqlite.prepare("SELECT * FROM notebook_inputs").all());
    for (const output of [stored, JSON.stringify(complete), JSON.stringify(await f.call("export_ipynb", { notebookId }))]) {
      assert.ok(!output.includes("do-not-persist")); assert.ok(!output.includes("download_url"));
    }
    await assert.rejects(new NotebookStore(f.env, OTHER.userId).input(f.remote.inputId), /not_found/);
    await f.call("import_file", { ...args, idempotencyKey: "synthetic-input-discard" });
    f.remote.inputResult = null;
    const closed = await f.call("close_notebook", { notebookId, discardOutputs: true });
    assert.equal(closed.released, true); assert.equal((await f.store.notebook(notebookId)).active_input_id, null);
  } finally { f.close(); }
});

test("bootstrap setup dispatches only once in short reads, excludes cell/import, and can be explicitly closed", async () => {
  const f = await setup();
  try {
    const before = f.remote.setupSubmissions;
    f.remote.setupPending = true;
    const args = { notebookId, target: "packages", idempotencyKey: "synthetic-setup-key" };
    const prepared = await f.invoke("prepare_runtime", args);
    assert.equal((prepared.notebook as any).state, "preparing");
    assert.equal(f.remote.setupSubmissions, before);
    await Promise.all([f.invoke("get_notebook", { notebookId }), f.invoke("get_notebook", { notebookId })]);
    assert.equal(f.remote.setupSubmissions, before + 1);
    await f.invoke("get_notebook", { notebookId }); assert.equal(f.remote.setupSubmissions, before + 1);
    await assert.rejects(f.invoke("run_cell", runArgs), /busy/);
    await assert.rejects(f.invoke("close_notebook", { notebookId }), /runtime_setup_in_progress/);
    const cached = await f.invoke("prepare_runtime", args); assert.equal(cached.cached, true);
    f.remote.setupPending = false;
    await f.invoke("get_notebook", { notebookId }); assert.equal((await f.store.notebook(notebookId)).state, "open");
    await f.invoke("prepare_runtime", { ...args, idempotencyKey: "pending-setup-cancel" });
    const closed = await f.invoke("close_notebook", { notebookId });
    assert.equal(closed.released, true); assert.equal(f.remote.setupSubmissions, before + 1);
  } finally { f.close(); }
});

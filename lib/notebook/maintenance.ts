/** Scheduled maintenance: artifact retention plus idle runtime release. */
import type { SpikeEnv } from "../platform/config.ts";
import { boundedStep } from "../platform/deadline.ts";
import { safeError, SpikeError } from "../platform/security.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { effectiveIdlePolicy, idleDue, idleSince } from "./policy.ts";
import type { NotebookRuntime } from "./runtime.ts";
import type { MaintenanceScan, NotebookStore } from "./store.ts";
import { TERMINAL_RUNS } from "./types.ts";
import type { NotebookRow, RunResult } from "./types.ts";

/** The NotebookService members maintenance relies on. */
export interface MaintenanceHost {
  readonly env: SpikeEnv;
  readonly ownerId: string;
  readonly store: NotebookStore;
  readonly controller: AbortController;
  now(): number;
  remaining(): number;
  step<T>(name: string, work: (signal: AbortSignal) => Promise<T>, ms?: number): Promise<T>;
  remote(): Promise<Pick<NotebookRuntime, "release">>;
  advanceSetup(notebook: NotebookRow, allowDispatch?: boolean): Promise<void>;
  pollInput(notebook: NotebookRow): Promise<void>;
  poll(notebook: NotebookRow, archiveAllowed?: boolean): Promise<RunResult | null>;
}

async function retention(host: MaintenanceHost, observedAt: number, summary: Record<string, unknown>): Promise<void> {
  const deadline = performance.now() + 6000;
  const step = <T>(name: string, work: () => Promise<T>) => boundedStep(name,
    Math.min(2000, deadline - performance.now(), host.remaining() - 20_000), host.controller.signal, work);
  const record = (error: unknown) => { (summary.errors as Record<string, unknown>[]).push(safeError(error)); };
  const artifacts = new ArtifactStore(host.env, host.ownerId);
  try {
    // One failed/slow object must not consume the budget for live runtime cleanup.
    const retiring = await step("maintenanceRetention", () => artifacts.retiring(observedAt, 1));
    for (const row of retiring) {
      try {
        if (!host.env.BUCKET) throw new SpikeError("artifact_bucket_missing", "maintenance");
        await step("maintenanceArtifactDelete", async () => { await host.env.BUCKET!.delete(row.object_key); });
        await step("maintenanceArtifactExpired", () => artifacts.expired(row.id));
        summary.retired = Number(summary.retired) + 1;
      } catch (error) { record(error); }
    }
    await step("maintenanceTokenExpiry", () => artifacts.expireDownloadTokens(observedAt));
    const remainingExpiry = await step("maintenanceRemainingExpiry", () => artifacts.retentionPendingCount(observedAt));
    summary.actionablePending = Number(summary.actionablePending) + remainingExpiry;
    const tokenExpiry = await step("maintenanceRemainingTokens", () => artifacts.expiredTokenCount(observedAt));
    summary.actionablePending = Number(summary.actionablePending) + Math.ceil(tokenExpiry / 128);
  } catch (error) { summary.retentionDeferred = true; record(error); }
}
/** One bounded maintenance pass: retention, then a fair page of live notebooks. */
export async function runMaintenance(host: MaintenanceHost): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const observedAt = host.now();
  const summary: Record<string, unknown> = { maintenanceRunId: id, observedAt, processed: 0, pending: 0,
    actionablePending: 0, runningCount: 0, released: 0, retired: 0, scanned: 0, scanRemaining: 0,
    notebooks: [] as Record<string, unknown>[], errors: [] as Record<string, unknown>[] };
  await host.step("maintenanceStart", () => host.store.startMaintenance(id, observedAt));
  let scan: MaintenanceScan | null = null;
  let afterId = "";
  try {
    scan = await host.step("maintenanceScanClaim", () => host.store.beginScan());
    if (!scan) {
      summary.busy = true;
    } else {
    afterId = scan.after_id;
    summary.scanRemaining = await host.step("maintenanceScanCount", () => host.store.liveCount(afterId));
    await retention(host, observedAt, summary);
    const rows = await host.step("maintenanceNotebooks", () => host.store.live(afterId));
    let cleanupStarted = false;
    for (const initial of rows) {
      if (host.remaining() < 5000 || cleanupStarted) break;
      const item: Record<string, unknown> = { notebookId: initial.id };
      try {
        if (initial.active_setup_id) await host.advanceSetup(initial);
        if (initial.active_input_id) await host.pollInput(initial);
        if (initial.active_run_id) {
          const before = await host.step("maintenanceArtifactsBefore", () => new ArtifactStore(host.env, host.ownerId).list(initial.id, initial.active_run_id!));
          await host.poll(initial, Number(summary.processed) === 0);
          const after = await host.step("maintenanceArtifactsAfter", () => new ArtifactStore(host.env, host.ownerId).list(initial.id, initial.active_run_id!));
          summary.processed = Number(summary.processed) + after.filter((row) => row.state === "ready").length - before.filter((row) => row.state === "ready").length;
        }
        const notebook = await host.step("maintenanceNotebookReadback", () => host.store.notebook(initial.id));
        const runtime = await host.step("maintenanceRuntime", () => host.store.runtime(notebook.runtime_id!));
        const evaluatedAt = host.now();
        const policy = effectiveIdlePolicy(runtime);
        item.evaluatedAt = evaluatedAt;
        item.idlePolicy = policy; item.idleSince = idleSince(notebook, runtime);
        if (notebook.runtime_id !== initial.runtime_id) {
          item.reason = "runtime_changed";
        } else if (notebook.active_setup_id) {
          item.reason = "runtime_setup_pending"; item.pending = true;
          summary.pending = Number(summary.pending) + 1; summary.runningCount = Number(summary.runningCount) + 1;
        } else if (notebook.active_input_id) {
          item.reason = "input_import_pending"; item.pending = true;
          summary.pending = Number(summary.pending) + 1;
          summary.runningCount = Number(summary.runningCount) + 1;
        } else if (notebook.active_run_id) {
          const run = await host.step("maintenanceActiveRun", () => host.store.run(notebook.active_run_id!));
          item.runState = run.state; item.artifactsState = run.artifacts_state;
          item.pending = true; summary.pending = Number(summary.pending) + 1;
          if (TERMINAL_RUNS.has(run.state) && run.artifacts_state === "pending") {
            const artifacts = await host.step("maintenancePendingFiles", () => new ArtifactStore(host.env, host.ownerId).list(notebook.id, run.id));
            item.actionablePending = Math.max(1, artifacts.filter((row) => row.state === "pending").length);
            summary.actionablePending = Number(summary.actionablePending) + Number(item.actionablePending);
          } else if (!TERMINAL_RUNS.has(run.state)) summary.runningCount = Number(summary.runningCount) + 1;
        } else if (idleDue(notebook, runtime, evaluatedAt) || ["closing", "unknown"].includes(notebook.state)) {
          const due = idleDue(notebook, runtime, evaluatedAt);
          const claim = await host.step("maintenanceIdleClaim", () => due
            ? host.store.beginIdleClose(notebook, evaluatedAt - policy.milliseconds) : host.store.retryIdleClose(notebook));
          if (claim) {
            const bridge = await host.remote();
            cleanupStarted = true;
            const cleanup = await bridge.release(runtime);
            await boundedStep("maintenanceReleaseLedger", 2000, undefined, () => host.store.finishRuntime(
              runtime.id, cleanup.released, cleanup.released ? null : { code: "idle_release_unconfirmed", stage: "maintenance" },
            ));
            item.reason = due ? "idle_due" : "idle_cleanup_retry"; item.released = cleanup.released;
            if (cleanup.cleanupError) item.cleanupError = cleanup.cleanupError;
            if (cleanup.confirmationError) item.confirmationError = cleanup.confirmationError;
            if (cleanup.released) summary.released = Number(summary.released) + 1;
            else throw new SpikeError("release_unconfirmed", "maintenance");
          } else item.reason = "activity_or_run_changed";
        } else item.reason = "not_due_or_control_unresolved";
      } catch (error) {
        item.error = safeError(error); (summary.errors as Record<string, unknown>[]).push({ notebookId: initial.id, ...safeError(error) });
        summary.pending = Number(summary.pending) + 1;
      }
      (summary.notebooks as Record<string, unknown>[]).push(item);
      // Advance even past a blocked/error notebook; it must not starve later IDs.
      afterId = initial.id; summary.scanned = Number(summary.scanned) + 1;
      summary.scanRemaining = Math.max(0, Number(summary.scanRemaining) - 1);
    }
    }
  } catch (error) { (summary.errors as Record<string, unknown>[]).push(safeError(error)); }
  if (scan && Number(summary.scanRemaining) === 0 && (summary.errors as unknown[]).length === 0) {
    afterId = ""; summary.sweepComplete = true;
  } else if (scan && Number(summary.scanRemaining) === 0 && Number(summary.scanned) > 0) {
    // Per-notebook failures still finish the sweep; the next scheduled sweep retries them.
    afterId = ""; summary.sweepComplete = true;
  }
  summary.actionablePending = Number(summary.actionablePending) + Number(summary.scanRemaining);
  summary.ok = (summary.errors as unknown[]).length === 0;
  summary.remaining = Number(summary.pending) + Number(summary.scanRemaining);
  try { await boundedStep("maintenanceResult", 2000, undefined,
    () => host.store.finishScan(scan, afterId, id, summary, host.now())); }
  catch { summary.ok = false; summary.ledgerError = { code: "maintenance_result_unconfirmed", stage: "storage" }; }
  return summary;
}

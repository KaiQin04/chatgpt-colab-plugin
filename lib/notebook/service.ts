/** Owner-scoped notebook operations. No detached promises or Worker background jobs. */
import type { Fetcher, Identity, SpikeEnv } from "../platform/config.ts";
import { SITE_ORIGIN } from "../platform/config.ts";
import { ColabClient } from "../colab/client.ts";
import { boundedStep, requireActive } from "../platform/deadline.ts";
import { accessToken } from "../platform/oauth.ts";
import { safeError, SpikeError } from "../platform/security.ts";
import { Store } from "../platform/store.ts";
import { NotebookRuntime } from "./runtime.ts";
import { NotebookStore } from "./store.ts";
import { selectCompute } from "./compute.ts";
import { inputView, validateInputFile } from "./inputs.ts";
import { SetupStore, setupView } from "./setup.ts";
import type { SetupKind } from "./setup.ts";
import { ArtifactStore, artifactPath } from "./artifact-store.ts";
import { archiveRun, artifactView, previewArtifact } from "./artifacts.ts";
import { effectiveIdlePolicy, idleSince } from "./policy.ts";
import { MAX_RETURN_OUTPUT_BYTES, MAX_EXPORT_OUTPUT_BYTES, OUTLINE_CELL_THRESHOLD, OUTLINE_SOURCE_THRESHOLD, SHORT_REQUEST_MS, TERMINAL_RUNS } from "./types.ts";
import type { NotebookRow, RunResult, RunRow } from "./types.ts";
import type { CellView, DocumentView, NotebookView } from "./contract.ts";
import { runMaintenance } from "./maintenance.ts";
import { computeNotebookView, runtimeView, runView } from "./views.ts";

type RuntimeOps = Pick<NotebookRuntime, "computeStatus" | "allocate" | "startKernel" | "submit" | "poll" | "submitInput" | "pollInput" | "submitSetup" | "pollSetup" | "interrupt" | "release" | "readArtifact">;
export interface ServiceOptions {
  fetcher?: Fetcher; signal?: AbortSignal; actor?: "user" | "assistant";
  runtimeFactory?: (client: ColabClient, fetcher: Fetcher) => RuntimeOps;
  now?: () => number;
}
/** One bounded request context. Each I/O is checked before it starts. */
class NotebookService {
  readonly store: NotebookStore;
  readonly controller = new AbortController();
  readonly started = performance.now();
  readonly fetcher: Fetcher;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abort = () => this.controller.abort();
  bridge?: RuntimeOps;
  constructor(readonly env: SpikeEnv, readonly ownerId: string, readonly options: ServiceOptions) {
    this.store = new NotebookStore(env, ownerId);
    this.fetcher = options.fetcher ?? fetch;
    this.timer = setTimeout(this.abort, SHORT_REQUEST_MS);
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }
  dispose(): void { clearTimeout(this.timer); this.options.signal?.removeEventListener("abort", this.abort); }
  remaining(): number { return SHORT_REQUEST_MS - (performance.now() - this.started); }
  now = (): number => (this.options.now ?? Date.now)();
  step<T>(name: string, work: (signal: AbortSignal) => Promise<T>, ms = 2000): Promise<T> {
    return boundedStep(name, Math.min(ms, this.remaining()), this.controller.signal, work);
  }
  async remote(): Promise<RuntimeOps> {
    if (!this.bridge) {
      const token = await this.step("notebookGoogleToken", (signal) => accessToken(
        this.env, this.ownerId, this.fetcher, signal, { storageTimeoutMs: 2000 },
      ), 10_000);
      const client = new ColabClient(token, this.fetcher);
      this.bridge = this.options.runtimeFactory?.(client, this.fetcher) ?? new NotebookRuntime(client, this.fetcher);
    }
    return this.bridge;
  }
  async document(id: string, selectedRunId?: string,
    shape: { view?: "auto" | "outline" | "full"; cellIds?: string[] } = {}): Promise<DocumentView> {
    const notebook = await this.step("notebookRead", async () => this.store.notebook(id));
    const cells = await this.step("notebookCells", async () => this.store.cells(id));
    const runs = await this.step("notebookRuns", async () => this.store.runs(id, MAX_RETURN_OUTPUT_BYTES));
    const runtime = notebook.runtime_id ? await this.step("notebookRuntime", async () => this.store.runtime(notebook.runtime_id!)) : null;
    const inputs = await this.step("notebookInputs", () => this.store.inputs(id));
    const setup = runtime ? await this.step("notebookSetupTasks", () => new SetupStore(this.env, this.ownerId).list(runtime.id)) : [];
    let outputBudget = MAX_RETURN_OUTPUT_BYTES;
    const safeRun = (row: RunRow, source = false) => {
      const view = runView(row, source);
      const size = new TextEncoder().encode(JSON.stringify(view.result)).byteLength;
      if (size > outputBudget) { view.result = null; view.outputsOmitted = true; }
      else outputBudget -= size;
      return view;
    };
    const selectedRun = selectedRunId
      ? safeRun(await this.step("notebookSelectedRun", async () => this.store.run(selectedRunId, id)), true) : null;
    const totalSource = cells.reduce((sum, cell) => sum + cell.source.length, 0);
    const outline = shape.view === "outline" || (shape.view !== "full" &&
      (totalSource > OUTLINE_SOURCE_THRESHOLD || cells.length > OUTLINE_CELL_THRESHOLD));
    const details = new Set(shape.cellIds ?? []);
    return { notebook: { id: notebook.id, title: notebook.title, version: notebook.version,
      state: notebook.state, createdAt: notebook.created_at, updatedAt: notebook.updated_at,
      activeRunId: notebook.active_run_id, runtime: runtimeView(runtime),
      activeInputId: notebook.active_input_id,
      activeSetupId: notebook.active_setup_id, setupTasks: setup.map(setupView),
      inputs: inputs.slice(0, 32).map((row) => inputView(row, runtime?.released === 0 ? runtime.id : null)),
      inputsTruncated: inputs.length > 32,
      workingDirectory: `/content/${id}`, outputsDirectory: `/content/${id}/outputs`,
      lastActivityAt: notebook.last_activity_at || notebook.created_at, lastTerminalAt: notebook.last_terminal_at,
      ...(runtime ? { idle: { ...effectiveIdlePolicy(runtime),
        since: idleSince(notebook, runtime) } } : {}),
      controlPending: notebook.control_token !== null,
      structureVersion: notebook.structure_version,
      view: outline ? "outline" : "full",
      cells: cells.map((cell): CellView => {
        const run = runs.find((run) => run.cell_id === cell.id);
        const base = { id: cell.id, kind: cell.kind, version: cell.version, position: cell.position,
          updatedBy: cell.updated_by, updatedAt: cell.updated_at };
        if (outline && !details.has(cell.id)) {
          const lines = cell.source.split("\n");
          return { ...base, outline: true, sourceLength: cell.source.length,
            preview: lines.slice(0, 3).join("\n").slice(0, 240), lineCount: lines.length,
            lastRun: run ? { id: run.id, state: run.state, artifactsState: run.artifacts_state, actor: run.actor,
              terminalAt: run.terminal_at } : null };
        }
        return { ...base, source: cell.source, lastRun: run ? safeRun(run) : null };
      }) } satisfies NotebookView, ...(selectedRun ? { run: selectedRun } : {}) };
  }
  async poll(notebook: NotebookRow, archiveAllowed = true): Promise<RunResult | null> {
    if (!notebook.active_run_id || !notebook.runtime_id) return null;
    const run = await this.step("notebookActiveRun", async () => this.store.run(notebook.active_run_id!, notebook.id));
    const runtime = await this.step("notebookRuntime", async () => this.store.runtime(notebook.runtime_id!));
    const remote = await this.remote();
    const result: RunResult | null = TERMINAL_RUNS.has(run.state)
      ? run.result_json ? JSON.parse(run.result_json) : null : await remote.poll(runtime, run.id, this.controller.signal);
    requireActive(this.controller.signal, "notebookPollSave");
    if (result) {
      await this.step("notebookPollSave", async () => this.store.updateRun(run.id, result.status, result));
      if (result.status !== "running") {
        const recorded = await this.step("notebookArtifactRun", async () => this.store.run(run.id));
        if (archiveAllowed && !["saved", "legacy", "discarded"].includes(recorded.artifacts_state)) {
          const archived = await archiveRun(this.env, this.ownerId, recorded, runtime, remote,
            this.controller.signal, this.now);
          if (archived.error) throw new SpikeError(String(archived.error.code), "artifacts");
        }
      }
    }
    else if (run.state === "dispatching" && this.now() - run.created_at > 45_000) {
      await this.step("notebookDispatchRecovery", async () => this.store.updateRun(run.id, "unknown", null,
        { code: "dispatch_ack_unknown", stage: "submit" }));
    }
    return result;
  }
  async get(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!args.notebookId) {
      const rows = await this.step("notebookList", async () => this.store.list());
      return { latestMaintenance: await this.step("latestMaintenance", () => this.store.latestMaintenance()),
        notebooks: rows.map((row) => ({ id: row.id, title: row.title, version: row.version,
        state: row.state, activeRunId: row.active_run_id, activeSetupId: row.active_setup_id, updatedAt: row.updated_at })) };
    }
    const id = args.notebookId as string;
    const row = await this.step("notebookRead", async () => this.store.notebook(id));
    let pollError: Record<string, unknown> | undefined;
    if (row.active_setup_id) {
      try { await this.advanceSetup(row); } catch (error) { pollError = safeError(error); }
    }
    if (row.active_input_id) {
      try { await this.pollInput(row); } catch (error) { pollError = safeError(error); }
    }
    if (row.active_run_id && row.state !== "closed") {
      try { await this.poll(row); } catch (error) { pollError = safeError(error); }
    }
    return { ...await this.document(id, args.runId as string | undefined, {
      view: args.view as "auto" | "outline" | "full" | undefined, cellIds: args.cellIds as string[] | undefined,
    }), ...(pollError ? { pollError } : {}) };
  }
  async pollInput(notebook: NotebookRow): Promise<void> {
    if (!notebook.active_input_id || !notebook.runtime_id) return;
    const input = await this.step("notebookActiveInput", () => this.store.input(notebook.active_input_id!));
    const runtime = await this.step("notebookInputRuntime", () => this.store.runtime(input.runtime_id));
    const result = await (await this.remote()).pollInput(runtime, input, this.controller.signal);
    if (result) await this.step("notebookInputResult", () => this.store.updateInput(input.id, result.status, result));
  }
  async importFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const file = validateInputFile(args.file);
    const reserved = await this.step("notebookInputReserve", () => this.store.reserveInput(
      args.notebookId as string, file, args.idempotencyKey as string,
    ));
    const input = reserved.input;
    if (!reserved.cached) {
      let error: Record<string, unknown> | null = null;
      try {
        const runtime = await this.step("notebookInputRuntime", () => this.store.runtime(input.runtime_id));
        await (await this.remote()).submitInput(runtime, input.id, file, this.controller.signal);
      } catch (caught) { error = safeError(caught); }
      await boundedStep("notebookInputSubmitted", 2000, undefined,
        () => this.store.updateInput(input.id, error ? "unknown" : "submitted", null, error));
    }
    const stored = await this.step("notebookInputReadback", () => this.store.input(input.id));
    return { cached: reserved.cached, input: inputView(stored, input.runtime_id),
      ...(stored.error_json ? { error: JSON.parse(stored.error_json) } : {}), ...await this.document(input.notebook_id) };
  }
  async open(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let reserved: Awaited<ReturnType<NotebookStore["reserveOpen"]>>;
    try {
      reserved = await this.step("notebookReserveOpen", (signal) => this.store.reserveOpen(
        args.notebookId as string, (args.title as string | undefined) ?? "Untitled notebook", args.idempotencyKey as string,
        (args.compute as string | undefined) ?? "CPU", signal,
      ), 5000);
    } catch (caught) {
      if (caught instanceof SpikeError && !["step_timeout", "operation_deadline_exceeded"].includes(caught.code)) throw caught;
      return { ok: false, notebookId: args.notebookId, error: safeError(caught),
        reservationUnconfirmed: true, allocationNotStartedByThisRequest: true };
    }
    const runtime = reserved.runtime;
    if (reserved.cached) return { cached: true, ...await this.document(runtime.notebook_id),
      ...(runtime.error_json ? { error: JSON.parse(runtime.error_json) } : {}) };
    let owned: string | undefined;
    let mayExist = false;
    let bridge: RuntimeOps | undefined;
    let error: Record<string, unknown> | undefined;
    let cleanup: Awaited<ReturnType<RuntimeOps["release"]>> | undefined;
    try {
      bridge = await this.remote();
      const info = runtime.requested_compute === "CPU" ? null : await bridge.computeStatus(this.controller.signal);
      const selected = selectCompute(runtime.requested_compute, info?.eligibleGpus);
      await this.step("notebookSelectCompute", (signal) => this.store.selectRuntimeCompute(runtime.id, selected, signal));
      runtime.selected_accelerator = selected.accelerator; runtime.machine_kind = selected.kind;
      requireActive(this.controller.signal, "notebookAllocate");
      const actual = await bridge.allocate(runtime.notebook_hash, this.controller.signal, async (endpoint) => {
        owned = endpoint;
        runtime.endpoint = endpoint;
        await this.step("notebookRecordEndpoint", async () => this.store.endpoint(runtime.id, endpoint));
      }, (value) => {
        if (value && this.remaining() < 10_000) throw new SpikeError("insufficient_operation_budget_before_assign", "open");
        mayExist = value;
      }, selected);
      requireActive(this.controller.signal, "notebookObservedCompute");
      await this.step("notebookObservedCompute", () => this.store.observedRuntimeCompute(runtime.id, actual));
      runtime.accelerator = actual.accelerator; runtime.compute_verified = 1;
      requireActive(this.controller.signal, "notebookKernelStart");
      runtime.kernel_id = await bridge.startKernel(runtime, this.controller.signal);
      const settings = await this.step("notebookBootPackages", () => new SetupStore(this.env, this.ownerId).settings());
      await this.step("notebookOpened", async () => this.store.opened(runtime.id, runtime.kernel_id!, settings.packages));
      return { cached: false, ...await this.document(runtime.notebook_id) };
    } catch (caught) { error = safeError(caught); }
    // No main/request cancellation signal enters release. A failure never allocates again.
    if (bridge && owned) cleanup = await bridge.release(runtime);
    const released = cleanup?.released ?? !mayExist;
    try { await boundedStep("notebookOpenResult", 2000, undefined,
      async () => this.store.finishRuntime(runtime.id, released, error ?? null)); }
    catch { return { ok: false, cached: false, notebookId: runtime.notebook_id,
      error, ledgerError: { code: "open_result_unconfirmed", stage: "storage" },
      released, ...(owned && !released ? { recoveryEndpoint: owned } : {}) }; }
    let currentNotebooks: Record<string, unknown>[] | undefined;
    try { currentNotebooks = (await boundedStep("notebookOpenFailureStatus", 2000, undefined,
      () => this.store.computePage())).slice(0, 30).map((row) => computeNotebookView(row, this.now())); }
    catch { /* The allocation error and retained ledger take precedence over optional status. */ }
    return { ok: false, cached: false, notebookId: runtime.notebook_id, error, released,
      ...(currentNotebooks ? { currentNotebooks, currentNotebooksTruncated: currentNotebooks.length === 30 } : {}),
      ...(cleanup ? { cleanup } : {}), ...(owned && !released ? { recoveryEndpoint: owned } : {}),
      ...(mayExist && !owned ? { allocationOutcomeUnknown: true } : {}) };
  }
  async settings(args: Record<string, unknown>, write: boolean): Promise<Record<string, unknown>> {
    const store = new SetupStore(this.env, this.ownerId);
    return { settings: await this.step("runtimeSettings", () => write
      ? store.saveSettings(args.packages as string[], args.expectedVersion as number) : store.settings()),
    appliesTo: "next runtime or explicit packages preparation" };
  }
  async prepare(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reserved = await this.step("runtimeSetupReserve", () => new SetupStore(this.env, this.ownerId).queue(
      args.notebookId as string, args.target as SetupKind, args.idempotencyKey as string,
    ));
    return { cached: reserved.cached, setup: setupView(reserved.task), ...await this.document(args.notebookId as string) };
  }
  async advanceSetup(notebook: NotebookRow, allowDispatch = true): Promise<void> {
    if (!notebook.active_setup_id) return;
    const store = new SetupStore(this.env, this.ownerId);
    const task = await this.step("runtimeSetupRead", () => store.task(notebook.active_setup_id!));
    const runtime = await this.step("runtimeSetupRuntime", () => this.store.runtime(task.runtime_id));
    if (task.state === "pending") {
      if (!allowDispatch || !await this.step("runtimeSetupClaim", () => store.claim(task.id))) return;
      let error: Record<string, unknown> | null = null;
      try { await (await this.remote()).submitSetup(runtime, task, this.controller.signal); }
      catch (caught) { error = safeError(caught); }
      await boundedStep("runtimeSetupSubmitted", 2000, undefined,
        () => store.update(task.id, error ? "unknown" : "submitted", null, error));
      return;
    }
    const result = await (await this.remote()).pollSetup(runtime, task, this.controller.signal);
    if (result) await this.step("runtimeSetupResult", () => store.update(task.id, result.status, result));
  }
  async compute(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.step("notebookComputePage", () => this.store.computePage((args.afterNotebookId as string | undefined) ?? ""));
    const total = await this.step("notebookComputeCount", () => this.store.liveCount());
    const safe = { notebooks: page.slice(0, 30).map((row) => computeNotebookView(row, this.now())),
      ownerRuntimeCount: total, hasMore: page.length > 30,
      nextAfterNotebookId: page.length > 30 ? page[29].id : null,
      serverRuntimeCap: null, queueEnabled: false, tpuSupported: false };
    let info: Awaited<ReturnType<RuntimeOps["computeStatus"]>>;
    try { info = await (await this.remote()).computeStatus(this.controller.signal); }
    catch (error) { return { ...safe, error: safeError(error) }; }
    try {
      await this.step("notebookComputeStatusSave", () => new Store(this.env).saveStatus(this.ownerId, { ...info }));
      return { ...safe, ...info };
    } catch (error) { return { ...safe, ...info, storageWarning: safeError(error) }; }
  }
  async save(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    // notebookVersion is accepted for older clients and ignored: content edits compare only the cell version.
    const cell = await this.step("notebookSave", async () => this.store.upsertCell({
      notebookId: args.notebookId as string, cellId: args.cellId as string,
      kind: args.kind as "code" | "markdown", source: args.source as string,
      expectedVersion: args.expectedVersion as number, actor: this.options.actor ?? "assistant",
      index: args.index as number | undefined, structureVersion: args.structureVersion as number | undefined,
    }));
    return { savedCellId: cell.id, ...await this.document(args.notebookId as string, undefined, { view: "full" }) };
  }
  async moveCell(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.step("notebookMoveCell", () => this.store.moveCell({
      notebookId: args.notebookId as string, cellId: args.cellId as string,
      toIndex: args.toIndex as number, structureVersion: args.structureVersion as number,
    }));
    return { movedCellId: args.cellId, ...await this.document(args.notebookId as string, undefined, { view: "full" }) };
  }
  async deleteCell(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.step("notebookDeleteCell", () => this.store.deleteCell({
      notebookId: args.notebookId as string, cellId: args.cellId as string,
      structureVersion: args.structureVersion as number,
    }));
    return { deletedCellId: args.cellId, ...await this.document(args.notebookId as string, undefined, { view: "full" }) };
  }
  async rename(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.step("notebookRename", () => this.store.renameNotebook(args.notebookId as string, args.title as string));
    return this.document(args.notebookId as string);
  }
  async deleteNotebook(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.notebookId as string;
    const notebook = await this.step("notebookRead", () => this.store.notebook(id));
    const summary = await this.step("notebookArtifactSummary", () => this.store.artifactSummary(id));
    if (args.dryRun === true || notebook.state !== "deleting") {
      if (args.dryRun === true || args.confirmArtifactCount !== summary.artifactCount) {
        const cells = await this.step("notebookCells", () => this.store.cells(id));
        const runCount = await this.step("notebookRunCount", () => this.store.runCount(id));
        return { deleted: false, requiresConfirmation: true, notebookId: id, title: notebook.title,
          state: notebook.state, cellCount: cells.length, runCount, ...summary };
      }
      if (!await this.step("notebookBeginDelete", () => this.store.beginDelete(id))) {
        throw new SpikeError("notebook_runtime_open", "delete", 409);
      }
    }
    // A notebook already marked deleting resumes here after an interrupted attempt.
    const keys = await this.step("notebookArtifactKeys", () => this.store.artifactKeys(id));
    if (keys.length && !this.env.BUCKET) throw new SpikeError("artifact_bucket_missing", "delete");
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const chunk = keys.slice(offset, offset + 1000);
      await this.step("notebookDeleteObjects", async () => { await this.env.BUCKET!.delete(chunk); }, 5000);
    }
    await this.step("notebookPurge", () => this.store.purgeNotebook(id));
    return { deleted: true, notebookId: id, title: notebook.title, ...summary };
  }
  async run(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reserved = await this.step("notebookReserveRun", async () => this.store.reserveRun({
      notebookId: args.notebookId as string, cellId: args.cellId as string,
      cellVersion: args.cellVersion as number, idempotencyKey: args.idempotencyKey as string,
      actor: this.options.actor ?? "assistant",
    }));
    const run = reserved.run;
    if (reserved.cached) return { cached: true, run: runView(run), notebookId: run.notebook_id,
      ...(run.error_json ? { error: JSON.parse(run.error_json) } : {}) };
    let state: "submitted" | "unknown" | "error" = "unknown";
    let error: Record<string, unknown> | null = null;
    try {
      // A narrow policy check, not a sandbox for arbitrary Python.
      if (/\b(?:xmrig|minerd|ngrok|cloudflared|torrent)\b|stratum\+tcp/iu.test(run.source)) {
        state = "error"; throw new SpikeError("obvious_disallowed_code_pattern", "run", 400);
      }
      const runtime = await this.step("notebookRuntime", async () => this.store.runtime(run.runtime_id));
      const bridge = await this.remote();
      requireActive(this.controller.signal, "notebookSubmit");
      await bridge.submit(runtime, run.id, run.source, this.controller.signal);
      state = "submitted";
    } catch (caught) { error = safeError(caught); }
    try {
      // Independent finalization records unknown even when the request deadline expired.
      await boundedStep("notebookSubmissionResult", 2000, undefined,
        async () => this.store.updateRun(run.id, state, null, error));
      const recorded = await boundedStep("notebookSubmissionReadback", 2000, undefined,
        async () => this.store.run(run.id));
      return { cached: false, notebookId: run.notebook_id, run: runView(recorded),
        ...(error ? { error } : {}) };
    } catch { return { cached: false, notebookId: run.notebook_id, runId: run.id,
      state: "unknown", error: { code: "submission_result_unconfirmed", stage: "storage" } }; }
  }
  async interrupt(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const notebook = await this.step("notebookRead", async () => this.store.notebook(args.notebookId as string));
    if (!notebook.active_run_id || !notebook.runtime_id) return { interruptRequested: false, ...await this.document(notebook.id) };
    const run = await this.step("notebookActiveRun", async () => this.store.run(notebook.active_run_id!));
    if (run.state === "dispatching") throw new SpikeError("run_submission_in_progress", "interrupt", 409);
    const control = await this.step("notebookInterruptControl", async () => this.store.beginInterrupt(notebook.id, run.id));
    await this.step("notebookInterruptRecord", async () => this.store.markInterrupt(run.id));
    const runtime = await this.step("notebookRuntime", async () => this.store.runtime(notebook.runtime_id!));
    const bridge = await this.remote();
    await bridge.interrupt(runtime, this.controller.signal);
    await this.step("notebookInterruptAck", async () => this.store.finishInterrupt(notebook.id, control));
    return { interruptRequested: true, ...await this.document(notebook.id) };
  }
  async close(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const before = await this.step("notebookCloseInput", () => this.store.notebook(args.notebookId as string));
    if (before.state === "opening" && await this.step("notebookCancelStaleOpen", (signal) => this.store.cancelStaleOpen(before, this.now(), signal))) {
      return { released: true, reservationCancelled: true, allocationNotStarted: true,
        releaseRequired: false, ...await this.document(before.id) };
    }
    if (before.active_setup_id) {
      const setups = new SetupStore(this.env, this.ownerId);
      const task = await this.step("runtimeCloseSetup", () => setups.task(before.active_setup_id!));
      if (task.state === "pending") await this.step("runtimeCancelPendingSetup", () => setups.discard(before.id, true));
      else { try { await this.advanceSetup(before, false); } catch { /* Retain unknown setup unless explicitly discarded. */ } }
      const current = await this.step("runtimeCloseSetupReadback", () => this.store.notebook(before.id));
      if (current.active_setup_id) {
        if (args.discardOutputs !== true) throw new SpikeError("runtime_setup_in_progress_or_unknown", "close", 409);
        await this.step("runtimeDiscardSetup", () => setups.discard(before.id));
      }
    }
    if (before.active_input_id) {
      try { await this.pollInput(before); } catch { /* Preserve unknown import unless explicitly discarded. */ }
      const current = await this.step("notebookCloseInputReadback", () => this.store.notebook(before.id));
      if (current.active_input_id) {
        if (args.discardOutputs !== true) throw new SpikeError("input_import_in_progress_or_unknown", "close", 409);
        await this.step("notebookDiscardInput", () => this.store.discardInput(before.id));
      }
    }
    const notebook = await this.step("notebookBeginClose", async () => this.store.beginClose(args.notebookId as string));
    if (notebook.state === "closed" || !notebook.runtime_id) return { released: true, cached: true, ...await this.document(notebook.id) };
    const runtime = await this.step("notebookRuntime", async () => this.store.runtime(notebook.runtime_id!));
    if (!runtime.endpoint) throw new SpikeError("runtime_endpoint_unknown_manual_recovery_required", "close", 409);
    const bridge = await this.remote();
    let outputsPersisted = true;
    let outputError: Record<string, unknown> | undefined;
    try {
      if (notebook.active_run_id) {
        const run = await this.step("notebookActiveRun", async () => this.store.run(notebook.active_run_id!));
        if (!TERMINAL_RUNS.has(run.state)) {
          let result = await this.poll(notebook);
          if (!result || result.status === "running") {
            await this.step("notebookInterruptRecord", async () => this.store.markInterrupt(run.id));
            await bridge.interrupt(runtime, this.controller.signal);
            result = await this.poll(notebook);
          }
          if (!result || result.status === "running") throw new SpikeError("terminal_output_not_available", "close", 409);
        }
        const recorded = await this.step("notebookArtifactRun", async () => this.store.run(run.id));
        if (!["saved", "legacy", "discarded"].includes(recorded.artifacts_state)) {
          await this.poll(notebook);
          const saved = await this.step("notebookArtifactReadback", async () => this.store.run(run.id));
          if (!["saved", "legacy", "discarded"].includes(saved.artifacts_state)) throw new SpikeError("artifacts_not_persisted", "close", 409);
        }
      }
    } catch (error) { outputsPersisted = false; outputError = safeError(error); }
    if (!outputsPersisted && args.discardOutputs !== true) {
      return { released: false, outputsPersisted: false, notebookId: notebook.id,
        error: { code: "outputs_not_persisted", stage: "close" }, outputError,
        recoveryEndpoint: runtime.endpoint, retryCloseAllowed: true };
    }
    if (!outputsPersisted && notebook.active_run_id) {
      try { await boundedStep("notebookDiscardResult", 2000, undefined, async () => this.store.updateRun(
        notebook.active_run_id!, "incomplete", null, { code: "outputs_explicitly_discarded", stage: "close" },
      )); } catch { /* Explicit discard permits release even when storage is unavailable. */ }
      try { await boundedStep("notebookDiscardArtifacts", 2000, undefined, async () => this.store.discardArtifacts(
        notebook.active_run_id!, notebook.id, { code: "artifacts_explicitly_discarded", stage: "close" },
      )); }
      catch { /* Explicit discard accepts unsaved artifact loss. */ }
    }
    const cleanup = await bridge.release(runtime);
    let ledgerError: Record<string, unknown> | undefined;
    try { await boundedStep("notebookCloseResult", 2000, undefined, async () => this.store.finishRuntime(
      runtime.id, cleanup.released, cleanup.released ? null : { code: "release_unconfirmed", stage: "close" },
    )); } catch { ledgerError = { code: "close_result_unconfirmed", stage: "storage" }; }
    return { notebookId: notebook.id, outputsPersisted, ...cleanup,
      ...(outputError ? { outputError } : {}), ...(ledgerError ? { ledgerError } : {}),
      ...(!cleanup.released ? { recoveryEndpoint: runtime.endpoint } : {}) };
  }
  async export(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.notebookId as string;
    await this.step("notebookExportActivity", () => this.store.touch(id, this.now()));
    const notebook = await this.step("notebookRead", async () => this.store.notebook(id));
    const cells = await this.step("notebookCells", async () => this.store.cells(id));
    const runs = await this.step("notebookRuns", async () => this.store.runs(id, MAX_EXPORT_OUTPUT_BYTES));
    let remainingOutput = MAX_EXPORT_OUTPUT_BYTES;
    const exported = cells.map((cell) => {
      const run = runs.find((row) => row.cell_id === cell.id && row.cell_version === cell.version);
      const result: RunResult | null = run?.result_json ? JSON.parse(run.result_json) : null;
      const sameSource = run?.source === cell.source;
      const size = new TextEncoder().encode(JSON.stringify(result?.outputs ?? [])).byteLength;
      const include = result && sameSource && size <= remainingOutput;
      if (include) remainingOutput -= size;
      return { id: cell.id, cell_type: cell.kind, source: cell.source, metadata: {
        colab_site: { cellVersion: cell.version, ...(run ? { runId: run.id, runState: run.state } : {}),
          ...(run?.result_omitted || result && (!sameSource || !include) ? { outputsOmitted: true } : {}) },
      }, ...(cell.kind === "code" ? { execution_count: include ? result.executionCount : null,
        outputs: include ? result.outputs : [] } : {}) };
    });
    return { filename: `${notebook.title.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 80) || "notebook"}.ipynb`,
      ipynb: { nbformat: 4, nbformat_minor: 5,
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python" }, colab_site: { notebookId: id, exportedAt: new Date().toISOString() } },
        cells: exported } };
  }
  async artifacts(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = args.notebookId as string;
    let artifactError: Record<string, unknown> | undefined;
    const notebook = await this.step("notebookRead", async () => this.store.notebook(id));
    if (notebook.active_run_id) {
      try { await this.poll(notebook); } catch (error) { artifactError = safeError(error); }
    }
    const store = new ArtifactStore(this.env, this.ownerId);
    let rows = await this.step("artifactList", () => store.list(id, args.runId as string | undefined, args.beforeId as string | undefined));
    const hasMore = rows.length === 64;
    const nextBeforeId = hasMore ? rows.at(-1)!.id : null;
    if (args.path) rows = rows.filter((row) => row.path === artifactPath(args.path));
    if (args.artifactId) rows = [await this.step("artifactRead", () => store.artifact(args.artifactId as string))]
      .filter((row) => row.notebook_id === id);
    const views: Record<string, unknown>[] = [];
    for (const row of rows) {
      const view = artifactView(row);
      if (args.artifactId && row.state === "ready") {
        const download = await this.step("artifactDownloadLink", () => store.downloadToken(row.id, this.now()));
        await this.step("artifactDownloadActivity", () => this.store.touch(id, this.now()));
        view.downloadUrl = `${SITE_ORIGIN}/api/artifacts/${row.id}?token=${encodeURIComponent(download.token)}`;
        view.downloadExpiresAt = download.expiresAt;
        view.previewDataUrl = await previewArtifact(this.env, row, this.controller.signal);
      }
      views.push(view);
    }
    return { notebookId: id, artifacts: views, hasMore, nextBeforeId, ...(artifactError ? { artifactError } : {}) };
  }
  async pin(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const row = await this.step("artifactPin", () => new ArtifactStore(this.env, this.ownerId)
      .pin(args.artifactId as string, args.permanent as boolean, this.now()));
    return { artifact: artifactView(row) };
  }
  async maintenance(): Promise<Record<string, unknown>> {
    return runMaintenance(this);
  }
}

export async function notebookCall(name: string, args: Record<string, unknown>, env: SpikeEnv,
  identity: Identity, options: ServiceOptions = {}): Promise<Record<string, unknown>> {
  const service = new NotebookService(env, identity.userId, options);
  try {
    await service.step("notebookOwner", async () => new Store(env).owner(identity));
    switch (name) {
      case "open_notebook": return await service.open(args);
      case "get_compute_status": return await service.compute(args);
      case "import_file": return await service.importFile(args);
      case "get_runtime_settings": return await service.settings(args, false);
      case "set_runtime_settings": return await service.settings(args, true);
      case "prepare_runtime": return await service.prepare(args);
      case "upsert_cell": return await service.save(args);
      case "move_cell": return await service.moveCell(args);
      case "delete_cell": return await service.deleteCell(args);
      case "rename_notebook": return await service.rename(args);
      case "delete_notebook": return await service.deleteNotebook(args);
      case "run_cell": return await service.run(args);
      case "get_notebook": return await service.get(args);
      case "interrupt_cell": return await service.interrupt(args);
      case "close_notebook": return await service.close(args);
      case "export_ipynb": return await service.export(args);
      case "get_artifacts": return await service.artifacts(args);
      case "pin_artifact": return await service.pin(args);
      case "maintain_notebooks": return await service.maintenance();
      default: throw new SpikeError("unknown_notebook_tool", "notebook", 400);
    }
  } finally { service.dispose(); }
}

/** Called only after the private service route resolves the already-enrolled owner. */
export async function maintenanceCall(env: SpikeEnv, ownerId: string, options: ServiceOptions = {}): Promise<Record<string, unknown>> {
  const service = new NotebookService(env, ownerId, options);
  try { return await service.maintenance(); } finally { service.dispose(); }
}

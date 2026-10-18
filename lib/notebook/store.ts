/** D1 compare-and-swap transitions. Every lookup is scoped to the verified owner. */
import type { SpikeEnv } from "../platform/config.ts";
import { SpikeError } from "../platform/security.ts";
import { requireActive } from "../platform/deadline.ts";
import { MAX_CELLS, MAX_NOTEBOOK_SOURCE, MAX_RESULT_BYTES } from "./types.ts";
import type { CellRow, NotebookRow, RunResult, RunRow, RunState, RuntimeRow } from "./types.ts";
import type { ComputeChoice, ObservedCompute } from "./compute.ts";
import { inputName } from "./inputs.ts";
import type { InputFile, InputResult, InputRow } from "./inputs.ts";

export interface MaintenanceScan { after_id: string; lease_token: string }
export type ComputeNotebookRow = Pick<NotebookRow, "id" | "title" | "state" | "runtime_id" | "active_run_id" |
  "last_activity_at" | "last_terminal_at" | "updated_at" | "created_at" | "control_token"> &
  Pick<RuntimeRow, "requested_compute" | "selected_accelerator" | "accelerator" | "machine_kind" | "compute_verified" | "released"> &
  { runtime_state: RuntimeRow["state"]; runtime_created_at: number };

export class NotebookStore {
  readonly db: D1Database;
  constructor(env: SpikeEnv, readonly ownerId: string) {
    if (!env.DB) throw new SpikeError("database_binding_missing", "notebook");
    this.db = env.DB;
  }
  async list(): Promise<NotebookRow[]> {
    return (await this.db.prepare("SELECT * FROM notebooks WHERE owner_id=? ORDER BY updated_at DESC LIMIT 30")
      .bind(this.ownerId).all<NotebookRow>()).results;
  }
  async live(afterId = "", limit = 4): Promise<NotebookRow[]> {
    return (await this.db.prepare("SELECT * FROM notebooks WHERE owner_id=? AND state NOT IN ('closed','deleting') AND runtime_id IS NOT NULL AND id>? ORDER BY id LIMIT ?")
      .bind(this.ownerId, afterId, limit).all<NotebookRow>()).results;
  }
  async liveCount(afterId = ""): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM notebooks WHERE owner_id=? AND state NOT IN ('closed','deleting') AND runtime_id IS NOT NULL AND id>?")
      .bind(this.ownerId, afterId).first<{ count: number }>();
    return row?.count ?? 0;
  }
  async computePage(afterId = ""): Promise<ComputeNotebookRow[]> {
    return (await this.db.prepare(`SELECT n.id,n.title,n.state,n.runtime_id,n.active_run_id,n.control_token,
      n.last_activity_at,n.last_terminal_at,n.updated_at,n.created_at,
      r.requested_compute,r.selected_accelerator,r.accelerator,r.machine_kind,r.compute_verified,r.released,
      r.state AS runtime_state,r.created_at AS runtime_created_at FROM notebooks n
      JOIN notebook_runtimes r ON n.runtime_id=r.id AND r.owner_id=n.owner_id
      WHERE n.owner_id=? AND n.state<>'closed' AND n.id>? ORDER BY n.id LIMIT 31`)
      .bind(this.ownerId, afterId).all<ComputeNotebookRow>()).results;
  }
  async beginScan(): Promise<MaintenanceScan | null> {
    const token = crypto.randomUUID(), now = Date.now();
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO maintenance_scan(owner_id) VALUES(?)").bind(this.ownerId),
      this.db.prepare("UPDATE maintenance_scan SET lease_token=?,lease_expires_at=? WHERE owner_id=? AND lease_expires_at<=?")
        .bind(token, now + 70_000, this.ownerId, now),
    ]);
    return this.db.prepare("SELECT after_id,lease_token FROM maintenance_scan WHERE owner_id=? AND lease_token=?")
      .bind(this.ownerId, token).first<MaintenanceScan>();
  }
  async startMaintenance(id: string, observedAt: number): Promise<void> {
    await this.db.prepare(
      "INSERT INTO maintenance_runs(id,owner_id,started_at) VALUES(?,?,?)",
    ).bind(id, this.ownerId, observedAt).run();
  }
  async discardArtifacts(runId: string, notebookId: string, error: Record<string, unknown>): Promise<void> {
    await this.db.prepare(
      "UPDATE notebook_runs SET artifacts_state='discarded',artifact_error_json=? WHERE id=? AND notebook_id=?",
    ).bind(JSON.stringify(error), runId, notebookId).run();
  }
  async finishScan(scan: MaintenanceScan | null, afterId: string, id: string,
    result: Record<string, unknown>, now: number): Promise<void> {
    const statements = [this.db.prepare("UPDATE maintenance_runs SET finished_at=?,result_json=? WHERE id=? AND owner_id=?")
      .bind(now, JSON.stringify(result), id, this.ownerId)];
    if (scan) statements.push(this.db.prepare(
      "UPDATE maintenance_scan SET after_id=?,lease_token=NULL,lease_expires_at=0 WHERE owner_id=? AND lease_token=?",
    ).bind(afterId, this.ownerId, scan.lease_token));
    await this.db.batch(statements);
  }
  async touch(id: string, now: number): Promise<void> {
    await this.db.prepare("UPDATE notebooks SET last_activity_at=MAX(last_activity_at,?) WHERE id=? AND owner_id=? AND state<>'closing'")
      .bind(now, id, this.ownerId).run();
  }
  async latestMaintenance(): Promise<Record<string, unknown> | null> {
    const row = await this.db.prepare("SELECT id,started_at,finished_at,result_json FROM maintenance_runs WHERE owner_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1")
      .bind(this.ownerId).first<{ id: string; started_at: number; finished_at: number | null; result_json: string | null }>();
    return row ? { id: row.id, startedAt: row.started_at, finishedAt: row.finished_at,
      result: row.result_json ? JSON.parse(row.result_json) : null } : null;
  }
  async notebook(id: string): Promise<NotebookRow> {
    const row = await this.db.prepare("SELECT * FROM notebooks WHERE id=? AND owner_id=?")
      .bind(id, this.ownerId).first<NotebookRow>();
    if (!row) throw new SpikeError("notebook_not_found", "notebook", 404);
    return row;
  }
  async cells(id: string): Promise<CellRow[]> {
    await this.notebook(id);
    return (await this.db.prepare("SELECT * FROM notebook_cells WHERE notebook_id=? ORDER BY position,id LIMIT ?")
      .bind(id, MAX_CELLS).all<CellRow>()).results;
  }
  async runtime(id: string): Promise<RuntimeRow> {
    const row = await this.db.prepare("SELECT * FROM notebook_runtimes WHERE id=? AND owner_id=?")
      .bind(id, this.ownerId).first<RuntimeRow>();
    if (!row) throw new SpikeError("runtime_not_found", "notebook", 404);
    return row;
  }
  async openByKey(key: string): Promise<RuntimeRow | null> {
    return this.db.prepare("SELECT * FROM notebook_runtimes WHERE owner_id=? AND request_key=?")
      .bind(this.ownerId, key).first<RuntimeRow>();
  }
  async reserveOpen(id: string, title: string, key: string, compute = "CPU", signal?: AbortSignal): Promise<{ runtime: RuntimeRow; cached: boolean }> {
    const checkRetry = (row: RuntimeRow) => {
      if (row.notebook_id !== id || row.requested_compute !== compute) {
        throw new SpikeError("idempotency_key_conflict", "open", 409);
      }
      return { runtime: row, cached: true };
    };
    requireActive(signal, "notebookReserveOpen");
    const previous = await this.openByKey(key);
    requireActive(signal, "notebookReserveOpen");
    if (previous) return checkRetry(previous);
    const runtimeId = crypto.randomUUID();
    const hash = crypto.randomUUID();
    const now = Date.now();
    try {
      requireActive(signal, "notebookReserveOpen");
      await this.db.batch([
        this.db.prepare("INSERT OR IGNORE INTO notebooks(id,owner_id,title,version,state,created_at,updated_at) VALUES(?,?,?,1,'closed',?,?)")
          .bind(id, this.ownerId, title, now, now),
        this.db.prepare(`INSERT INTO notebook_runtimes(id,notebook_id,owner_id,request_key,state,notebook_hash,released,created_at,updated_at,requested_compute,machine_kind,accelerator)
          SELECT ?,id,?,?, 'opening',?,0,?,?,?,?, 'UNKNOWN' FROM notebooks
          WHERE id=? AND owner_id=? AND state='closed'
          AND NOT EXISTS(SELECT 1 FROM operation_lock)`)
          .bind(runtimeId, this.ownerId, key, hash, now, now, compute, compute === "CPU" ? "CPU" : "GPU", id, this.ownerId),
        this.db.prepare("UPDATE notebooks SET state='opening',runtime_id=?,updated_at=?,last_activity_at=? WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=?)")
          .bind(runtimeId, now, now, id, this.ownerId, runtimeId),
      ]);
    } catch {
      requireActive(signal, "notebookReserveOpen");
      const repeated = await this.openByKey(key);
      requireActive(signal, "notebookReserveOpen");
      if (repeated) return checkRetry(repeated);
      throw new SpikeError("runtime_slot_unavailable", "open", 409);
    }
    requireActive(signal, "notebookReserveOpen");
    const attempt = await this.openByKey(key);
    requireActive(signal, "notebookReserveOpen");
    if (!attempt) throw new SpikeError("runtime_slot_unavailable", "open", 409);
    if (attempt.id !== runtimeId) return checkRetry(attempt);
    return { runtime: attempt, cached: attempt.id !== runtimeId };
  }
  async selectRuntimeCompute(id: string, choice: ComputeChoice, signal?: AbortSignal): Promise<void> {
    requireActive(signal, "notebookSelectCompute");
    const result = await this.db.prepare(`UPDATE notebook_runtimes SET selected_accelerator=?,machine_kind=?,updated_at=?
      WHERE id=? AND owner_id=? AND state='opening' AND released=0 AND selected_accelerator IS NULL
      AND EXISTS(SELECT 1 FROM notebooks WHERE runtime_id=notebook_runtimes.id AND owner_id=? AND state='opening')`)
      .bind(choice.accelerator, choice.kind, Date.now(), id, this.ownerId, this.ownerId).run();
    requireActive(signal, "notebookSelectCompute");
    if (result.meta.changes !== 1) throw new SpikeError("runtime_reservation_not_active", "open", 409);
  }
  async cancelStaleOpen(notebook: NotebookRow, now: number, signal?: AbortSignal): Promise<boolean> {
    const token = crypto.randomUUID();
    requireActive(signal, "notebookCancelStaleOpen");
    const [claim] = await this.db.batch([
      this.db.prepare(`UPDATE notebooks SET state='closed',mutation_id=?,updated_at=?
        WHERE id=? AND owner_id=? AND runtime_id=? AND state='opening'
        AND active_run_id IS NULL AND active_input_id IS NULL AND active_setup_id IS NULL AND control_token IS NULL
        AND EXISTS(SELECT 1 FROM notebook_runtimes r WHERE r.id=notebooks.runtime_id AND r.owner_id=?
          AND r.notebook_id=notebooks.id AND r.state='opening' AND r.released=0 AND r.created_at<?
          AND r.selected_accelerator IS NULL AND r.endpoint IS NULL AND r.kernel_id IS NULL AND r.compute_verified=0)`)
        .bind(token, now, notebook.id, this.ownerId, notebook.runtime_id, this.ownerId, now - 45_000),
      this.db.prepare(`UPDATE notebook_runtimes SET state='closed',released=1,error_json=?,updated_at=?
        WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM notebooks WHERE id=? AND owner_id=?
          AND runtime_id=notebook_runtimes.id AND mutation_id=? AND state='closed')`)
        .bind(JSON.stringify({ code: "allocation_not_started_reservation_cancelled", stage: "close" }), now,
          notebook.runtime_id, this.ownerId, notebook.id, this.ownerId, token),
    ]);
    return claim.meta.changes === 1;
  }
  async observedRuntimeCompute(id: string, actual: ObservedCompute): Promise<void> {
    await this.db.prepare("UPDATE notebook_runtimes SET accelerator=?,compute_verified=1,updated_at=? WHERE id=? AND owner_id=? AND state='opening' AND released=0 AND selected_accelerator=? AND machine_kind=?")
      .bind(actual.accelerator, Date.now(), id, this.ownerId, actual.accelerator, actual.kind).run();
  }
  async endpoint(runtimeId: string, value: string): Promise<void> {
    await this.db.prepare("UPDATE notebook_runtimes SET endpoint=?,updated_at=? WHERE id=? AND owner_id=?")
      .bind(value, Date.now(), runtimeId, this.ownerId).run();
  }
  async opened(runtimeId: string, kernelId: string, packages?: string[]): Promise<void> {
    const now = Date.now(), taskId = crypto.randomUUID();
    const bootstrap = packages === undefined ? [] : [
      this.db.prepare(`INSERT INTO runtime_tasks(id,notebook_id,runtime_id,request_key,kind,config_json,state,created_at)
        SELECT ?,notebook_id,id,?,'packages',?,'pending',? FROM notebook_runtimes WHERE id=? AND owner_id=? AND state='open'`)
        .bind(taskId, `bootstrap-${runtimeId}`, JSON.stringify(packages), now, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebooks SET state='preparing',active_setup_id=? WHERE runtime_id=? AND owner_id=? AND state='open'
        AND EXISTS(SELECT 1 FROM runtime_tasks WHERE id=?)`).bind(taskId, runtimeId, this.ownerId, taskId),
    ];
    await this.db.batch([
      this.db.prepare("UPDATE notebook_runtimes SET state='open',kernel_id=?,updated_at=? WHERE id=? AND owner_id=? AND state='opening' AND compute_verified=1")
        .bind(kernelId, now, runtimeId, this.ownerId),
      this.db.prepare("UPDATE notebooks SET state='open',updated_at=?,last_activity_at=? WHERE runtime_id=? AND owner_id=? AND state='opening' AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND state='open')")
        .bind(now, now, runtimeId, this.ownerId, runtimeId),
      ...bootstrap,
    ]);
  }
  async finishRuntime(runtimeId: string, released: boolean, error: Record<string, unknown> | null): Promise<void> {
    const now = Date.now();
    await this.db.batch([
      this.db.prepare("UPDATE notebook_runtimes SET state=?,released=?,error_json=?,updated_at=? WHERE id=? AND owner_id=? AND released=0")
        .bind(released ? "closed" : "unknown", released ? 1 : 0,
          error ? JSON.stringify(error) : null, now, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebooks SET state=(SELECT CASE WHEN released=1 THEN 'closed' ELSE 'unknown' END
        FROM notebook_runtimes WHERE id=?),updated_at=? WHERE runtime_id=? AND owner_id=?`)
        .bind(runtimeId, now, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebook_runs SET state='incomplete',error_json=?,updated_at=?
        WHERE runtime_id=? AND state NOT IN ('ok','error','interrupted','incomplete')
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND released=1 AND owner_id=?)`)
        .bind(JSON.stringify({ code: "runtime_closed_without_terminal_result", stage: "close" }), now,
          runtimeId, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebooks SET active_run_id=NULL,control_token=NULL WHERE runtime_id=? AND owner_id=?
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND released=1)`)
        .bind(runtimeId, this.ownerId, runtimeId),
      this.db.prepare(`UPDATE notebook_inputs SET state='incomplete',error_json=?,finished_at=?
        WHERE runtime_id=? AND state NOT IN ('ready','error','incomplete')
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND owner_id=? AND released=1)`)
        .bind(JSON.stringify({ code: "runtime_closed_before_input_saved", stage: "inputs" }), now, runtimeId, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebooks SET active_input_id=NULL WHERE runtime_id=? AND owner_id=?
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND released=1)`)
        .bind(runtimeId, this.ownerId, runtimeId),
      this.db.prepare(`UPDATE runtime_tasks SET state='incomplete',error_json=?,finished_at=? WHERE runtime_id=? AND state NOT IN ('ready','error','incomplete')
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND owner_id=? AND released=1)`)
        .bind(JSON.stringify({ code: "runtime_closed_before_setup_saved", stage: "setup" }), now, runtimeId, runtimeId, this.ownerId),
      this.db.prepare(`UPDATE notebooks SET active_setup_id=NULL WHERE runtime_id=? AND owner_id=?
        AND EXISTS(SELECT 1 FROM notebook_runtimes WHERE id=? AND released=1)`).bind(runtimeId, this.ownerId, runtimeId),
    ]);
  }
  async inputs(id: string): Promise<InputRow[]> {
    await this.notebook(id);
    return (await this.db.prepare("SELECT * FROM notebook_inputs WHERE notebook_id=? ORDER BY created_at DESC,id DESC LIMIT 33")
      .bind(id).all<InputRow>()).results;
  }
  async input(id: string): Promise<InputRow> {
    const row = await this.db.prepare(`SELECT i.* FROM notebook_inputs i JOIN notebooks n ON n.id=i.notebook_id
      WHERE i.id=? AND n.owner_id=?`).bind(id, this.ownerId).first<InputRow>();
    if (!row) throw new SpikeError("input_not_found", "inputs", 404);
    return row;
  }
  async reserveInput(id: string, file: InputFile, key: string): Promise<{ input: InputRow; cached: boolean }> {
    const prior = () => this.db.prepare(`SELECT i.* FROM notebook_inputs i JOIN notebooks n ON n.id=i.notebook_id
      WHERE n.owner_id=? AND n.id=? AND i.request_key=?`).bind(this.ownerId, id, key).first<InputRow>();
    const checked = (input: InputRow) => {
      if (input.file_id !== file.file_id || input.file_name !== inputName(file.file_name) || input.mime_type !== (file.mime_type ?? null)) {
        throw new SpikeError("idempotency_key_conflict", "inputs", 409);
      }
      return { input, cached: true };
    };
    const previous = await prior(); if (previous) return checked(previous);
    const inputId = crypto.randomUUID(), now = Date.now();
    try { await this.db.batch([
      this.db.prepare(`UPDATE notebooks SET state='importing',active_input_id=?,last_activity_at=?,updated_at=?
        WHERE id=? AND owner_id=? AND state='open' AND active_run_id IS NULL AND control_token IS NULL AND active_input_id IS NULL`)
        .bind(inputId, now, now, id, this.ownerId),
      this.db.prepare(`INSERT INTO notebook_inputs(id,notebook_id,runtime_id,request_key,file_id,file_name,mime_type,state,created_at)
        SELECT ?,id,runtime_id,?,?,?,?,'dispatching',? FROM notebooks WHERE id=? AND owner_id=? AND active_input_id=?`)
        .bind(inputId, key, file.file_id, inputName(file.file_name), file.mime_type ?? null, now, id, this.ownerId, inputId),
    ]); } catch {
      const repeated = await prior(); if (repeated) return checked(repeated);
      throw new SpikeError("input_reservation_conflict", "inputs", 409);
    }
    const input = await prior();
    if (!input) throw new SpikeError("notebook_busy_or_closed", "inputs", 409);
    return input.id === inputId ? { input, cached: false } : checked(input);
  }
  async updateInput(id: string, state: string, result: InputResult | null, error: Record<string, unknown> | null = null): Promise<void> {
    const input = await this.input(id);
    const terminal = result && result.status !== "running";
    await this.db.batch([
      this.db.prepare(`UPDATE notebook_inputs SET state=CASE WHEN state='running' AND ? IN ('submitted','unknown') THEN state ELSE ? END,
        size=COALESCE(?,size),sha256=COALESCE(?,sha256),error_json=?,finished_at=COALESCE(?,finished_at)
        WHERE id=? AND state NOT IN ('ready','error','incomplete')`)
        .bind(state, state, result?.size ?? null, result?.sha256 ?? null,
          error ? JSON.stringify(error) : result?.error ? JSON.stringify({ ...result.error, stage: "inputs" }) : null,
          terminal ? result.finishedAt : null, id),
      this.db.prepare(`UPDATE notebooks SET state='open',active_input_id=NULL,last_activity_at=MAX(last_activity_at,?)
        WHERE id=? AND owner_id=? AND state='importing' AND runtime_id=? AND active_input_id=?
        AND EXISTS(SELECT 1 FROM notebook_inputs WHERE id=? AND state IN ('ready','error'))`)
        .bind(terminal ? result.finishedAt : 0, input.notebook_id, this.ownerId, input.runtime_id, id, id),
    ]);
  }
  async discardInput(id: string): Promise<void> {
    await this.notebook(id);
    await this.db.batch([
      this.db.prepare(`UPDATE notebook_inputs SET state='incomplete',error_json=?,finished_at=?
        WHERE id=(SELECT active_input_id FROM notebooks WHERE id=? AND owner_id=? AND state='importing')`)
        .bind(JSON.stringify({ code: "input_explicitly_discarded", stage: "close" }), Date.now(), id, this.ownerId),
      this.db.prepare("UPDATE notebooks SET state='closing',active_input_id=NULL WHERE id=? AND owner_id=? AND state='importing'")
        .bind(id, this.ownerId),
    ]);
  }
  /** Rows changed by statement `index` of a D1 batch (each batch is one transaction). */
  private changed(results: unknown[], index: number): boolean {
    return Number((results[index] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) > 0;
  }
  // Cell content and structure changes never write notebooks.mutation_id: close and idle-release
  // flows read it back to confirm their own claims, and concurrent cell edits must not disturb them.
  async upsertCell(input: {
    notebookId: string; cellId: string; kind: "code" | "markdown"; source: string;
    expectedVersion: number; actor: "user" | "assistant";
    index?: number; structureVersion?: number;
  }): Promise<CellRow> {
    const now = Date.now();
    const { notebookId: id, cellId, kind, source, expectedVersion, actor } = input;
    const editable = `EXISTS(SELECT 1 FROM notebooks WHERE id=? AND owner_id=? AND state NOT IN ('opening','closing','deleting'))`;
    const sourceLimit = `(SELECT COALESCE(SUM(length(source)),0) FROM notebook_cells WHERE notebook_id=? AND id<>?)+?<=?`;
    const positioned = input.index !== undefined;
    let saved: boolean;
    if (expectedVersion > 0) {
      // Content edit: only this cell's version is compared (other cells may change concurrently).
      const results = await this.db.batch([
        this.db.prepare(`UPDATE notebook_cells SET kind=?,source=?,version=version+1,updated_at=?,updated_by=?
          WHERE id=? AND notebook_id=? AND version=? AND ${editable} AND ${sourceLimit}`)
          .bind(kind, source, now, actor, cellId, id, expectedVersion, id, this.ownerId, id, cellId, source.length, MAX_NOTEBOOK_SOURCE),
        this.db.prepare(`UPDATE notebooks SET version=version+1,updated_at=?,last_activity_at=?
          WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=? AND updated_at=? AND version=?)`)
          .bind(now, now, id, this.ownerId, cellId, id, now, expectedVersion + 1),
      ]);
      saved = this.changed(results, 0);
    } else {
      // New cell: append freely, or insert at index only while the structure is unchanged.
      if (positioned && input.structureVersion === undefined) {
        throw new SpikeError("structure_version_required", "save", 400);
      }
      const checks = `EXISTS(SELECT 1 FROM notebooks WHERE id=? AND owner_id=? AND state NOT IN ('opening','closing','deleting')
          AND (?=0 OR structure_version=?))
        AND NOT EXISTS(SELECT 1 FROM notebook_cells WHERE id=?)
        AND (SELECT COUNT(*) FROM notebook_cells WHERE notebook_id=?)<?
        AND (?=0 OR ?<=(SELECT COUNT(*) FROM notebook_cells WHERE notebook_id=?))
        AND ${sourceLimit}`;
      const checkBinds = [id, this.ownerId, positioned ? 1 : 0, input.structureVersion ?? 0, cellId, id, MAX_CELLS,
        positioned ? 1 : 0, input.index ?? 0, id, id, cellId, source.length, MAX_NOTEBOOK_SOURCE];
      const results = await this.db.batch([
        this.db.prepare(`UPDATE notebook_cells SET position=position+1
          WHERE notebook_id=? AND ?=1 AND position>=? AND ${checks}`)
          .bind(id, positioned ? 1 : 0, input.index ?? 0, ...checkBinds),
        this.db.prepare(`INSERT INTO notebook_cells(id,notebook_id,kind,source,version,position,updated_at,updated_by)
          SELECT ?,?,?,?,1,CASE WHEN ?=1 THEN ? ELSE (SELECT COUNT(*) FROM notebook_cells WHERE notebook_id=?) END,?,?
          WHERE ${checks}`)
          .bind(cellId, id, kind, source, positioned ? 1 : 0, input.index ?? 0, id, now, actor, ...checkBinds),
        this.db.prepare(`UPDATE notebooks SET version=version+1,structure_version=structure_version+1,
          updated_at=?,last_activity_at=?
          WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=? AND version=1 AND updated_at=?)`)
          .bind(now, now, id, this.ownerId, cellId, id, now),
      ]);
      saved = this.changed(results, 1);
    }
    if (!saved) {
      const notebook = await this.notebook(id);
      if (positioned && notebook.structure_version !== input.structureVersion) {
        throw new SpikeError("structure_version_conflict", "save", 409);
      }
      throw new SpikeError("version_conflict_or_document_limit", "save", 409);
    }
    return (await this.cells(id)).find((row) => row.id === cellId)!;
  }
  /** Structure CAS evaluated inside every statement of a structural batch. */
  private structureMatches(id: string, structureVersion: number): [string, unknown[]] {
    return [`EXISTS(SELECT 1 FROM notebooks WHERE id=? AND owner_id=? AND structure_version=?
      AND state NOT IN ('opening','closing','deleting'))`, [id, this.ownerId, structureVersion]];
  }
  private bumpStructure(id: string, structureVersion: number, now: number, condition: string, binds: unknown[]) {
    return this.db.prepare(`UPDATE notebooks SET version=version+1,structure_version=structure_version+1,
      updated_at=?,last_activity_at=?
      WHERE id=? AND owner_id=? AND structure_version=? AND state NOT IN ('opening','closing','deleting') AND ${condition}`)
      .bind(now, now, id, this.ownerId, structureVersion, ...binds);
  }
  private async structureFailure(id: string, structureVersion: number, cellId: string): Promise<never> {
    const notebook = await this.notebook(id);
    if (notebook.structure_version !== structureVersion) throw new SpikeError("structure_version_conflict", "structure", 409);
    if (["opening", "closing", "deleting"].includes(notebook.state)) throw new SpikeError("notebook_busy", "structure", 409);
    const cell = await this.db.prepare("SELECT id FROM notebook_cells WHERE id=? AND notebook_id=?").bind(cellId, id).first();
    if (!cell) throw new SpikeError("cell_not_found", "structure", 404);
    throw new SpikeError("cell_running", "structure", 409);
  }
  async moveCell(input: { notebookId: string; cellId: string; toIndex: number; structureVersion: number }): Promise<void> {
    const { notebookId: id, cellId, toIndex, structureVersion } = input;
    const cells = await this.cells(id);
    const from = cells.findIndex((row) => row.id === cellId);
    if (from < 0) throw new SpikeError("cell_not_found", "structure", 404);
    if (toIndex >= cells.length) throw new SpikeError("cell_index_out_of_range", "structure", 400);
    if (toIndex === from) return;
    const now = Date.now();
    const fromPosition = cells[from].position, toPosition = cells[toIndex].position;
    const [matches, matchBinds] = this.structureMatches(id, structureVersion);
    // The moved cell must still sit where this request read it.
    const inPlace = "EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=? AND position=?)";
    const shift = toPosition > fromPosition
      ? this.db.prepare(`UPDATE notebook_cells SET position=position-1
          WHERE notebook_id=? AND position>? AND position<=? AND ${matches} AND ${inPlace}`)
        .bind(id, fromPosition, toPosition, ...matchBinds, cellId, id, fromPosition)
      : this.db.prepare(`UPDATE notebook_cells SET position=position+1
          WHERE notebook_id=? AND position>=? AND position<? AND ${matches} AND ${inPlace}`)
        .bind(id, toPosition, fromPosition, ...matchBinds, cellId, id, fromPosition);
    const results = await this.db.batch([
      shift,
      this.db.prepare(`UPDATE notebook_cells SET position=? WHERE id=? AND notebook_id=? AND position=? AND ${matches}`)
        .bind(toPosition, cellId, id, fromPosition, ...matchBinds),
      this.bumpStructure(id, structureVersion, now, "EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=? AND position=?)",
        [cellId, id, toPosition]),
    ]);
    if (!this.changed(results, 1)) await this.structureFailure(id, structureVersion, cellId);
  }
  async deleteCell(input: { notebookId: string; cellId: string; structureVersion: number }): Promise<void> {
    const { notebookId: id, cellId, structureVersion } = input;
    const now = Date.now();
    const [matches, matchBinds] = this.structureMatches(id, structureVersion);
    // Runs and artifacts of the deleted cell are kept; only an active run blocks deletion.
    const idle = `NOT EXISTS(SELECT 1 FROM notebooks n JOIN notebook_runs r ON r.id=n.active_run_id
      WHERE n.id=? AND r.cell_id=?)`;
    const results = await this.db.batch([
      this.db.prepare(`UPDATE notebook_cells SET position=position-1 WHERE notebook_id=?
        AND position>(SELECT position FROM notebook_cells WHERE id=? AND notebook_id=?) AND ${matches} AND ${idle}`)
        .bind(id, cellId, id, ...matchBinds, id, cellId),
      this.db.prepare(`DELETE FROM notebook_cells WHERE id=? AND notebook_id=? AND ${matches} AND ${idle}`)
        .bind(cellId, id, ...matchBinds, id, cellId),
      this.bumpStructure(id, structureVersion, now, "NOT EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=?)",
        [cellId, id]),
    ]);
    if (!this.changed(results, 1)) await this.structureFailure(id, structureVersion, cellId);
  }
  async renameNotebook(id: string, title: string): Promise<void> {
    const now = Date.now();
    const outcome = await this.db.prepare(`UPDATE notebooks SET title=?,version=version+1,updated_at=?
      WHERE id=? AND owner_id=? AND state<>'deleting'`).bind(title, now, id, this.ownerId).run() as { meta?: { changes?: number } };
    if (!outcome.meta?.changes) throw new SpikeError("notebook_not_found", "rename", 404);
  }
  async artifactSummary(id: string): Promise<{ artifactCount: number; totalBytes: number; permanentCount: number }> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes, COALESCE(SUM(permanent),0) AS permanent
      FROM notebook_artifacts WHERE notebook_id=? AND owner_id=? AND state<>'expired'`)
      .bind(id, this.ownerId).first<{ count: number; bytes: number; permanent: number }>();
    return { artifactCount: row?.count ?? 0, totalBytes: row?.bytes ?? 0, permanentCount: row?.permanent ?? 0 };
  }
  async runCount(id: string): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM notebook_runs WHERE notebook_id=?")
      .bind(id).first<{ count: number }>();
    return row?.count ?? 0;
  }
  /** Mark a closed notebook as deleting; blocks reopen and maintenance. Idempotent. */
  async beginDelete(id: string): Promise<boolean> {
    const outcome = await this.db.prepare(`UPDATE notebooks SET state='deleting',updated_at=?
      WHERE id=? AND owner_id=? AND state IN ('closed','deleting')
      AND NOT EXISTS(SELECT 1 FROM notebook_runtimes WHERE notebook_id=? AND released=0)`)
      .bind(Date.now(), id, this.ownerId, id).run() as { meta?: { changes?: number } };
    return Boolean(outcome.meta?.changes);
  }
  async artifactKeys(id: string): Promise<string[]> {
    return (await this.db.prepare("SELECT object_key FROM notebook_artifacts WHERE notebook_id=? AND owner_id=?")
      .bind(id, this.ownerId).all<{ object_key: string }>()).results.map((row) => row.object_key);
  }
  /** Remove every row of a notebook already marked deleting, in one transaction. */
  async purgeNotebook(id: string): Promise<void> {
    const guard = "EXISTS(SELECT 1 FROM notebooks WHERE id=? AND owner_id=? AND state='deleting')";
    const statement = (sql: string) => this.db.prepare(`${sql} AND ${guard}`).bind(id, id, this.ownerId);
    await this.db.batch([
      this.db.prepare(`DELETE FROM artifact_downloads WHERE artifact_id IN
        (SELECT id FROM notebook_artifacts WHERE notebook_id=? AND owner_id=?) AND ${guard}`).bind(id, this.ownerId, id, this.ownerId),
      statement("DELETE FROM notebook_artifacts WHERE notebook_id=?"),
      statement("DELETE FROM notebook_runs WHERE notebook_id=?"),
      statement("DELETE FROM notebook_cells WHERE notebook_id=?"),
      statement("DELETE FROM notebook_inputs WHERE notebook_id=?"),
      statement("DELETE FROM runtime_tasks WHERE notebook_id=?"),
      statement("DELETE FROM notebook_runtimes WHERE notebook_id=?"),
      this.db.prepare("DELETE FROM notebooks WHERE id=? AND owner_id=? AND state='deleting'").bind(id, this.ownerId),
    ]);
  }
  async run(id: string, notebookId?: string): Promise<RunRow> {
    const row = await this.db.prepare(`SELECT r.* FROM notebook_runs r JOIN notebooks n ON n.id=r.notebook_id
      WHERE r.id=? AND n.owner_id=? AND (? IS NULL OR n.id=?)`)
      .bind(id, this.ownerId, notebookId ?? null, notebookId ?? null).first<RunRow>();
    if (!row) throw new SpikeError("run_not_found", "notebook", 404);
    return row;
  }
  async runByKey(id: string, key: string): Promise<RunRow | null> {
    return this.db.prepare(`SELECT r.* FROM notebook_runs r JOIN notebooks n ON n.id=r.notebook_id
      WHERE r.notebook_id=? AND r.request_key=? AND n.owner_id=?`)
      .bind(id, key, this.ownerId).first<RunRow>();
  }
  async reserveRun(input: {
    notebookId: string; cellId: string; cellVersion: number; idempotencyKey: string; actor: "user" | "assistant";
  }): Promise<{ run: RunRow; cached: boolean }> {
    const { notebookId: id, cellId, cellVersion, idempotencyKey: key, actor } = input;
    const previous = await this.runByKey(id, key);
    if (previous) {
      if (previous.cell_id !== cellId || previous.cell_version !== cellVersion) {
        throw new SpikeError("idempotency_key_conflict", "run", 409);
      }
      return { run: previous, cached: true };
    }
    const runId = crypto.randomUUID();
    const now = Date.now();
    try { await this.db.batch([
      this.db.prepare(`UPDATE notebooks SET active_run_id=?,updated_at=?,last_activity_at=? WHERE id=? AND owner_id=?
        AND state='open' AND active_run_id IS NULL
        AND EXISTS(SELECT 1 FROM notebook_cells WHERE id=? AND notebook_id=? AND version=? AND kind='code')`)
        .bind(runId, now, now, id, this.ownerId, cellId, id, cellVersion),
      this.db.prepare(`INSERT INTO notebook_runs(id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,interrupt_requested,created_at,updated_at,artifacts_state)
        SELECT ?,n.id,n.runtime_id,c.id,c.version,?,c.source,?,'dispatching',0,?,?,'pending'
        FROM notebooks n JOIN notebook_cells c ON c.notebook_id=n.id
        WHERE n.id=? AND n.owner_id=? AND n.active_run_id=? AND c.id=?`)
        .bind(runId, key, actor, now, now, id, this.ownerId, runId, cellId),
    ]); } catch {
      const repeated = await this.runByKey(id, key);
      if (repeated && repeated.cell_id === cellId && repeated.cell_version === cellVersion) {
        return { run: repeated, cached: true };
      }
      throw new SpikeError("run_reservation_conflict", "run", 409);
    }
    const reserved = await this.runByKey(id, key);
    if (!reserved) throw new SpikeError("notebook_busy_closed_or_cell_version_conflict", "run", 409);
    if (reserved.cell_id !== cellId || reserved.cell_version !== cellVersion) {
      throw new SpikeError("idempotency_key_conflict", "run", 409);
    }
    return { run: reserved, cached: reserved.id !== runId };
  }
  async updateRun(id: string, state: RunState, result: RunResult | null,
    error: Record<string, unknown> | null = null): Promise<void> {
    const row = await this.run(id);
    const now = Date.now();
    const resultJson = result ? JSON.stringify(result) : null;
    if (resultJson && new TextEncoder().encode(resultJson).byteLength > MAX_RESULT_BYTES) {
      throw new SpikeError("run_result_limit_exceeded", "notebook");
    }
    const terminal = result && result.status !== "running" ? result.finishedAt : null;
    if (result && result.status !== "running" && (terminal === null || terminal < row.created_at - 60_000 || terminal > now + 30_000)) {
      throw new SpikeError("run_terminal_clock_untrusted", "notebook");
    }
    // A slow poll cannot turn a terminal result back into running/unknown.
    await this.db.batch([
      this.db.prepare(`UPDATE notebook_runs SET state=?,result_json=COALESCE(?,result_json),error_json=?,updated_at=?,
        terminal_at=COALESCE(terminal_at,?),artifacts_state=CASE
          WHEN ?='incomplete' THEN 'discarded' WHEN ?='error' AND ? IS NULL THEN 'saved' ELSE artifacts_state END
        WHERE id=? AND state NOT IN ('ok','error','interrupted','incomplete')
        AND (? NOT IN ('submitted','unknown') OR state='dispatching')`)
        .bind(state, resultJson, error ? JSON.stringify(error) : null, now,
          terminal === null ? null : Math.max(row.created_at, Math.min(now, terminal)), state, state,
          resultJson, id, state),
      this.db.prepare(`UPDATE notebooks SET active_run_id=NULL,updated_at=? WHERE id=? AND owner_id=?
        AND active_run_id=? AND EXISTS(SELECT 1 FROM notebook_runs WHERE id=? AND state IN ('ok','error','interrupted','incomplete')
          AND artifacts_state IN ('saved','legacy','discarded'))`)
        .bind(now, row.notebook_id, this.ownerId, id, id),
      this.db.prepare(`UPDATE notebooks SET state='open' WHERE id=? AND owner_id=?
        AND state='interrupting' AND active_run_id IS NULL AND control_token IS NULL`)
        .bind(row.notebook_id, this.ownerId),
    ]);
  }
  async runs(id: string, outputBudget: number): Promise<RunRow[]> {
    await this.notebook(id);
    // Apply the budget inside SQLite, before large JSON rows reach the Worker.
    return (await this.db.prepare(`WITH latest AS (
      SELECT *,rowid AS run_order FROM notebook_runs WHERE notebook_id=? AND id IN
      (SELECT (SELECT r.id FROM notebook_runs r WHERE r.cell_id=c.id AND r.notebook_id=c.notebook_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
       FROM notebook_cells c WHERE c.notebook_id=?) ORDER BY created_at DESC,rowid DESC LIMIT ?
      ), bounded AS (
        SELECT *,SUM(COALESCE(length(CAST(result_json AS BLOB)),0))
          OVER (ORDER BY created_at DESC,run_order DESC) AS result_bytes FROM latest
      ) SELECT id,notebook_id,runtime_id,cell_id,cell_version,request_key,source,actor,state,
        CASE WHEN result_bytes<=? THEN result_json ELSE NULL END AS result_json,
        CASE WHEN result_bytes>? AND result_json IS NOT NULL THEN 1 ELSE 0 END AS result_omitted,
        error_json,interrupt_requested,created_at,updated_at,terminal_at,artifacts_state,artifact_error_json
        FROM bounded ORDER BY created_at DESC,run_order DESC`)
      .bind(id, id, MAX_CELLS, outputBudget, outputBudget).all<RunRow>()).results;
  }
  async markInterrupt(id: string): Promise<void> {
    await this.run(id);
    await this.db.prepare("UPDATE notebook_runs SET interrupt_requested=1,updated_at=? WHERE id=?")
      .bind(Date.now(), id).run();
  }
  async beginInterrupt(id: string, runId: string): Promise<string> {
    const token = crypto.randomUUID();
    await this.db.prepare(`UPDATE notebooks SET state='interrupting',control_token=?,updated_at=?,last_activity_at=?
      WHERE id=? AND owner_id=? AND state='open' AND active_run_id=?
      AND EXISTS(SELECT 1 FROM notebook_runs WHERE id=? AND state<>'dispatching')`)
      .bind(token, Date.now(), Date.now(), id, this.ownerId, runId, runId).run();
    const row = await this.notebook(id);
    if (row.control_token !== token) throw new SpikeError("notebook_control_conflict", "interrupt", 409);
    return token;
  }
  async finishInterrupt(id: string, token: string): Promise<void> {
    await this.db.prepare(`UPDATE notebooks SET control_token=NULL,
      state=CASE WHEN active_run_id IS NULL THEN 'open' ELSE 'interrupting' END,updated_at=?
      WHERE id=? AND owner_id=? AND state='interrupting' AND control_token=?`)
      .bind(Date.now(), id, this.ownerId, token).run();
  }
  async beginClose(id: string): Promise<NotebookRow> {
    const token = crypto.randomUUID();
    await this.db.prepare(`UPDATE notebooks SET state='closing',mutation_id=?,updated_at=?
      WHERE id=? AND owner_id=? AND state IN ('open','unknown','interrupting')
      AND NOT EXISTS(SELECT 1 FROM notebook_runs WHERE id=notebooks.active_run_id
        AND state='dispatching' AND created_at>?)`)
      .bind(token, Date.now(), id, this.ownerId, Date.now() - 45_000).run();
    const row = await this.notebook(id);
    if (row.state === "closed" || row.state === "closing") return row;
    throw new SpikeError("notebook_open_or_dispatch_in_progress", "close", 409);
  }
  async beginIdleClose(notebook: NotebookRow, cutoff: number): Promise<NotebookRow | null> {
    const token = crypto.randomUUID();
    await this.db.batch([this.db.prepare(`UPDATE notebooks SET state='closing',mutation_id=? WHERE id=? AND owner_id=? AND runtime_id=?
      AND state='open' AND active_run_id IS NULL AND control_token IS NULL
      AND last_activity_at=? AND last_terminal_at IS ?
      AND MAX(COALESCE(NULLIF(last_activity_at,0),updated_at),COALESCE(last_terminal_at,0))<=?
      AND NOT EXISTS(SELECT 1 FROM notebook_runs WHERE runtime_id=? AND artifacts_state NOT IN ('saved','legacy','discarded'))`)
      .bind(token, notebook.id, this.ownerId, notebook.runtime_id, notebook.last_activity_at,
        notebook.last_terminal_at, cutoff, notebook.runtime_id),
      this.db.prepare(`UPDATE notebook_runtimes SET error_json=? WHERE id=? AND owner_id=?
        AND EXISTS(SELECT 1 FROM notebooks WHERE runtime_id=? AND mutation_id=? AND state='closing')`)
        .bind(JSON.stringify({ code: "idle_close_requested", stage: "maintenance" }), notebook.runtime_id,
          this.ownerId, notebook.runtime_id, token),
    ]);
    const current = await this.notebook(notebook.id);
    return current.mutation_id === token ? current : null;
  }
  async retryIdleClose(notebook: NotebookRow): Promise<NotebookRow | null> {
    const runtime = await this.runtime(notebook.runtime_id!);
    const error = runtime.error_json ? JSON.parse(runtime.error_json) : null;
    if (!runtime.endpoint || runtime.released || !["idle_close_requested", "idle_release_unconfirmed"].includes(error?.code)) return null;
    const token = crypto.randomUUID();
    await this.db.prepare(`UPDATE notebooks SET state='closing',mutation_id=? WHERE id=? AND owner_id=? AND runtime_id=?
      AND state IN ('closing','unknown') AND active_run_id IS NULL AND control_token IS NULL
      AND NOT EXISTS(SELECT 1 FROM notebook_runs WHERE runtime_id=? AND artifacts_state NOT IN ('saved','legacy','discarded'))`)
      .bind(token, notebook.id, this.ownerId, runtime.id, runtime.id).run();
    const current = await this.notebook(notebook.id); return current.mutation_id === token ? current : null;
  }
}

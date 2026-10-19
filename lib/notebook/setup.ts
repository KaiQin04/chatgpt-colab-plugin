/** Fixed runtime preparation jobs and owner-editable package names. */
import type { SpikeEnv } from "../platform/config.ts";
import { SpikeError } from "../platform/security.ts";
import type { SetupView } from "./contract.ts";

export const DEFAULT_PACKAGES = ["polars", "lightgbm", "duckdb", "pyarrow", "statsmodels", "optuna"];
export const BLENDER_VERSION = "5.2.2";
export const BLENDER_URL = "https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz";
export const BLENDER_SHA256 = "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168";
export const BLENDER_EXECUTABLE = `/content/colab_tools/blender-${BLENDER_VERSION}-linux-x64/blender`;
export type SetupKind = "packages" | "blender";
export interface SetupRow {
  id: string; notebook_id: string; runtime_id: string; request_key: string;
  kind: SetupKind; config_json: string; state: string; result_json: string | null;
  error_json: string | null; created_at: number; finished_at: number | null;
}
export interface SetupResult {
  protocol: 1; jobId: string; status: "running" | "ready" | "error";
  phase: string; packages: { name: string; version: string; installed: boolean }[];
  blender: { version: string; executable: string; sha256: string; downloaded: boolean } | null;
  error: { code: string; exitCode?: number } | null; startedAt: number; finishedAt: number | null;
}
export function packageList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 16 || raw.some((name) => typeof name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))) throw new SpikeError("package_list_invalid", "settings", 400);
  return [...new Set(raw.map((name: string) => name.toLowerCase().replace(/[-_.]+/g, "-")))];
}
export function setupPath(notebookId: string, jobId: string): string {
  if (![notebookId, jobId].every((id) => /^[a-f0-9-]{36}$/.test(id))) throw new SpikeError("setup_id_invalid", "setup");
  return `content/colab_setup/${notebookId}/${jobId}/result.json`;
}
export function parseSetupResult(raw: unknown, job: SetupRow): SetupResult {
  let value: SetupResult;
  try { if (typeof raw !== "string" || raw.length > 16_000) throw new Error(); value = JSON.parse(raw); }
  catch { throw new SpikeError("setup_result_invalid", "setup"); }
  const phases = ["checking", "installing_packages", "downloading_blender", "extracting_blender", "verifying_blender", "ready", "error"];
  const codes = ["packages_install_failed", "packages_install_timeout", "package_verification_failed", "blender_download_failed",
    "blender_download_timeout", "blender_archive_limit", "blender_checksum_mismatch", "blender_archive_invalid", "blender_version_mismatch",
    "blender_verification_failed", "setup_path_invalid", "setup_interrupted", "setup_failed", "unsupported_runtime"];
  if (!value || value.protocol !== 1 || value.jobId !== job.id || !["running", "ready", "error"].includes(value.status) ||
    !phases.includes(value.phase) || !Number.isSafeInteger(value.startedAt) || value.startedAt < job.created_at - 60_000 || value.startedAt > Date.now() + 60_000 ||
    (value.status !== "running" && (!Number.isSafeInteger(value.finishedAt) || Number(value.finishedAt) < value.startedAt || Number(value.finishedAt) > Date.now() + 60_000)) ||
    !Array.isArray(value.packages) || value.packages.length > 16 || value.packages.some((item) => !item ||
      !packageList(JSON.parse(job.config_json)).includes(item.name) || typeof item.installed !== "boolean" ||
      typeof item.version !== "string" || !/^[A-Za-z0-9.+_!-]{1,80}$/.test(item.version)) ||
    (value.blender !== null && (!value.blender || value.blender.version !== BLENDER_VERSION ||
      value.blender.executable !== BLENDER_EXECUTABLE || value.blender.sha256 !== BLENDER_SHA256 || typeof value.blender.downloaded !== "boolean")) ||
    (value.status === "error" && (!value.error || !codes.includes(value.error.code))) ||
    (value.status === "ready" && job.kind === "blender" && !value.blender)) throw new SpikeError("setup_result_invalid", "setup");
  return { protocol: 1, jobId: job.id, status: value.status, phase: value.phase,
    packages: value.packages.map(({ name, version, installed }) => ({ name, version, installed })),
    blender: value.blender ? { version: BLENDER_VERSION, executable: BLENDER_EXECUTABLE, sha256: BLENDER_SHA256, downloaded: value.blender.downloaded } : null,
    error: value.status === "error" ? { code: value.error!.code,
      ...(Number.isInteger(value.error!.exitCode) && Number(value.error!.exitCode) >= 0 && Number(value.error!.exitCode) <= 255 ? { exitCode: value.error!.exitCode } : {}) } : null,
    startedAt: value.startedAt, finishedAt: value.status === "running" ? null : value.finishedAt };
}
export function setupView(row: SetupRow): SetupView {
  return { id: row.id, kind: row.kind, state: row.state, createdAt: row.created_at, finishedAt: row.finished_at,
    packages: JSON.parse(row.config_json), result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error_json ? JSON.parse(row.error_json) : null };
}

export class SetupStore {
  readonly db: D1Database;
  constructor(env: SpikeEnv, readonly ownerId: string) {
    if (!env.DB) throw new SpikeError("database_binding_missing", "setup");
    this.db = env.DB;
  }
  async settings(): Promise<{ version: number; packages: string[] }> {
    const row = await this.db.prepare("SELECT version,packages_json FROM runtime_settings WHERE owner_id=?")
      .bind(this.ownerId).first<{ version: number; packages_json: string }>();
    return row ? { version: row.version, packages: packageList(JSON.parse(row.packages_json)) } : { version: 0, packages: [...DEFAULT_PACKAGES] };
  }
  async saveSettings(packages: string[], version: number): Promise<{ version: number; packages: string[] }> {
    const value = packageList(packages);
    const result = await this.db.prepare(`INSERT INTO runtime_settings(owner_id,version,packages_json) SELECT ?,1,? WHERE ?=0
      OR EXISTS(SELECT 1 FROM runtime_settings WHERE owner_id=? AND version=?)
      ON CONFLICT(owner_id) DO UPDATE SET version=runtime_settings.version+1,packages_json=excluded.packages_json WHERE runtime_settings.version=?`)
      .bind(this.ownerId, JSON.stringify(value), version, this.ownerId, version, version).run();
    if (!result.meta.changes) throw new SpikeError("settings_version_conflict", "settings", 409);
    return this.settings();
  }
  async task(id: string): Promise<SetupRow> {
    const row = await this.db.prepare(`SELECT t.* FROM runtime_tasks t JOIN notebooks n ON n.id=t.notebook_id
      WHERE t.id=? AND n.owner_id=?`).bind(id, this.ownerId).first<SetupRow>();
    if (!row) throw new SpikeError("setup_not_found", "setup", 404); return row;
  }
  async list(runtimeId: string): Promise<SetupRow[]> {
    return (await this.db.prepare(`SELECT t.* FROM runtime_tasks t JOIN notebooks n ON n.id=t.notebook_id
      WHERE t.runtime_id=? AND n.owner_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 8`)
      .bind(runtimeId, this.ownerId).all<SetupRow>()).results;
  }
  async queue(notebookId: string, kind: SetupKind, key: string): Promise<{ task: SetupRow; cached: boolean }> {
    const previous = () => this.db.prepare(`SELECT t.* FROM runtime_tasks t JOIN notebooks n ON n.id=t.notebook_id
      WHERE n.id=? AND n.owner_id=? AND t.request_key=?`).bind(notebookId, this.ownerId, key).first<SetupRow>();
    const checked = (row: SetupRow) => {
      if (row.kind !== kind) throw new SpikeError("idempotency_key_conflict", "setup", 409);
      return { task: row, cached: true };
    };
    const old = await previous(); if (old) return checked(old);
    const id = crypto.randomUUID(), now = Date.now(), packages = kind === "packages" ? (await this.settings()).packages : [];
    try { await this.db.batch([
      this.db.prepare(`UPDATE notebooks SET state='preparing',active_setup_id=?,last_activity_at=? WHERE id=? AND owner_id=?
        AND state='open' AND active_run_id IS NULL AND active_input_id IS NULL AND control_token IS NULL AND active_setup_id IS NULL`)
        .bind(id, now, notebookId, this.ownerId),
      this.db.prepare(`INSERT INTO runtime_tasks(id,notebook_id,runtime_id,request_key,kind,config_json,state,created_at)
        SELECT ?,id,runtime_id,?,?,?,'pending',? FROM notebooks WHERE id=? AND owner_id=? AND active_setup_id=?`)
        .bind(id, key, kind, JSON.stringify(packages), now, notebookId, this.ownerId, id),
    ]); } catch {
      const repeated = await previous(); if (repeated) return checked(repeated);
      throw new SpikeError("setup_reservation_conflict", "setup", 409);
    }
    const row = await previous(); if (!row) throw new SpikeError("notebook_busy_or_closed", "setup", 409);
    return row.id === id ? { task: row, cached: false } : checked(row);
  }
  async claim(id: string): Promise<boolean> {
    return Boolean((await this.db.prepare(`UPDATE runtime_tasks SET state='dispatching' WHERE id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM notebooks n WHERE n.owner_id=? AND n.runtime_id=runtime_tasks.runtime_id AND n.active_setup_id=runtime_tasks.id AND n.state='preparing')`)
      .bind(id, this.ownerId).run()).meta.changes);
  }
  async update(id: string, state: string, result: SetupResult | null, error: Record<string, unknown> | null = null): Promise<void> {
    const job = await this.task(id);
    const finishedAt = result && result.status !== "running" ? result.finishedAt
      : state === "error" && error?.dispatch === "not_sent" ? Date.now() : null;
    await this.db.batch([
      this.db.prepare(`UPDATE runtime_tasks SET state=CASE WHEN state='running' AND ? IN ('submitted','unknown') THEN state ELSE ? END,
        result_json=COALESCE(?,result_json),error_json=?,finished_at=COALESCE(?,finished_at) WHERE id=? AND state NOT IN ('ready','error','incomplete')`)
        .bind(state, state, result ? JSON.stringify(result) : null, error ? JSON.stringify(error) : result?.error ? JSON.stringify({ ...result.error, stage: "setup" }) : null,
          finishedAt, id),
      this.db.prepare(`UPDATE notebooks SET state='open',active_setup_id=NULL,last_activity_at=MAX(last_activity_at,?) WHERE id=? AND owner_id=?
        AND state='preparing' AND runtime_id=? AND active_setup_id=? AND EXISTS(SELECT 1 FROM runtime_tasks WHERE id=? AND state IN ('ready','error'))`)
        .bind(finishedAt ?? 0, job.notebook_id, this.ownerId, job.runtime_id, id, id),
    ]);
  }
  async discard(notebookId: string, pendingOnly = false): Promise<void> {
    await this.db.batch([
      this.db.prepare(`UPDATE runtime_tasks SET state='incomplete',error_json=?,finished_at=? WHERE id=
        (SELECT active_setup_id FROM notebooks WHERE id=? AND owner_id=? AND state='preparing') AND (?=0 OR state='pending')`)
        .bind(JSON.stringify({ code: pendingOnly ? "setup_cancelled_before_dispatch" : "setup_explicitly_discarded", stage: "close" }), Date.now(), notebookId, this.ownerId, pendingOnly ? 1 : 0),
      this.db.prepare(`UPDATE notebooks SET state='closing',active_setup_id=NULL WHERE id=? AND owner_id=? AND state='preparing'
        AND EXISTS(SELECT 1 FROM runtime_tasks WHERE id=notebooks.active_setup_id AND state='incomplete')`)
        .bind(notebookId, this.ownerId),
    ]);
  }
}

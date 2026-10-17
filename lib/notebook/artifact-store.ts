/** Owner-scoped artifact ledger and CAS retention transitions. No object keys leave this module's callers. */
import type { SpikeEnv } from "../platform/config.ts";
import { digest, randomValue, SpikeError } from "../platform/security.ts";
import { ARTIFACT_RETENTION_MS, DOWNLOAD_TTL_MS, MAX_ARTIFACT_FILES, MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_RUN_BYTES } from "./policy.ts";
import { NotebookStore } from "./store.ts";
import type { ArtifactManifest, ArtifactRow } from "./types.ts";

const ERRORS = new Set(["artifact_file_too_large", "artifact_run_too_large", "artifact_file_count_exceeded",
  "artifact_path_invalid", "artifact_symlink_rejected", "artifact_io_failed", "artifact_directory_missing"]);
export function artifactPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 240 || /[\\\u0000-\u001f\u007f%]/u.test(path) ||
    path.split("/").length > 8 || path.split("/").some((part) => !part || part === "." || part === ".." || part.length > 100)) {
    throw new SpikeError("artifact_path_invalid", "artifacts", 400);
  }
  return path;
}
export function artifactManifest(value: unknown): ArtifactManifest {
  if (!value || typeof value !== "object") throw new SpikeError("artifact_manifest_missing", "artifacts");
  const raw = value as ArtifactManifest;
  if (!Array.isArray(raw.files) || raw.files.length > MAX_ARTIFACT_FILES ||
    !Array.isArray(raw.errors) || raw.errors.length > MAX_ARTIFACT_FILES + 1) {
    throw new SpikeError("artifact_manifest_invalid", "artifacts");
  }
  let total = 0;
  const paths = new Set<string>();
  const files = raw.files.map((file) => {
    const path = artifactPath(file.path);
    if (paths.has(path) || !Number.isSafeInteger(file.size) || file.size < 0 ||
      file.size > MAX_ARTIFACT_FILE_BYTES || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new SpikeError("artifact_manifest_invalid", "artifacts");
    }
    total += file.size; paths.add(path);
    if (total > MAX_ARTIFACT_RUN_BYTES) throw new SpikeError("artifact_run_too_large", "artifacts");
    return { path, size: file.size, sha256: file.sha256 };
  });
  const errors = raw.errors.map((error) => {
    if (!error || !ERRORS.has(error.code)) throw new SpikeError("artifact_manifest_invalid", "artifacts");
    return { code: error.code, ...(error.path ? { path: artifactPath(error.path) } : {}) };
  });
  return { files, errors };
}

export class ArtifactStore {
  readonly notebooks: NotebookStore;
  readonly db: D1Database;
  constructor(env: SpikeEnv, readonly ownerId: string) {
    this.notebooks = new NotebookStore(env, ownerId); this.db = this.notebooks.db;
  }
  async expireDownloadTokens(observedAt: number): Promise<void> {
    await this.db.prepare(`DELETE FROM artifact_downloads WHERE token_hash IN
      (SELECT token_hash FROM artifact_downloads WHERE owner_id=? AND expires_at<=? LIMIT 128)`)
      .bind(this.ownerId, observedAt).run();
  }
  async retentionPendingCount(observedAt: number): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS count
      FROM notebook_artifacts WHERE owner_id=? AND permanent=0 AND (state='deleting' OR (state='ready' AND expires_at<=?))
      AND EXISTS(SELECT 1 FROM notebook_runs r WHERE r.id=notebook_artifacts.run_id AND r.artifacts_state IN ('saved','legacy','discarded'))`)
      .bind(this.ownerId, observedAt).first<{ count: number }>();
    return row?.count ?? 0;
  }
  async expiredTokenCount(observedAt: number): Promise<number> {
    const row = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM artifact_downloads WHERE owner_id=? AND expires_at<=?",
    ).bind(this.ownerId, observedAt).first<{ count: number }>();
    return row?.count ?? 0;
  }
  async initialize(runId: string, manifest: ArtifactManifest, now: number): Promise<void> {
    const run = await this.notebooks.run(runId);
    const ownerKey = await digest(this.ownerId);
    const statements = manifest.files.map((file) => {
      const id = crypto.randomUUID();
      return this.db.prepare(`INSERT OR IGNORE INTO notebook_artifacts
        (id,owner_id,notebook_id,run_id,path,size,sha256,object_key,media_type,state,permanent,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'pending',0,?)`)
        .bind(id, this.ownerId, run.notebook_id, runId, file.path, file.size, file.sha256,
          `artifacts/${ownerKey}/${run.notebook_id}/${runId}/${id}`, "application/octet-stream", now);
    });
    if (statements.length) await this.db.batch(statements);
    const rows = await this.list(run.notebook_id, runId);
    if (rows.length !== manifest.files.length || rows.some((row) => !manifest.files.some(
      (file) => file.path === row.path && file.sha256 === row.sha256 && file.size === row.size,
    ))) throw new SpikeError("artifact_manifest_changed", "artifacts");
  }
  async artifact(id: string): Promise<ArtifactRow> {
    const row = await this.db.prepare("SELECT * FROM notebook_artifacts WHERE id=? AND owner_id=?")
      .bind(id, this.ownerId).first<ArtifactRow>();
    if (!row) throw new SpikeError("artifact_not_found", "artifacts", 404);
    return row;
  }
  async list(notebookId: string, runId?: string, beforeId?: string): Promise<ArtifactRow[]> {
    await this.notebooks.notebook(notebookId);
    return (await this.db.prepare(`SELECT * FROM notebook_artifacts WHERE owner_id=? AND notebook_id=?
      AND (? IS NULL OR run_id=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 64`)
      .bind(this.ownerId, notebookId, runId ?? null, runId ?? null, beforeId ?? null, beforeId ?? null).all<ArtifactRow>()).results;
  }
  async saved(id: string, mediaType: string, now: number): Promise<void> {
    await this.db.prepare(`UPDATE notebook_artifacts SET state='ready',media_type=?,saved_at=?,expires_at=?
      WHERE id=? AND owner_id=? AND state='pending'`)
      .bind(mediaType, now, now + ARTIFACT_RETENTION_MS, id, this.ownerId).run();
  }
  async finishRun(runId: string, error: Record<string, unknown> | null): Promise<boolean> {
    const run = await this.notebooks.run(runId);
    const rows = await this.list(run.notebook_id, runId);
    const saved = !error && rows.every((row) => row.state === "ready");
    await this.db.batch([
      this.db.prepare(`UPDATE notebook_runs SET artifacts_state=?,artifact_error_json=? WHERE id=?
        AND artifacts_state NOT IN ('legacy','saved','discarded')`)
        .bind(saved ? "saved" : error ? "blocked" : "pending", error ? JSON.stringify(error) : null, runId),
      this.db.prepare(`UPDATE notebooks SET active_run_id=NULL,
        last_terminal_at=MAX(COALESCE(last_terminal_at,0),(SELECT COALESCE(terminal_at,0) FROM notebook_runs WHERE id=?))
        WHERE id=? AND owner_id=? AND active_run_id=? AND EXISTS
        (SELECT 1 FROM notebook_runs WHERE id=? AND state IN ('ok','error','interrupted','incomplete')
          AND artifacts_state IN ('saved','legacy','discarded'))`)
        .bind(runId, run.notebook_id, this.ownerId, runId, runId),
      this.db.prepare(`UPDATE notebooks SET state='open' WHERE id=? AND owner_id=? AND state='interrupting'
        AND active_run_id IS NULL AND control_token IS NULL`).bind(run.notebook_id, this.ownerId),
    ]);
    return saved;
  }
  async pin(id: string, permanent: boolean, now: number): Promise<ArtifactRow> {
    const row = await this.artifact(id);
    if (row.state !== "ready" || (!row.permanent && row.expires_at !== null && row.expires_at <= now)) {
      throw new SpikeError("artifact_expired_or_retiring", "artifacts", 409);
    }
    await this.db.prepare(`UPDATE notebook_artifacts SET permanent=?,expires_at=? WHERE id=? AND owner_id=? AND state='ready'
      AND (permanent=1 OR expires_at>?)`)
      .bind(permanent ? 1 : 0, permanent ? null : (row.saved_at ?? now) + ARTIFACT_RETENTION_MS, id, this.ownerId, now).run();
    const result = await this.artifact(id);
    if (result.state !== "ready" || result.permanent !== Number(permanent)) throw new SpikeError("artifact_pin_conflict", "artifacts", 409);
    await this.notebooks.touch(row.notebook_id, now);
    return result;
  }
  async downloadToken(id: string, now: number): Promise<{ token: string; expiresAt: number }> {
    const row = await this.artifact(id);
    if (row.state !== "ready" || (!row.permanent && (row.expires_at ?? 0) <= now)) throw new SpikeError("artifact_expired", "download", 410);
    const token = randomValue();
    const expiresAt = Math.min(now + DOWNLOAD_TTL_MS, row.permanent ? Infinity : row.expires_at!);
    await this.db.prepare("INSERT INTO artifact_downloads(token_hash,artifact_id,owner_id,expires_at) VALUES(?,?,?,?)")
      .bind(await digest(token), id, this.ownerId, expiresAt).run();
    return { token, expiresAt };
  }
  async authorizeDownload(id: string, token: string, now: number): Promise<ArtifactRow> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SpikeError("download_token_invalid", "download", 403);
    const grant = await this.db.prepare("SELECT artifact_id FROM artifact_downloads WHERE token_hash=? AND owner_id=? AND artifact_id=? AND expires_at>?")
      .bind(await digest(token), this.ownerId, id, now).first();
    if (!grant) throw new SpikeError("download_token_expired_or_invalid", "download", 403);
    const row = await this.artifact(id);
    if (row.state !== "ready" || (!row.permanent && (row.expires_at ?? 0) <= now)) throw new SpikeError("artifact_expired", "download", 410);
    return row;
  }
  async retiring(now: number, limit = 2): Promise<ArtifactRow[]> {
    const rows = (await this.db.prepare(`SELECT * FROM notebook_artifacts WHERE owner_id=? AND permanent=0
      AND (state='deleting' OR (state='ready' AND expires_at<=?))
      AND EXISTS(SELECT 1 FROM notebook_runs r WHERE r.id=notebook_artifacts.run_id AND r.artifacts_state IN ('saved','legacy','discarded'))
      ORDER BY expires_at LIMIT ?`)
      .bind(this.ownerId, now, limit).all<ArtifactRow>()).results;
    const claimed: ArtifactRow[] = [];
    for (const row of rows) {
      await this.db.prepare(`UPDATE notebook_artifacts SET state='deleting' WHERE id=? AND owner_id=? AND permanent=0
        AND (state='deleting' OR (state='ready' AND expires_at<=?))`).bind(row.id, this.ownerId, now).run();
      const current = await this.artifact(row.id); if (current.state === "deleting") claimed.push(current);
    }
    return claimed;
  }
  async expired(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE notebook_artifacts SET state='expired' WHERE id=? AND owner_id=? AND state='deleting'").bind(id, this.ownerId),
      this.db.prepare("DELETE FROM artifact_downloads WHERE artifact_id=? AND owner_id=?").bind(id, this.ownerId),
    ]);
  }
}

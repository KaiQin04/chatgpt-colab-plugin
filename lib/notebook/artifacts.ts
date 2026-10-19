/** Bounded one-file checkpoints: verify VM bytes, R2 checksum, then commit the D1 ledger. */
import type { SpikeEnv } from "../platform/config.ts";
import { boundedStep, requireActive } from "../platform/deadline.ts";
import { base64, safeError, SpikeError } from "../platform/security.ts";
import { ArtifactStore, artifactManifest } from "./artifact-store.ts";
import { ARTIFACT_PART_BYTES, MAX_PREVIEW_BYTES, SMALL_ARTIFACT_BYTES } from "./policy.ts";
import { archiveMultipart, uploadedParts } from "./artifact-multipart.ts";
import { hex } from "./artifact-object.ts";
import type { NotebookRuntime } from "./runtime.ts";
import type { ArtifactRow, RunResult, RunRow, RuntimeRow } from "./types.ts";
import type { ArtifactView } from "./contract.ts";
import { pngHeaderWithinLimits } from "./png.ts";

export { hex } from "./artifact-object.ts";
export function mediaType(data: Uint8Array): string {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)) return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
  if (new TextDecoder().decode(data.slice(0, 4)) === "RIFF" && new TextDecoder().decode(data.slice(8, 12)) === "WEBP") return "image/webp";
  return "application/octet-stream";
}
export async function archiveRun(env: SpikeEnv, ownerId: string, run: RunRow, runtime: RuntimeRow,
  remote: Pick<NotebookRuntime, "readArtifact"> & Partial<Pick<NotebookRuntime, "readArtifactRange">>, signal: AbortSignal, now: () => number,
  reserveVerification?: (ms: number) => void): Promise<{
    saved: boolean; processed: number; pending: number; error?: Record<string, unknown>;
  }> {
  const store = new ArtifactStore(env, ownerId);
  const io = <T>(stage: string, work: () => Promise<T>, ms = 2000) => boundedStep(stage, ms, signal, work);
  let processed = 0;
  let error: Record<string, unknown> | undefined;
  try {
    if (!run.result_json) throw new SpikeError("artifact_manifest_missing", "artifacts");
    const result = JSON.parse(run.result_json) as RunResult;
    const manifest = artifactManifest(result.artifacts);
    await io("artifactLedgerInit", () => store.initialize(run.id, manifest, now()));
    const pending = (await io("artifactLedgerList", () => store.list(run.notebook_id, run.id)))
      .filter((row) => row.state === "pending");
    const artifact = pending[0];
    if (artifact) {
      if (!env.BUCKET) throw new SpikeError("artifact_bucket_missing", "artifacts");
      if (artifact.size > SMALL_ARTIFACT_BYTES) {
        processed = await archiveMultipart(env, store, artifact, runtime, remote, signal, now, reserveVerification);
      } else {
        const existing = await io("artifactStoredHead", () => env.BUCKET!.head(artifact.object_key), 5000);
        let type = existing?.customMetadata?.mediaType ?? "application/octet-stream";
        if (!existing) {
          const data = await remote.readArtifact(runtime, artifact.path, artifact.size, signal);
          requireActive(signal, "artifactChecksum");
          const checksum = await io("artifactChecksum", () => crypto.subtle.digest("SHA-256", data));
          if (hex(checksum) !== artifact.sha256 || data.byteLength !== artifact.size) throw new SpikeError("artifact_checksum_mismatch", "artifacts");
          type = mediaType(data);
          requireActive(signal, "artifactStore");
          await io("artifactStore", () => env.BUCKET!.put(artifact.object_key, data, {
            sha256: checksum, httpMetadata: { contentType: type },
            customMetadata: { sha256: artifact.sha256, mediaType: type },
          }), 5000);
        }
        const head = await io("artifactStoredReadback", () => env.BUCKET!.head(artifact.object_key), 5000);
        if (!head || head.size !== artifact.size || !head.checksums.sha256 || hex(head.checksums.sha256) !== artifact.sha256) {
          throw new SpikeError("artifact_storage_readback_mismatch", "artifacts");
        }
        await io("artifactLedgerSaved", () => store.saved(artifact.id, type, now())); processed = 1;
      }
    }
    if (manifest.errors.length) error = { code: "artifact_manifest_blocked", stage: "artifacts", details: manifest.errors };
    const saved = await io("artifactRunSaved", () => store.finishRun(run.id, error ?? null));
    const remaining = (await io("artifactLedgerList", () => store.list(run.notebook_id, run.id))).filter((row) => row.state !== "ready").length;
    return { saved, processed, pending: remaining, ...(error ? { error } : {}) };
  } catch (caught) {
    error = caught instanceof SpikeError ? safeError(caught) : { code: "artifact_storage_failed", stage: "artifacts" };
    try { await io("artifactRunBlocked", () => store.finishRun(run.id, error!)); } catch { /* Active slot remains. */ }
    return { saved: false, processed, pending: 1, error };
  }
}

export function artifactView(row: ArtifactRow): ArtifactView {
  const uploadedBytes = row.state === "pending" && row.size > SMALL_ARTIFACT_BYTES
    ? Math.min(row.size, uploadedParts(row).length * ARTIFACT_PART_BYTES) : null;
  return { id: row.id, notebookId: row.notebook_id, runId: row.run_id, path: row.path, size: row.size,
    sha256: row.sha256, state: row.state, mediaType: row.media_type,
    permanent: row.permanent === 1, savedAt: row.saved_at, expiresAt: row.expires_at,
    ...(uploadedBytes !== null ? { progress: {
      uploadedBytes, totalBytes: row.size,
      phase: uploadedBytes === row.size ? "verifying" as const : "uploading" as const,
    } } : {}) };
}
export async function previewArtifact(env: SpikeEnv, row: ArtifactRow, signal: AbortSignal): Promise<string | null> {
  if (!env.BUCKET || row.size > MAX_PREVIEW_BYTES || row.media_type !== "image/png") return null;
  const object = await boundedStep("artifactPreview", 5000, signal, () => env.BUCKET!.get(row.object_key));
  if (!object || object.size !== row.size) throw new SpikeError("artifact_storage_missing", "artifacts");
  const data = await boundedStep("artifactPreviewRead", 5000, signal, () => object.arrayBuffer());
  if (data.byteLength !== row.size || hex(await crypto.subtle.digest("SHA-256", data)) !== row.sha256) {
    throw new SpikeError("artifact_storage_readback_mismatch", "artifacts");
  }
  // Bound decoded image memory as well as compressed bytes; never decode SVG/HTML.
  if (!pngHeaderWithinLimits(new Uint8Array(data))) return null;
  return `data:${row.media_type};base64,${base64(new Uint8Array(data))}`;
}

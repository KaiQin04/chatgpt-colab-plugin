/** One durable multipart checkpoint per request; the next request resumes from D1. */
import type { SpikeEnv } from "../platform/config.ts";
import { boundedStep, requireActive } from "../platform/deadline.ts";
import { SpikeError } from "../platform/security.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { verifyMultipart } from "./artifact-object.ts";
import { ARTIFACT_PART_BYTES, artifactVerificationMs } from "./policy.ts";
import type { NotebookRuntime } from "./runtime.ts";
import type { ArtifactRow, RuntimeRow } from "./types.ts";

export function uploadedParts(row: ArtifactRow): R2UploadedPart[] {
  const parts = JSON.parse(row.uploaded_parts_json || "[]") as R2UploadedPart[];
  if (!Array.isArray(parts) || parts.length > Math.ceil(row.size / ARTIFACT_PART_BYTES) ||
    parts.some((part, index) => part.partNumber !== index + 1 || typeof part.etag !== "string" || !part.etag)) {
    throw new SpikeError("artifact_upload_state_invalid", "artifacts");
  }
  return parts;
}

export async function archiveMultipart(env: SpikeEnv, store: ArtifactStore, artifact: ArtifactRow, runtime: RuntimeRow,
  remote: Partial<Pick<NotebookRuntime, "readArtifactRange">>, signal: AbortSignal, now: () => number,
  reserveVerification?: (ms: number) => void): Promise<number> {
  const io = <T>(stage: string, work: () => Promise<T>, ms = 2000) => boundedStep(stage, ms, signal, work);
  const verifyMs = artifactVerificationMs(artifact.size);
  const row = await io("artifactUploadClaim", () => store.claimUpload(artifact.id, now()));
  if (!row) return 0;
  const bucket = env.BUCKET!;
  let settled = false;
  try {
    const parts = uploadedParts(row);
    const existing = await io("artifactMultipartHead", () => bucket.head(row.object_key), 5000);
    if (existing) {
      if (!row.upload_id || parts.length !== Math.ceil(row.size / ARTIFACT_PART_BYTES)) {
        throw new SpikeError("artifact_upload_state_invalid", "artifacts");
      }
      // Completion may have succeeded even if its acknowledgement was lost.
      if (verifyMs > 20_000) await io("artifactVerifyLease", () => store.extendVerificationLease(row, now(), verifyMs + 40_000));
      reserveVerification?.(verifyMs);
      const version = await verifyMultipart(bucket, row, signal);
      await io("artifactVerified", () => store.uploadCheckpoint(row, row.upload_id!, parts, now(),
        { version, mediaType: "application/octet-stream" }));
    } else if (!row.upload_id) {
      const upload = await io("artifactMultipartCreate", () => bucket.createMultipartUpload(row.object_key,
        { httpMetadata: { contentType: "application/octet-stream" } }), 5000);
      requireActive(signal, "artifactMultipartCreated");
      await io("artifactMultipartCreated", () => store.uploadCheckpoint(row, upload.uploadId, parts, now()));
    } else if (parts.length < Math.ceil(row.size / ARTIFACT_PART_BYTES)) {
      if (!remote.readArtifactRange) throw new SpikeError("artifact_range_unsupported", "artifacts");
      const offset = parts.length * ARTIFACT_PART_BYTES, length = Math.min(ARTIFACT_PART_BYTES, row.size - offset);
      const data = await remote.readArtifactRange(runtime, row.path, row.size, offset, length, signal);
      if (data.byteLength !== length) throw new SpikeError("artifact_changed", "artifacts");
      requireActive(signal, "artifactMultipartPart");
      const part = await io("artifactMultipartPart", () => bucket.resumeMultipartUpload(row.object_key, row.upload_id!)
        .uploadPart(parts.length + 1, data), 5000);
      parts.push(part);
      await io("artifactMultipartProgress", () => store.uploadCheckpoint(row, row.upload_id!, parts, now()));
    } else {
      await io("artifactMultipartComplete", () => bucket.resumeMultipartUpload(row.object_key, row.upload_id!).complete(parts), 5000);
    }
    settled = true;
    return 1;
  } finally {
    // A timed-out R2 operation can still finish. Keep its lease until expiry.
    if (settled && !signal.aborted) await io("artifactUploadRelease", () => store.releaseUpload(row));
  }
}

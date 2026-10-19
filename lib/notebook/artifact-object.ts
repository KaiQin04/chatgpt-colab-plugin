/** R2 integrity checks for checksum-bearing puts and verified multipart versions. */
import { boundedStep } from "../platform/deadline.ts";
import { SpikeError } from "../platform/security.ts";
import type { ArtifactRow } from "./types.ts";
import { artifactVerificationMs } from "./policy.ts";

export const hex = (data: ArrayBuffer) => [...new Uint8Array(data)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function matchesArtifact(object: R2Object | null, row: ArtifactRow): boolean {
  return !!object && object.size === row.size && (row.storage_version
    ? object.version === row.storage_version
    : !!object.checksums.sha256 && hex(object.checksums.sha256) === row.sha256);
}

/** Consume a single stream with backpressure. Never tee or buffer the whole file. */
export async function verifyMultipart(bucket: R2Bucket, row: ArtifactRow, signal: AbortSignal): Promise<string> {
  return boundedStep("artifactVerify", artifactVerificationMs(row.size), signal, async (stepSignal) => {
    const object = await bucket.get(row.object_key);
    if (!object || object.size !== row.size || !object.version) {
      await object?.body.cancel(); throw new SpikeError("artifact_storage_readback_mismatch", "artifacts");
    }
    const digest = new (crypto as Crypto & { DigestStream: typeof DigestStream }).DigestStream("SHA-256");
    // Observe rejection immediately, including cancellation before digest is awaited.
    const result = digest.digest.then((value) => ({ value }), () => ({ value: null }));
    let bytes = 0;
    const counted = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > row.size) throw new SpikeError("artifact_storage_readback_mismatch", "artifacts");
      controller.enqueue(chunk);
    } });
    await object.body.pipeThrough(counted).pipeTo(digest, { signal: stepSignal });
    const { value } = await result;
    if (!value || bytes !== row.size || hex(value) !== row.sha256) {
      throw new SpikeError("artifact_storage_readback_mismatch", "artifacts");
    }
    return object.version;
  });
}

/** Abort is idempotent, including a previously completed multipart upload. */
export async function deleteArtifactObject(bucket: R2Bucket, row: ArtifactRow): Promise<void> {
  if (row.upload_lease_expires_at > Date.now()) throw new SpikeError("artifact_upload_busy", "artifacts", 409);
  if (row.upload_id) await bucket.resumeMultipartUpload(row.object_key, row.upload_id).abort();
  await bucket.delete(row.object_key);
}

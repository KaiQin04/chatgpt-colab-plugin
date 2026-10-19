/** Private Sites service access plus an owner-issued, purpose-bound artifact grant.
 * Dispatch consumes the service credential; it need not supply browser identity.
 * This route never enrolls an owner, lists files, redirects, or contacts Colab.
 */
import { SITE_ORIGIN } from "../platform/config.ts";
import type { SpikeEnv } from "../platform/config.ts";
import { boundedStep } from "../platform/deadline.ts";
import { dispatchIdentity, safeError, SpikeError } from "../platform/security.ts";
import { ArtifactStore, MACHINE_DOWNLOAD_HEADER } from "./artifact-store.ts";
import { matchesArtifact } from "./artifact-object.ts";

/** A single byte range keeps resumable transfers bounded and avoids multipart responses. */
function byteRange(value: string, size: number): { offset: number; length: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match && (match[1] || match[2]) && size > 0) {
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if ([match[1], match[2]].every((part) => !part || Number.isSafeInteger(Number(part))) &&
      start >= 0 && start <= end && start < size && (match[1] || Number(match[2]) > 0)) {
      return { offset: start, length: end - start + 1 };
    }
  }
  throw new SpikeError("download_range_invalid", "download", 416);
}

export async function machineArtifactDownload(request: Request, env: SpikeEnv, id: string): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'", "Referrer-Policy": "no-referrer" });
  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("Allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  try {
    const url = new URL(request.url);
    if (env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED !== "true" || url.origin !== SITE_ORIGIN || !env.DB) {
      throw new SpikeError("private_service_boundary_required", "download", 403);
    }
    if (url.search || (request.headers.has("Origin") && request.headers.get("Origin") !== SITE_ORIGIN) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site") {
      throw new SpikeError("download_request_forbidden", "download", 403);
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
      throw new SpikeError("download_token_expired_or_invalid", "download", 403);
    }
    const owner = await boundedStep("downloadExistingOwner", 2000, request.signal,
      () => env.DB!.prepare("SELECT owner_id FROM site_owner WHERE singleton=1").first<{ owner_id: string }>());
    if (!owner) throw new SpikeError("download_owner_not_enrolled", "download", 403);
    if (request.headers.has("oai-authenticated-user-id") || request.headers.has("oai-authenticated-user-email")) {
      if (dispatchIdentity(request.headers).userId !== owner.owner_id) throw new SpikeError("owner_required", "download", 403);
    }
    const row = await boundedStep("downloadMachineGrant", 2000, request.signal,
      () => new ArtifactStore(env, owner.owner_id).authorizeDownload(id,
        request.headers.get(MACHINE_DOWNLOAD_HEADER) ?? "", Date.now(), "machine"));
    if (!env.BUCKET) throw new SpikeError("artifact_bucket_missing", "download", 503);
    const etag = `"${row.sha256}"`;
    if (request.headers.has("If-Match") && request.headers.get("If-Match") !== etag) {
      throw new SpikeError("download_version_mismatch", "download", 412);
    }
    let range: { offset: number; length: number } | undefined;
    // HEAD ignores Range. A stale/weak/date If-Range falls back to the complete representation.
    if (request.method === "GET" && request.headers.has("Range") &&
      (!request.headers.has("If-Range") || request.headers.get("If-Range") === etag)) {
      try { range = byteRange(request.headers.get("Range")!, row.size); }
      catch (error) { headers.set("Content-Range", `bytes */${row.size}`); throw error; }
    }
    const object = await boundedStep("downloadMachineObject", 5000, request.signal, () => request.method === "HEAD"
      ? env.BUCKET!.head(row.object_key) : env.BUCKET!.get(row.object_key, range ? { range } : undefined));
    if (!object || !matchesArtifact(object, row) ||
      (range && (!object.range || !("offset" in object.range) || !("length" in object.range) ||
        object.range.offset !== range.offset || object.range.length !== range.length))) {
      if (object && "body" in object) await (object as R2ObjectBody).body.cancel();
      throw new SpikeError("artifact_storage_readback_mismatch", "download", 502);
    }
    headers.set("Accept-Ranges", "bytes"); headers.set("ETag", etag);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(range?.length ?? row.size));
    const filename = row.path.split("/").at(-1)!.replace(/[\r\n"\\]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body,
      { status: range ? 206 : 200, headers });
  } catch (error) {
    const status = error instanceof SpikeError ? error.httpStatus ?? 400 : 500;
    return request.method === "HEAD" ? new Response(null, { status, headers })
      : Response.json({ error: safeError(error) }, { status, headers });
  }
}

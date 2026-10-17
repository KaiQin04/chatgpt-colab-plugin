/** A short opaque link never substitutes for the owner's verified visitor identity. */
import type { SpikeEnv } from "../platform/config.ts";
import { dispatchIdentity, safeError, SpikeError } from "../platform/security.ts";
import { boundedStep } from "../platform/deadline.ts";
import { Store } from "../platform/store.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { hex } from "./artifacts.ts";

export async function artifactDownload(request: Request, env: SpikeEnv, id: string): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'", "Referrer-Policy": "no-referrer" });
  try {
    const identity = dispatchIdentity(request.headers);
    await boundedStep("downloadOwner", 2000, request.signal, () => new Store(env).owner(identity));
    if (!/^[a-f0-9-]{36}$/.test(id) || !env.BUCKET) throw new SpikeError("artifact_not_found", "download", 404);
    const row = await boundedStep("downloadGrant", 2000, request.signal, () => new ArtifactStore(env, identity.userId)
      .authorizeDownload(id, new URL(request.url).searchParams.get("token") ?? "", Date.now()));
    await boundedStep("downloadActivity", 2000, request.signal, () => new ArtifactStore(env, identity.userId).notebooks.touch(row.notebook_id, Date.now()));
    const object = await boundedStep("downloadObject", 5000, request.signal, () => env.BUCKET!.get(row.object_key));
    if (!object || object.size !== row.size || !object.checksums.sha256 || hex(object.checksums.sha256) !== row.sha256) {
      throw new SpikeError("artifact_storage_readback_mismatch", "download", 502);
    }
    headers.set("Content-Type", "application/octet-stream"); headers.set("Content-Length", String(row.size));
    const filename = row.path.split("/").at(-1)!.replace(/[\r\n"\\]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return new Response(object.body, { headers });
  } catch (error) {
    return Response.json({ error: safeError(error) }, { status: error instanceof SpikeError ? error.httpStatus ?? 400 : 500, headers });
  }
}

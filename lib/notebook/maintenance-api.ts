/** Shared update endpoint protected by confirmed owner-private Sites dispatch.
 * Service access supplies no visitor identity. It can only maintain the existing
 * singleton owner; it cannot enroll an owner, submit code, change policy or download files.
 */
import { SITE_ORIGIN } from "../platform/config.ts";
import type { Fetcher, SpikeEnv } from "../platform/config.ts";
import { dispatchIdentity, safeError, SpikeError } from "../platform/security.ts";
import { maintenanceCall } from "./service.ts";
import { boundedStep } from "../platform/deadline.ts";

export async function maintenanceApi(request: Request, env: SpikeEnv, fetcher: Fetcher = fetch): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (request.method !== "POST") return new Response(null, { status: 405, headers });
  const origin = request.headers.get("Origin");
  if (origin && origin !== SITE_ORIGIN) return new Response(null, { status: 403, headers });
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return new Response(null, { status: 403, headers });
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return new Response(null, { status: 415, headers });
  try {
    if (env.OWNER_PRIVATE_DEPLOYMENT_CONFIRMED !== "true" || !env.DB) throw new SpikeError("private_service_boundary_required", "maintenance", 403);
    const raw = await request.text();
    if (raw.length > 32) throw new SpikeError("maintenance_arguments_forbidden", "maintenance", 400);
    const body = JSON.parse(raw);
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) {
      throw new SpikeError("maintenance_arguments_forbidden", "maintenance", 400);
    }
    const owner = await boundedStep("maintenanceOwner", 2000, request.signal,
      () => env.DB!.prepare("SELECT owner_id FROM site_owner WHERE singleton=1").first<{ owner_id: string }>());
    if (!owner) throw new SpikeError("maintenance_owner_not_enrolled", "maintenance", 403);
    if (request.headers.has("oai-authenticated-user-id") || request.headers.has("oai-authenticated-user-email")) {
      if (dispatchIdentity(request.headers).userId !== owner.owner_id) throw new SpikeError("owner_required", "maintenance", 403);
    }
    return Response.json(await maintenanceCall(env, owner.owner_id, { fetcher, signal: request.signal }), { headers });
  } catch (error) { return Response.json({ error: safeError(error) }, { status: 400, headers }); }
}

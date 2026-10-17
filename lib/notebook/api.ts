/** Same-origin JSON writes plus verified private dispatch identity; no CORS. */
import type { Fetcher, SpikeEnv } from "../platform/config.ts";
import { SITE_ORIGIN } from "../platform/config.ts";
import { dispatchIdentity, safeError } from "../platform/security.ts";
import { notebookCall } from "./service.ts";
import { validateNotebookArguments } from "./tools.ts";

export async function notebookApi(request: Request, env: SpikeEnv, fetcher: Fetcher = fetch): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  // Browser Origin is mandatory here. MCP has its own authenticated non-browser transport.
  const origin = request.headers.get("Origin");
  const urlOrigin = new URL(request.url).origin;
  const local = /^http:\/\/(127\.0\.0\.1|localhost):(3000|5173)$/.test(urlOrigin);
  if (!origin || (origin !== SITE_ORIGIN && !(local && origin === urlOrigin))) return new Response(null, { status: 403, headers });
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return new Response(null, { status: 403, headers });
  if (request.method !== "POST") return new Response(null, { status: 405, headers });
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return new Response(null, { status: 415, headers });
  try {
    const identity = dispatchIdentity(request.headers);
    const raw = await request.text();
    if (raw.length > 65_536) return new Response(null, { status: 413, headers });
    const body = JSON.parse(raw);
    const args = validateNotebookArguments(body.name, body.arguments);
    const value = await notebookCall(body.name, args, env, identity, { fetcher, signal: request.signal, actor: "user" });
    return Response.json(value, { headers });
  } catch (error) { return Response.json({ error: safeError(error) }, { headers }); }
}

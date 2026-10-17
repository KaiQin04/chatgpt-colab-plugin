/** Owner-authenticated HTTPS export for browsers that cannot download blob URLs. */
import type { Fetcher, SpikeEnv } from "../platform/config.ts";
import { dispatchIdentity, safeError, SpikeError } from "../platform/security.ts";
import { notebookCall } from "./service.ts";
import { validateNotebookArguments } from "./tools.ts";

export async function notebookExportDownload(request: Request, env: SpikeEnv, id: string,
  fetcher: Fetcher = fetch): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'", "Referrer-Policy": "no-referrer" });
  if (request.method !== "GET") return new Response(null, { status: 405, headers });
  try {
    const identity = dispatchIdentity(request.headers);
    const args = validateNotebookArguments("export_ipynb", { notebookId: id });
    const result = await notebookCall("export_ipynb", args, env, identity,
      { fetcher, signal: request.signal, actor: "user" });
    const body = JSON.stringify(result.ipynb, null, 1);
    headers.set("Content-Type", "application/x-ipynb+json; charset=utf-8");
    headers.set("Content-Disposition", `attachment; filename="notebook.ipynb"; filename*=UTF-8''${encodeURIComponent(String(result.filename))}`);
    headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
    return new Response(body, { headers });
  } catch (error) {
    return Response.json({ error: safeError(error) }, {
      status: error instanceof SpikeError ? error.httpStatus ?? 400 : 500, headers,
    });
  }
}

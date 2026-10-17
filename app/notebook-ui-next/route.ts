import { env } from "cloudflare:workers";
import { htmlResponse, notebookUiHtml } from "../../lib/notebook/ui.ts";
import { dispatchIdentity, safeError } from "../../lib/platform/security.ts";
import { Store } from "../../lib/platform/store.ts";

export const dynamic = "force-dynamic";
/** Owner-only preview of the bundled notebook UI; the legacy editor stays at /notebook-ui. */
export async function GET(request: Request): Promise<Response> {
  try {
    await new Store(env).owner(dispatchIdentity(request.headers));
    return htmlResponse(notebookUiHtml("site"));
  } catch (error) { return Response.json({ error: safeError(error) }, { status: 403 }); }
}

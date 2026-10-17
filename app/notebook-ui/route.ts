import { env } from "cloudflare:workers";
import { editorHtml } from "../../lib/notebook/editor.ts";
import { htmlResponse } from "../../lib/notebook/ui.ts";
import { dispatchIdentity, safeError } from "../../lib/platform/security.ts";
import { Store } from "../../lib/platform/store.ts";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    await new Store(env).owner(dispatchIdentity(request.headers));
    return htmlResponse(editorHtml("site"));
  } catch (error) { return Response.json({ error: safeError(error) }, { status: 403 }); }
}

import { env } from "cloudflare:workers";
import { oauthCallback, oauthFailure } from "../../../../lib/platform/oauth.ts";
import { dispatchIdentity } from "../../../../lib/platform/security.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try { return await oauthCallback(request, env, dispatchIdentity(request.headers)); }
  catch (error) { return oauthFailure(error); }
}

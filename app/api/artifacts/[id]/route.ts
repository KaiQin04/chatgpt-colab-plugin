import { env } from "cloudflare:workers";
import { artifactDownload } from "../../../../lib/notebook/download.ts";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return artifactDownload(request, env, (await context.params).id);
}

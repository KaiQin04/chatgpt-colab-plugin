import { env } from "cloudflare:workers";
import { machineArtifactDownload } from "../../../../../lib/notebook/machine-download.ts";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return machineArtifactDownload(request, env, (await context.params).id);
}
export const HEAD = GET;

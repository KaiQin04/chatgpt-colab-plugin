import { env } from "cloudflare:workers";
import { notebookExportDownload } from "../../../../../lib/notebook/export-download.ts";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return notebookExportDownload(request, env, (await context.params).id);
}

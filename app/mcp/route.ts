import { env } from "cloudflare:workers";
import { mcpPost } from "../../lib/mcp/transport.ts";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return mcpPost(request, env);
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

import { env } from "cloudflare:workers";
import { notebookApi } from "../../../lib/notebook/api.ts";

export const dynamic = "force-dynamic";
export const POST = (request: Request) => notebookApi(request, env);

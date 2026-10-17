import { env } from "cloudflare:workers";
import { maintenanceApi } from "../../../lib/notebook/maintenance-api.ts";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => maintenanceApi(request, env);

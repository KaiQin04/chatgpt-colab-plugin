/** Stateless MCP endpoint (JSON-RPC over Streamable HTTP, JSON responses). */
import { SITE_ORIGIN } from "../platform/config.ts";
import type { Fetcher, SpikeEnv } from "../platform/config.ts";
import { dispatchIdentity, safeError } from "../platform/security.ts";
import { PANEL_HTML, PANEL_MIME, PANEL_URI } from "../notebook/panel.ts";
import { callTool, TOOLS } from "./registry.ts";

// MCP 2026-07-28 requires cache hints on discovery/list/read results.
// Keep resources fresh and scoped to the caller, including during UI updates.
const COMPLETE_CACHE = { resultType: "complete", ttlMs: 0, cacheScope: "private" } as const;

function result(value: Record<string, unknown>, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value, ...(isError ? { isError: true } : {}) };
}

export async function mcpPost(
  request: Request, env: SpikeEnv, fetcher: Fetcher = fetch,
): Promise<Response> {
  const responseHeaders = { "Cache-Control": "no-store" };
  const origin = request.headers.get("Origin");
  if (origin && origin !== SITE_ORIGIN) return new Response(null, { status: 403 });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return new Response(null, { status: 415 });
  }
  let message: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 65_536) return new Response(null, { status: 413 });
    message = JSON.parse(raw);
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" ||
      typeof message.method !== "string") throw new Error();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null,
      error: { code: -32700, message: "Parse error" } }, { headers: responseHeaders });
  }
  const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
  const reply = (value: unknown) => Response.json({ jsonrpc: "2.0", id, result: value },
    { headers: responseHeaders });
  const params = message.params && typeof message.params === "object"
    ? message.params as Record<string, unknown> : {};
  // Platform metadata discovery has no account data and need not enroll the owner.
  if (message.method === "server/discover") {
    return reply({ ...COMPLETE_CACHE, supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } });
  }
  if (message.method === "initialize") {
    return reply({ protocolVersion: "2025-11-25", serverInfo: { name: "chatgpt-colab-plugin", version: "0.1.0" },
      capabilities: { tools: {}, resources: {} } });
  }
  if (message.method.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (message.method === "tools/list") return reply({ ...COMPLETE_CACHE, tools: TOOLS });
  if (message.method === "resources/list") {
    return reply({ ...COMPLETE_CACHE, resources: [{ uri: PANEL_URI, name: "Colab Notebook", mimeType: PANEL_MIME }] });
  }
  if (message.method === "resources/read") {
    if (params.uri !== PANEL_URI) {
      return Response.json({ jsonrpc: "2.0", id,
        error: { code: -32602, message: "Resource not found" } }, { headers: responseHeaders });
    }
    // Static template only: no owner enrollment, cached status or Google grant.
    return reply({ ...COMPLETE_CACHE, contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: PANEL_HTML,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" },
        // openExternal (artifact downloads, re-authorization) may only target the Site itself.
        "openai/widgetCSP": { connect_domains: [], resource_domains: [], redirect_domains: [SITE_ORIGIN] } } }] });
  }
  if (message.method !== "tools/call") {
    return Response.json({ jsonrpc: "2.0", id,
      error: { code: -32601, message: "Method not found" } }, { headers: responseHeaders });
  }
  try {
    const identity = dispatchIdentity(request.headers);
    const { value, isError } = await callTool(params.name, params.arguments, env, identity, {
      fetcher, signal: request.signal,
    });
    return reply(result(value, isError));
  } catch (error) {
    return reply(result({ error: safeError(error) }, true));
  }
}

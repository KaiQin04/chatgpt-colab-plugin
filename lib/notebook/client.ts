/**
 * Notebook UI transport. The same UI runs in two hosts:
 *  - the private Site page, which POSTs to /api/notebooks (same origin);
 *  - the ChatGPT MCP Apps iframe, which calls tools through the host bridge.
 * Behaviour mirrors the legacy editor (lib/notebook/editor.ts): 55 s request
 * budget, fixed error codes, and only parent-window JSON-RPC messages.
 */
import type { NotebookToolName, ToolArgs } from "./contract.ts";

export type ToolResult = Record<string, unknown>;

export interface NotebookClient {
  readonly mode: "site" | "mcp";
  call<N extends NotebookToolName>(name: N, args: ToolArgs[N]): Promise<ToolResult>;
  /** Host-pushed tool results (MCP Apps only); returns an unsubscribe function. */
  onToolResult(listener: (value: ToolResult) => void): () => void;
  dispose(): void;
}

export const REQUEST_TIMEOUT_MS = 55_000;
export const MCP_APPS_PROTOCOL = "2026-01-26";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createFetchClient(options: {
  endpoint?: string; fetch?: typeof fetch; timeoutMs?: number;
} = {}): NotebookClient {
  const endpoint = options.endpoint ?? "/api/notebooks";
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const inflight = new Set<AbortController>();
  return {
    mode: "site",
    async call(name, args) {
      const controller = new AbortController();
      inflight.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await send(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          credentials: "same-origin", body: JSON.stringify({ name, arguments: args }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const value: unknown = await response.json();
        if (!isObject(value)) throw new Error("invalid_site_result");
        return value;
      } finally {
        clearTimeout(timer);
        inflight.delete(controller);
      }
    },
    onToolResult() { return () => {}; },
    dispose() { inflight.forEach((controller) => controller.abort()); inflight.clear(); },
  };
}

/** The window-like surface the bridge needs; injectable for tests. */
export interface BridgeHost {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: { source: unknown; data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { source: unknown; data: unknown }) => void): void;
}

export async function createBridgeClient(options: {
  host: BridgeHost; appInfo: { name: string; version: string }; timeoutMs?: number;
}): Promise<NotebookClient> {
  const { host } = options;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const listeners = new Set<(value: ToolResult) => void>();
  let next = 0;

  const onMessage = (event: { source: unknown; data: unknown }) => {
    if (event.source !== host.parent) return;
    const data = event.data;
    if (!isObject(data) || data.jsonrpc !== "2.0") return;
    if (data.method === "ui/notifications/tool-result") {
      const params = isObject(data.params) ? data.params : {};
      if (isObject(params.structuredContent)) {
        const value = params.structuredContent;
        listeners.forEach((listener) => listener(value));
      }
      return;
    }
    if (typeof data.id !== "number") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error("bridge_error_unknown"));
    else entry.resolve(isObject(data.result) ? data.result : {});
  };
  host.addEventListener("message", onMessage);

  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("bridge_timeout_unknown"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      host.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });

  const dispose = () => {
    host.removeEventListener("message", onMessage);
    pending.forEach((entry) => { clearTimeout(entry.timer); entry.reject(new Error("page_closed")); });
    pending.clear();
    listeners.clear();
  };

  try {
    await request("ui/initialize", {
      appInfo: options.appInfo, appCapabilities: {}, protocolVersion: MCP_APPS_PROTOCOL,
    });
  } catch (error) {
    dispose();
    throw error;
  }
  host.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");

  return {
    mode: "mcp",
    async call(name, args) {
      const response = await request("tools/call", { name: name === "upsert_cell" || name === "run_cell" ? `ui_${name}` : name, arguments: args });
      if (!isObject(response.structuredContent)) throw new Error("invalid_host_result");
      return response.structuredContent;
    },
    onToolResult(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose,
  };
}

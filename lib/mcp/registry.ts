/** MCP tool registry: the notebook panel entrypoint plus the notebook tools. */
import type { Fetcher, Identity, SpikeEnv } from "../platform/config.ts";
import { SpikeError } from "../platform/security.ts";
import { Store } from "../platform/store.ts";
import { isFailure } from "../notebook/contract.ts";
import { PANEL_ICONS, PANEL_URI } from "../notebook/panel.ts";
import { notebookCall } from "../notebook/service.ts";
import { NOTEBOOK_TOOLS, validateNotebookArguments } from "../notebook/tools.ts";

const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Stable names are persisted by the installed private plugin.
export const PANEL_TOOL = {
  name: "colab_spike_panel", title: "Colab Notebook",
  icons: PANEL_ICONS,
  description: "Open the private notebook editor in the conversation or thread tab. Opening the panel only lists saved documents; CPU allocation requires the explicit Open CPU action.",
  inputSchema: EMPTY_SCHEMA, annotations: READ_ONLY,
  _meta: {
    ui: { resourceUri: PANEL_URI },
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
  },
} as const;

// UI-only aliases distinguish manual actions from model tool calls.
// This is display provenance, never an authentication or spending boundary.
const UI_TOOLS = NOTEBOOK_TOOLS.filter((tool) =>
  tool.name === "upsert_cell" || tool.name === "run_cell").map((tool) => ({
  ...tool, name: `ui_${tool.name}` as const,
  _meta: { ...tool._meta, ui: { ...tool._meta.ui, visibility: ["app"] } },
}));
export const TOOLS = [PANEL_TOOL, ...NOTEBOOK_TOOLS, ...UI_TOOLS] as const;

function panelArguments(args: unknown): void {
  if (args === undefined) return;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new SpikeError("invalid_tool_arguments", "mcp", 400);
  }
  if (Object.keys(args).length) throw new SpikeError("unexpected_tool_arguments", "mcp", 400);
}

/** Validate and run one tool for an already authenticated identity. */
export async function callTool(
  name: unknown, args: unknown, env: SpikeEnv, identity: Identity,
  options: { fetcher: Fetcher; signal?: AbortSignal },
): Promise<{ value: Record<string, unknown>; isError: boolean }> {
  if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name)) {
    throw new SpikeError("unknown_tool", "mcp", 400);
  }
  if (name === PANEL_TOOL.name) {
    panelArguments(args);
    await new Store(env).owner(identity);
    const value = await notebookCall("get_notebook", {}, env, identity, { fetcher: options.fetcher });
    return { value, isError: false };
  }
  const manual = UI_TOOLS.some((tool) => tool.name === name);
  const operation = manual ? name.slice(3) : name;
  const value = await notebookCall(operation, validateNotebookArguments(operation, args ?? {}), env, identity, {
    fetcher: options.fetcher, signal: options.signal, actor: manual ? "user" : "assistant",
  });
  return { value, isError: isFailure(value) };
}

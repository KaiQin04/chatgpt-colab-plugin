/** One schema/validation boundary shared by MCP and the same-origin editor API. */
import { SpikeError } from "../platform/security.ts";
import { MAX_CELL_SOURCE, MAX_CELLS, MAX_DETAIL_CELLS } from "./types.ts";
import { gpuIdentifier } from "./compute.ts";
import { validateInputFile } from "./inputs.ts";
import { packageList } from "./setup.ts";

const uuid = { type: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" };
const key = { type: "string", minLength: 8, maxLength: 96, pattern: "^[A-Za-z0-9_-]+$" };
const version = { type: "integer", minimum: 1 };
const index = { type: "integer", minimum: 0, maximum: MAX_CELLS };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const schema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object", properties, required, additionalProperties: false });
const both = { visibility: ["model", "app"] };
export const NOTEBOOK_TOOLS = [
  { name: "get_runtime_settings", title: "Read runtime package settings",
    description: "Read owner package defaults and settings version. Defaults: polars/lightgbm/duckdb/pyarrow/statsmodels/optuna. No runtime allocation or installation.",
    inputSchema: schema({}), annotations: readOnly, _meta: { ui: both } },
  { name: "set_runtime_settings", title: "Save package settings for future preparation",
    description: "Owner CAS settings: expectedVersion must match (0 initially). Up to 16 plain PyPI distribution names, no URLs/options/version specifiers. Applies to future runtime bootstrap or explicit packages preparation; does not mutate currently running jobs. Empty list disables package installs.",
    inputSchema: schema({ expectedVersion: { type: "integer", minimum: 0 }, packages: { type: "array", maxItems: 16,
      items: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" } } }, ["expectedVersion", "packages"]),
    annotations: write, _meta: { ui: both } },
  { name: "prepare_runtime", title: "Prepare packages or official Blender",
    description: "Queue one exclusive setup on an existing idle runtime, no allocation. target=packages checks distributions and installs only missing wheels from PyPI (300s installer timeout); target=blender installs the source-verified official Blender 5.2.2 Linux x64 binary, checksum verified. Never tries alternate versions/mirrors/bpy. get_notebook submits the reserved setup once, then reads progress/result/executable path in short requests. Same key never redispatches unknown work; a new key explicitly retries a terminal failure. Cell/import/setup cannot compete for the kernel.",
    inputSchema: schema({ notebookId: uuid, target: { type: "string", enum: ["packages", "blender"] }, idempotencyKey: key }, ["notebookId", "target", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "get_compute_status", title: "Read balance, available GPUs and open notebooks",
    description: "Read current Colab balance/rate, account-wide estimated hours at that rate, dynamic eligible GPUs and owner notebooks with observed machines and idle durations. Rate zero means unknown estimate. Negative balance warns but does not block allocation. Paginate open notebooks with nextAfterNotebookId; no server runtime cap or allocation queue. TPU is unsupported.",
    inputSchema: schema({ afterNotebookId: uuid }), annotations: { ...readOnly, openWorldHint: true }, _meta: { ui: both } },
  { name: "open_notebook", title: "Open a CPU or GPU notebook",
    description: "Create/reopen one notebook runtime and persistent Python kernel. compute defaults to CPU; specify an exact current eligible GPU or AUTO (GPU intent, priority L4/T4/A100/G4 then other eligible GPUs alphabetically). AUTO is a general default, not VRAM/workload inference; specify the required GPU for large workloads. Selection happens once before allocation; refusals never queue, fall back or allocate another machine. Uses Colab compute until close. No product-wide runtime cap; each notebook retains its own allocation/unknown lock. Reuse identical notebookId, compute and idempotencyKey for network retries. TPU unsupported.",
    inputSchema: schema({ notebookId: uuid, title: { type: "string", minLength: 1, maxLength: 120 }, idempotencyKey: key,
      compute: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Z][A-Z0-9_-]*$", default: "CPU" } }, ["notebookId", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "import_file", title: "Import a conversation attachment into notebook inputs",
    description: "Send one file's temporary download URL directly to the existing idle runtime. No allocation. Returns quickly after submission; get_notebook reads bytes/SHA-256/path and terminal errors. URL is transient, never stored in notebook source, D1, export or IPython history. HTTPS public destinations only; 128 MiB/file, 20s download deadline checks. Each import has a unique inputs/<importId>/<filename> path; never silently overwrites. Reuse key for uncertain ACK/retries; only a NEW key plus fresh URL retries a known terminal download error. Active cell/import blocks kernel competition. Inputs are ephemeral runtime files, not a persistent file library.",
    inputSchema: schema({ notebookId: uuid, idempotencyKey: key, file: { type: "object", properties: {
      download_url: { type: "string", maxLength: 8192 }, file_id: { type: "string", maxLength: 160 },
      mime_type: { type: "string", maxLength: 120 }, file_name: { type: "string", maxLength: 180 },
    }, required: ["download_url", "file_id"], additionalProperties: false } }, ["notebookId", "idempotencyKey", "file"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both, "openai/fileParams": ["file"] } },
  { name: "upsert_cell", title: "Save a notebook cell",
    description: "Save code or markdown without executing it. expectedVersion is this cell's current version (0 creates a new UUID cell); only that cell is compared, so other cells may change concurrently. A conflict never overwrites newer edits. New cells append at the end, or pass index with the notebook structureVersion to insert there. notebookVersion is accepted and ignored.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, kind: { type: "string", enum: ["code", "markdown"] },
      source: { type: "string", maxLength: MAX_CELL_SOURCE }, expectedVersion: { type: "integer", minimum: 0 },
      index, structureVersion: version, notebookVersion: version },
    ["notebookId", "cellId", "kind", "source", "expectedVersion"]), annotations: write, _meta: { ui: both } },
  { name: "move_cell", title: "Move a notebook cell",
    description: "Move a cell to toIndex (0-based position in the current order). Requires the notebook structureVersion from get_notebook; a stale value returns structure_version_conflict without changes.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, toIndex: index, structureVersion: version },
      ["notebookId", "cellId", "toIndex", "structureVersion"]), annotations: write, _meta: { ui: both } },
  { name: "delete_cell", title: "Delete a notebook cell",
    description: "Remove a cell from the document. Its run history and saved artifacts are kept (artifacts follow their retention). A running cell cannot be deleted; interrupt it first. Requires the notebook structureVersion.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, structureVersion: version },
      ["notebookId", "cellId", "structureVersion"]), annotations: destructive, _meta: { ui: both } },
  { name: "run_cell", title: "Submit a saved code cell",
    description: "Submit the saved cellVersion once and return quickly. Reuse idempotencyKey on a retry; a NEW key deliberately runs again after the previous run finishes. ACK unknown is retained, never redispatched. Poll get_notebook for capped outputs. Code and run actor/time are retained. No stdin or Google/Drive auth responses.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, cellVersion: version, idempotencyKey: key }, ["notebookId", "cellId", "cellVersion", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "get_notebook", title: "Read notebook and execution progress",
    description: "Without notebookId, list the latest 30 owner documents and latest maintenance readback. With notebookId, poll cells/inputs/setup, persist results and checkpoint output artifacts to R2 in a short request. A reserved pending setup may dispatch its predefined package/Blender installer exactly once. Optional runId reads an earlier snapshot. No runtime allocation or user-cell dispatch.",
    inputSchema: schema({ notebookId: uuid, runId: uuid, view: { type: "string", enum: ["auto", "outline", "full"] },
      cellIds: { type: "array", maxItems: MAX_DETAIL_CELLS, items: uuid } }), annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "interrupt_cell", title: "Interrupt the active cell",
    description: "Ask the existing kernel to interrupt. This is a request, not proof of terminal status; poll get_notebook. Does not close the runtime or erase output.",
    inputSchema: schema({ notebookId: uuid }, ["notebookId"]), annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "close_notebook", title: "Save results and release notebook runtime",
    description: "Block new runs, save terminal output and artifact files, release only this notebook's runtime, and confirm it is absent from assignments. If results/artifacts cannot be saved, retain the runtime for rescue. Set discardOutputs=true only when explicitly accepting loss of unsaved results/artifacts. Unknown release retains this notebook's lock and can be retried.",
    inputSchema: schema({ notebookId: uuid, discardOutputs: { type: "boolean", default: false } }, ["notebookId"]),
    annotations: { ...write, destructiveHint: true, openWorldHint: true }, _meta: { ui: both } },
  { name: "export_ipynb", title: "Export saved notebook",
    description: "Export bounded nbformat 4.5 JSON. Only outputs from the currently saved cell version are attached. Run snapshots remain in D1. Poll first to save the newest remote output. No allocation.",
    inputSchema: schema({ notebookId: uuid }, ["notebookId"]), annotations: write, _meta: { ui: both } },
  { name: "rename_notebook", title: "Rename a notebook",
    description: "Change a notebook title. The latest rename wins; cell versions are unaffected.",
    inputSchema: schema({ notebookId: uuid, title: { type: "string", minLength: 1, maxLength: 120 } }, ["notebookId", "title"]),
    annotations: write, _meta: { ui: both } },
  { name: "delete_notebook", title: "Delete a notebook and all its artifacts",
    description: "Permanently delete a closed notebook: document, cells, run history and every artifact including permanent ones. Close the runtime first. confirmArtifactCount must equal the notebook's current artifact count; otherwise nothing is deleted and the response lists what would be removed (cells, runs, artifacts, bytes, permanent artifacts). dryRun=true always returns that preview. Cannot be undone.",
    inputSchema: schema({ notebookId: uuid, confirmArtifactCount: { type: "integer", minimum: 0 }, dryRun: { type: "boolean" } },
      ["notebookId", "confirmArtifactCount"]),
    annotations: destructive, _meta: { ui: both } },
  { name: "get_artifacts", title: "Save and list notebook artifacts",
    description: "Checkpoint one pending output file then list owner artifacts. Only the terminal run manifest under /content/<notebookId>/outputs is eligible. Hard limits: 16 MiB/file, 128 MiB/run, 32 files; blocked files prevent automatic release. Optional path filters this manifest. artifactId returns one five-minute owner-auth download link and a bounded safe image preview.",
    inputSchema: schema({ notebookId: uuid, runId: uuid, artifactId: uuid, beforeId: uuid, path: { type: "string", minLength: 1, maxLength: 240 } }, ["notebookId"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "pin_artifact", title: "Keep or unpin an artifact",
    description: "Pin an owner artifact permanently or return it to its original 30-day retention. Expired/retiring files cannot be rescued by racing pin. Updates user activity.",
    inputSchema: schema({ artifactId: uuid, permanent: { type: "boolean" } }, ["artifactId", "permanent"]),
    annotations: write, _meta: { ui: both } },
  { name: "maintain_notebooks", title: "Maintain saved outputs and idle runtimes",
    description: "Owner-only short maintenance with a durable fair scan cursor: progress reserved predefined setup, poll active work, checkpoint outputs, release at most one runtime only after results/artifacts are saved and fixed CPU 5h/GPU 2h idle policy is due, retire unpinned artifacts after 30 days. Repeat only when ok and actionablePending>0; runningCount alone is not actionable. Hourly cloud scheduling configured separately. Never allocate, dispatch user cells, change clocks or force discard.",
    inputSchema: schema({}), annotations: { ...write, destructiveHint: true, openWorldHint: true }, _meta: { ui: both } },
] as const;

export function validateNotebookArguments(name: string, args: unknown): Record<string, unknown> {
  const tool = NOTEBOOK_TOOLS.find((item) => item.name === name);
  if (!tool || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new SpikeError("invalid_notebook_arguments", "notebook", 400);
  }
  const values = args as Record<string, unknown>;
  const definition = tool.inputSchema;
  for (const required of definition.required) {
    if (!Object.hasOwn(values, required)) throw new SpikeError("missing_notebook_argument", "notebook", 400);
  }
  for (const [field, value] of Object.entries(values)) {
    const raw = definition.properties[field] as Record<string, unknown> | undefined;
    if (!raw) throw new SpikeError("unexpected_notebook_argument", "notebook", 400);
    const valid = raw.type === "string"
      ? typeof value === "string" && value.length >= (Number(raw.minLength) || 0) &&
        value.length <= (Number(raw.maxLength) || 1000) && (!raw.pattern || new RegExp(String(raw.pattern)).test(value)) &&
        (!raw.enum || (raw.enum as string[]).includes(value))
      : raw.type === "integer" ? Number.isSafeInteger(value) && Number(value) >= Number(raw.minimum) &&
        (raw.maximum === undefined || Number(value) <= Number(raw.maximum))
      : raw.type === "object" && field === "file" ? Boolean(validateInputFile(value))
      : raw.type === "array" && field === "packages" ? Boolean(packageList(value))
      : raw.type === "array" && field === "cellIds" ? Array.isArray(value) && value.length <= MAX_DETAIL_CELLS &&
        value.every((item) => typeof item === "string" && new RegExp(uuid.pattern).test(item))
      : raw.type === "boolean" && typeof value === "boolean";
    if (!valid) throw new SpikeError("invalid_notebook_argument_value", "notebook", 400);
  }
  if (values.runId && !values.notebookId) throw new SpikeError("run_requires_notebook_id", "notebook", 400);
  if (values.compute && values.compute !== "CPU" && values.compute !== "AUTO" && !gpuIdentifier(values.compute)) {
    throw new SpikeError("unsupported_compute", "notebook", 400);
  }
  return values;
}

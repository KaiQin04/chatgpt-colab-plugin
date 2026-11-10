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
    description: "Reads the owner's default packages and settings version. Defaults: polars, lightgbm, duckdb, pyarrow, statsmodels and optuna. Does not allocate compute or install packages.",
    inputSchema: schema({}), annotations: readOnly, _meta: { ui: both } },
  { name: "set_runtime_settings", title: "Save package settings for future preparation",
    description: "Saves default packages for future runtime preparation. Requires expectedVersion (initially 0). Accepts up to 16 plain PyPI distribution names; an empty list disables default installs. Existing jobs keep their current environment. Custom install commands can run through run_cell.",
    inputSchema: schema({ expectedVersion: { type: "integer", minimum: 0 }, packages: { type: "array", maxItems: 16,
      items: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$" } } }, ["expectedVersion", "packages"]),
    annotations: write, _meta: { ui: both } },
  { name: "prepare_runtime", title: "Prepare packages or official Blender",
    description: "Prepares packages or Blender on an existing idle runtime. The package installer checks distributions and installs missing PyPI wheels (300-second timeout). The Blender installer uses the checksum-verified official Blender 5.2.2 Linux x64 binary. get_notebook advances setup and reads the result. A repeated idempotencyKey returns the existing attempt; a fresh key starts another attempt after a terminal result. Setup, imports and cells share the kernel. Custom installs can run through run_cell.",
    inputSchema: schema({ notebookId: uuid, target: { type: "string", enum: ["packages", "blender"] }, idempotencyKey: key }, ["notebookId", "target", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "get_compute_status", title: "Read balance, available GPUs and open notebooks",
    description: "Reads Colab balance, consumption rate, estimated account hours, eligible GPUs and owner notebooks with observed machines and idle durations. ownerRuntimeCount is provider-confirmed, or null if unknown. ownerRuntimeUnknownCount counts unresolved local records. Repeated complete absence from the provider reconciles external termination. A zero rate gives an unknown estimate. A negative balance is reported but does not block allocation. nextAfterNotebookId paginates notebooks. The plugin has no runtime cap or allocation queue.",
    inputSchema: schema({ afterNotebookId: uuid }), annotations: { ...readOnly, openWorldHint: true }, _meta: { ui: both } },
  { name: "open_notebook", title: "Open a CPU or GPU notebook",
    description: "Creates or reopens a notebook runtime with a persistent Python kernel. compute defaults to CPU; an exact eligible GPU name selects that model. AUTO selects one eligible GPU in priority order: L4, T4, A100, G4, then other models alphabetically. Each call makes one allocation attempt, subject to provider capacity and eligibility. Further calls can request additional allocations. Identical notebookId, compute and idempotencyKey return the original attempt. A new notebookId with a new idempotencyKey starts an independent allocation, including a replacement while another notebook's allocation is unknown. There is no cross-notebook lock, runtime cap or retry limit. Allocation GET and POST share a two-hour budget; caller cancellation or the host may end it sooner. get_notebook and get_compute_status report current observations. Compute is consumed until released. TPU is unsupported.",
    inputSchema: schema({ notebookId: uuid, title: { type: "string", minLength: 1, maxLength: 120 }, idempotencyKey: key,
      compute: { type: "string", minLength: 1, maxLength: 32, pattern: "^[A-Z][A-Z0-9_-]*$", default: "CPU" } }, ["notebookId", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "import_file", title: "Import a conversation attachment into notebook inputs",
    description: "Imports a file from a temporary public HTTPS URL into an existing idle runtime, up to 128 MiB per file with a 20-second download deadline. Each import writes inputs/<importId>/<filename> in the runtime's ephemeral filesystem. The URL is transient and excluded from saved source, D1, exports and IPython history. get_notebook reports bytes, SHA-256, destination path and errors. A repeated idempotencyKey reads the existing attempt; a fresh key and URL start another import after a terminal result. Imports and cells share the kernel.",
    inputSchema: schema({ notebookId: uuid, idempotencyKey: key, file: { type: "object", properties: {
      download_url: { type: "string", maxLength: 8192 }, file_id: { type: "string", maxLength: 160 },
      mime_type: { type: "string", maxLength: 120 }, file_name: { type: "string", maxLength: 180 },
    }, required: ["download_url", "file_id"], additionalProperties: false } }, ["notebookId", "idempotencyKey", "file"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both, "openai/fileParams": ["file"] } },
  { name: "upsert_cell", title: "Save a notebook cell",
    description: "Saves code or markdown without running it. expectedVersion checks this cell only; 0 creates a cell with a new UUID. A version conflict returns an error and preserves current edits. New cells are appended unless index and structureVersion specify a position. notebookVersion is accepted but ignored.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, kind: { type: "string", enum: ["code", "markdown"] },
      source: { type: "string", maxLength: MAX_CELL_SOURCE }, expectedVersion: { type: "integer", minimum: 0 },
      index, structureVersion: version, notebookVersion: version },
    ["notebookId", "cellId", "kind", "source", "expectedVersion"]), annotations: write, _meta: { ui: both } },
  { name: "move_cell", title: "Move a notebook cell",
    description: "Moves a cell to the zero-based toIndex in the current order. structureVersion identifies the notebook layout; a stale value returns structure_version_conflict and leaves the document unchanged.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, toIndex: index, structureVersion: version },
      ["notebookId", "cellId", "toIndex", "structureVersion"]), annotations: write, _meta: { ui: both } },
  { name: "delete_cell", title: "Delete a notebook cell",
    description: "Removes a cell from the document using the notebook's structureVersion. Run history and saved artifacts follow their retention policy. A running cell returns a conflict until execution ends or is interrupted.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, structureVersion: version },
      ["notebookId", "cellId", "structureVersion"]), annotations: destructive, _meta: { ui: both } },
  { name: "run_cell", title: "Submit a saved code cell",
    description: "Submits the saved cellVersion and returns promptly. A repeated idempotencyKey returns the existing run; a new key starts a separate run after active work finishes. An unknown acknowledgement stays recorded as unknown. get_notebook reads progress and bounded outputs. Code and actor/time provenance are saved. Interactive stdin and Google/Drive authentication prompts are not supported.",
    inputSchema: schema({ notebookId: uuid, cellId: uuid, cellVersion: version, idempotencyKey: key }, ["notebookId", "cellId", "cellVersion", "idempotencyKey"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "get_notebook", title: "Read notebook and execution progress",
    description: "Without notebookId, lists the latest 30 owner documents and a maintenance summary. With notebookId, reads execution, input and setup progress, saves results and checkpoints artifacts to R2. May dispatch an already reserved package or Blender setup once. runId selects an earlier snapshot. Does not allocate runtimes or run user cells.",
    inputSchema: schema({ notebookId: uuid, runId: uuid, view: { type: "string", enum: ["auto", "outline", "full"] },
      cellIds: { type: "array", maxItems: MAX_DETAIL_CELLS, items: uuid } }), annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "interrupt_cell", title: "Interrupt the active cell",
    description: "Requests an interrupt from the existing kernel. get_notebook reports the resulting execution state. The runtime and its outputs are retained.",
    inputSchema: schema({ notebookId: uuid }, ["notebookId"]), annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "close_notebook", title: "Save results and release notebook runtime",
    description: "Saves terminal results and artifacts, releases this notebook's runtime and checks provider assignments. If results are unsaved, returns a recovery response and keeps the runtime. discardOutputs=true accepts loss of unsaved output and unfinished setup/import work. Repeated complete provider absence can confirm external termination: saved data remains, unresolved work becomes incomplete and unsaved artifacts become blocked. An unconfirmed release stays recorded for a later close. Other notebooks are unaffected.",
    inputSchema: schema({ notebookId: uuid, discardOutputs: { type: "boolean", default: false } }, ["notebookId"]),
    annotations: { ...write, destructiveHint: true, openWorldHint: true }, _meta: { ui: both } },
  { name: "export_ipynb", title: "Export saved notebook",
    description: "Exports saved notebook data as bounded nbformat 4.5 JSON, attaching outputs that match each current cell version. Historical run snapshots remain in D1. Call get_notebook first to save the newest remote output. Does not allocate compute.",
    inputSchema: schema({ notebookId: uuid }, ["notebookId"]), annotations: write, _meta: { ui: both } },
  { name: "rename_notebook", title: "Rename a notebook",
    description: "Changes a notebook's title. The latest rename wins; cell versions are unaffected.",
    inputSchema: schema({ notebookId: uuid, title: { type: "string", minLength: 1, maxLength: 120 } }, ["notebookId", "title"]),
    annotations: write, _meta: { ui: both } },
  { name: "delete_notebook", title: "Delete a notebook and all its artifacts",
    description: "Permanently deletes a closed notebook with its cells, run history and all artifacts, including pinned files. confirmArtifactCount must match the current artifact count; a mismatch preserves the notebook and returns a preview of cell, run, artifact, byte and permanent-artifact counts. dryRun=true returns the same preview. Deletion is irreversible.",
    inputSchema: schema({ notebookId: uuid, confirmArtifactCount: { type: "integer", minimum: 0 }, dryRun: { type: "boolean" } },
      ["notebookId", "confirmArtifactCount"]),
    annotations: destructive, _meta: { ui: both } },
  { name: "get_artifacts", title: "Save and list notebook artifacts",
    description: "Checkpoints one pending output file or one 8 MiB multipart step, then lists owner artifacts. Progress includes uploadedBytes, totalBytes and uploading/verifying status. Full-file verification may take 200 seconds within a 240-second request budget. Further get_notebook or get_artifacts calls advance pending files. The terminal manifest under /content/<notebookId>/outputs allows 10 GiB per file, 40 GiB per run and 32 files. Blocked files keep the runtime. path filters the manifest. artifactId returns a five-minute owner browser link, a bounded image preview and a machineDownload grant. Machine downloads use the grant URL and headers plus this Site's OAI-Sites-Authorization service access, with exact-origin requests and size/SHA-256 verification. GET, HEAD and Range work without browser cookies. create_artifact_download renews a saved artifact's grant.",
    inputSchema: schema({ notebookId: uuid, runId: uuid, artifactId: uuid, beforeId: uuid, path: { type: "string", minLength: 1, maxLength: 240 } }, ["notebookId"]),
    annotations: { ...write, openWorldHint: true }, _meta: { ui: both } },
  { name: "create_artifact_download", title: "Authorize a machine download of one saved artifact",
    description: "Issues a five-minute download grant for a ready, fully hash-verified owner artifact in R2, up to 10 GiB. Requests authenticate with the returned grant header plus this Site's OAI-Sites-Authorization service access at the returned Site origin; browser cookies are not needed. Supports GET, HEAD and a single byte Range. Downloads can be verified against the returned size and SHA-256. A new call renews an expired grant. The grant covers only this artifact's machine download endpoint.",
    inputSchema: schema({ artifactId: uuid }, ["artifactId"]),
    annotations: { ...write, idempotentHint: false }, _meta: { ui: both } },
  { name: "pin_artifact", title: "Keep or unpin an artifact",
    description: "Pins an owner artifact permanently or restores its original 30-day retention. Expired or retiring files return an error. Updates notebook activity.",
    inputSchema: schema({ artifactId: uuid, permanent: { type: "boolean" } }, ["artifactId", "permanent"]),
    annotations: write, _meta: { ui: both } },
  { name: "maintain_notebooks", title: "Maintain saved outputs and idle runtimes",
    description: "Advances reserved setup, polls active work, checkpoints artifacts and scans owner notebooks with a durable cursor. Each call can release one idle runtime after its output is saved (CPU after 5 hours, GPU after 2 hours) and retire unpinned artifacts after 30 days. actionablePending reports work a later call can advance; runningCount reports active cells. Cloud scheduling is configured separately. Does not allocate runtimes, submit user cells or discard output.",
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

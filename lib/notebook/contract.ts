/**
 * Typed contract shared by the MCP registry, the same-origin browser API and
 * the notebook UI. These types describe the existing wire JSON; they do not
 * change it (tests/golden pins the shapes).
 */
import type { NOTEBOOK_TOOLS } from "./tools.ts";
import type { CellRow, NotebookState, RunResult, RunRow, RuntimeRow } from "./types.ts";

/** Output of platform/security.safeError. */
export type ErrorView = {
  code: string; stage: string; httpStatus?: number; upstreamCode?: string;
};

export type RunView = {
  id: string; cellId: string; cellVersion: number; state: RunRow["state"];
  actor: RunRow["actor"]; interruptRequested: boolean;
  artifactsState: RunRow["artifacts_state"]; artifactError: ErrorView | null;
  terminalAt: number | null; createdAt: number; updatedAt: number;
  result: RunResult | null; error: ErrorView | null;
  source?: string;
  /** Set when the document's output budget omitted this run's result. */
  outputsOmitted?: boolean;
};

export type RuntimeView = {
  id: string; state: RuntimeRow["state"]; released: boolean;
  requestedCompute: string; selectedAccelerator: string | null;
  machineKind: RuntimeRow["machine_kind"]; accelerator: string | null;
  computeVerified: boolean; createdAt: number; error: ErrorView | null;
  recoveryEndpoint?: string;
};

type CellBase = {
  id: string; kind: CellRow["kind"]; version: number; position: number;
  updatedBy: CellRow["updated_by"]; updatedAt: number;
};
export type FullCellView = CellBase & { source: string; lastRun: RunView | null; outline?: undefined };
export type RunSummaryView = {
  id: string; state: RunRow["state"]; artifactsState: RunRow["artifacts_state"];
  actor: RunRow["actor"]; terminalAt: number | null;
};
/** Large notebooks return outlines to the model; request cellIds for full cells. */
export type OutlineCellView = CellBase & {
  outline: true; sourceLength: number; preview: string; lineCount: number; lastRun: RunSummaryView | null;
};
export type CellView = FullCellView | OutlineCellView;

export type InputView = {
  id: string; fileId: string; filename: string; mimeType: string | null; state: string;
  bytes: number | null; sha256: string | null; path: string; currentRuntime: boolean;
  createdAt: number; finishedAt: number | null; error: ErrorView | null;
};

export type SetupView = {
  id: string; kind: string; state: string; createdAt: number; finishedAt: number | null;
  packages: string[]; result: Record<string, unknown> | null; error: ErrorView | null;
};

export type ArtifactView = {
  id: string; notebookId: string; runId: string; path: string; size: number;
  sha256: string; state: string; mediaType: string; permanent: boolean;
  savedAt: number | null; expiresAt: number | null;
  /** Present only when one ready artifact is requested by artifactId. */
  downloadUrl?: string; downloadExpiresAt?: number; previewDataUrl?: string | null;
};

export type IdleView = { milliseconds: number; source: "production"; since: number };

export type NotebookView = {
  id: string; title: string; version: number; state: NotebookState;
  createdAt: number; updatedAt: number; activeRunId: string | null;
  runtime: RuntimeView | null; activeInputId: string | null; activeSetupId: string | null;
  setupTasks: SetupView[]; inputs: InputView[]; inputsTruncated: boolean;
  workingDirectory: string; outputsDirectory: string;
  lastActivityAt: number; lastTerminalAt: number | null;
  idle?: IdleView; controlPending: boolean;
  structureVersion: number; view: "outline" | "full"; cells: CellView[];
};

export type DocumentView = { notebook: NotebookView; run?: RunView };

export type ComputeNotebookView = {
  id: string; title: string; state: NotebookState; activeRunId: string | null;
  idleSince: number; idleForMs: number | null;
  runtime: {
    id: string | null; state: RuntimeRow["state"]; released: boolean; requestedCompute: string;
    selectedAccelerator: string | null; machineKind: RuntimeRow["machine_kind"];
    accelerator: string | null; computeVerified: boolean; createdAt: number;
  };
};

/** Result fields that carry a failure; any truthy one marks the result failed. */
export const FAILURE_FIELDS = [
  "error", "pollError", "artifactError", "ledgerError", "cleanupError", "confirmationError",
] as const;

/** Single failure predicate for MCP `isError` and the UI. */
export function isFailure(value: Record<string, unknown>): boolean {
  return value.ok === false || value.released === false ||
    FAILURE_FIELDS.some((field) => Boolean(value[field]));
}

export type NotebookToolName = (typeof NOTEBOOK_TOOLS)[number]["name"];

type NotebookRef = { notebookId: string };
type Keyed = { idempotencyKey: string };

/** Arguments accepted by each notebook tool (mirrors tools.ts schemas). */
export type ToolArgs = {
  get_runtime_settings: Record<string, never>;
  set_runtime_settings: { expectedVersion: number; packages: string[] };
  prepare_runtime: NotebookRef & Keyed & { target: "packages" | "blender" };
  get_compute_status: { afterNotebookId?: string };
  open_notebook: NotebookRef & Keyed & { title?: string; compute?: string };
  import_file: NotebookRef & Keyed & {
    file: { download_url: string; file_id: string; mime_type?: string; file_name?: string };
  };
  upsert_cell: NotebookRef & {
    cellId: string; kind: CellRow["kind"]; source: string; expectedVersion: number;
    /** Insert position for a new cell; requires structureVersion. Omit to append. */
    index?: number; structureVersion?: number;
    /** Accepted for older clients and ignored. */
    notebookVersion?: number;
  };
  move_cell: NotebookRef & { cellId: string; toIndex: number; structureVersion: number };
  delete_cell: NotebookRef & { cellId: string; structureVersion: number };
  rename_notebook: NotebookRef & { title: string };
  delete_notebook: NotebookRef & { confirmArtifactCount: number; dryRun?: boolean };
  run_cell: NotebookRef & Keyed & { cellId: string; cellVersion: number };
  get_notebook: { notebookId?: string; runId?: string; view?: "auto" | "outline" | "full"; cellIds?: string[] };
  interrupt_cell: NotebookRef;
  close_notebook: NotebookRef & { discardOutputs?: boolean };
  export_ipynb: NotebookRef;
  get_artifacts: NotebookRef & { runId?: string; artifactId?: string; beforeId?: string; path?: string };
  pin_artifact: { artifactId: string; permanent: boolean };
  maintain_notebooks: Record<string, never>;
};

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Compile-time guard: every notebook tool has an argument type and vice versa. */
export type ToolArgsCoverage = Assert<Exact<keyof ToolArgs, NotebookToolName>>;

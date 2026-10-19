/** Typed wrappers over the notebook tools for the UI; failures become ApiError. */
import { isFailure } from "../../lib/notebook/contract.ts";
import type { ArtifactView, DocumentView, NotebookToolName, ToolArgs } from "../../lib/notebook/contract.ts";
import type { NotebookClient, ToolResult } from "../../lib/notebook/client.ts";
import { translate } from "./i18n.ts";
import type { Locale, Message } from "./i18n.ts";

export class ApiError extends Error {
  constructor(readonly code: string, readonly stage = "ui", readonly result?: ToolResult) {
    super(code);
  }
}

export function closeNeedsDiscard(error: unknown): boolean {
  return error instanceof ApiError && (error.result?.outputsPersisted === false ||
    ["runtime_setup_in_progress_or_unknown", "input_import_in_progress_or_unknown"].includes(error.code));
}

const FAILURE_KEYS = ["error", "pollError", "artifactError", "ledgerError", "cleanupError", "confirmationError"] as const;

function failureCode(result: ToolResult): { code: string; stage: string } {
  for (const key of FAILURE_KEYS) {
    const value = result[key];
    if (value && typeof value === "object" && "code" in value) {
      const failure = value as { code: unknown; stage?: unknown };
      return { code: String(failure.code), stage: String(failure.stage ?? key) };
    }
  }
  if (result.released === false) return { code: "release_unconfirmed", stage: "close" };
  return { code: "request_failed", stage: "ui" };
}

export type NotebookSummary = {
  id: string; title: string; version: number; state: string; activeRunId: string | null; updatedAt: number;
};
export type ComputeStatus = {
  currentBalance?: number; consumptionRateHourly?: number; estimatedHoursRemaining?: number | null;
  balanceWarning?: boolean; eligibleGpus?: string[] | null; ownerRuntimeCount?: number | null; assignmentCount?: number;
  ownerRuntimeUnknownCount?: number; runtimePresence?: "confirmed" | "unknown";
  runtimePresenceObservedAt?: number | null;
  observedAt?: string;
  notebooks?: { id: string; title: string; state: string; idleForMs: number | null;
    runtime: { accelerator: string | null; selectedAccelerator: string | null; computeVerified: boolean } }[];
};
export type DeletePreview = {
  deleted: boolean; requiresConfirmation?: boolean; notebookId: string; title: string; state?: string;
  cellCount?: number; runCount?: number; artifactCount: number; totalBytes: number; permanentCount: number;
};
export type Settings = { version: number; packages: string[] };

export class NotebookApi {
  constructor(readonly client: NotebookClient) {}

  /** Call a tool; a partial failure with a usable document is returned with `warning`. */
  async call<N extends NotebookToolName>(name: N, args: ToolArgs[N], allowPartial = false): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = await this.client.call(name, args);
    } catch (error) {
      throw new ApiError(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "request_failed_unknown");
    }
    if (isFailure(result)) {
      const { code, stage } = failureCode(result);
      if (allowPartial && (result.notebook || name === "get_compute_status")) return { ...result, warning: code };
      throw new ApiError(code, stage, result);
    }
    return result;
  }

  async list(): Promise<NotebookSummary[]> {
    const result = await this.call("get_notebook", {});
    return Array.isArray(result.notebooks) ? result.notebooks as NotebookSummary[] : [];
  }
  async document(notebookId: string, runId?: string): Promise<DocumentView & { warning?: string }> {
    return await this.call("get_notebook", { notebookId, view: "full", ...(runId ? { runId } : {}) }, true) as DocumentView & { warning?: string };
  }
  async compute(): Promise<ComputeStatus> {
    return await this.call("get_compute_status", {}, true) as ComputeStatus;
  }
  async open(args: ToolArgs["open_notebook"]): Promise<DocumentView> {
    return await this.call("open_notebook", args, true) as DocumentView;
  }
  async save(args: ToolArgs["upsert_cell"]): Promise<DocumentView & { savedCellId: string }> {
    return await this.call("upsert_cell", args) as DocumentView & { savedCellId: string };
  }
  async move(args: ToolArgs["move_cell"]): Promise<DocumentView> {
    return await this.call("move_cell", args) as DocumentView;
  }
  async remove(args: ToolArgs["delete_cell"]): Promise<DocumentView> {
    return await this.call("delete_cell", args) as DocumentView;
  }
  async run(args: ToolArgs["run_cell"]): Promise<ToolResult> {
    return await this.call("run_cell", args, true);
  }
  async interrupt(notebookId: string): Promise<ToolResult> {
    return await this.call("interrupt_cell", { notebookId }, true);
  }
  async close(notebookId: string, discardOutputs = false): Promise<ToolResult> {
    return await this.call("close_notebook", { notebookId, ...(discardOutputs ? { discardOutputs } : {}) });
  }
  async exportIpynb(notebookId: string): Promise<{ filename: string; ipynb: unknown }> {
    return await this.call("export_ipynb", { notebookId }) as { filename: string; ipynb: unknown };
  }
  async rename(notebookId: string, title: string): Promise<DocumentView> {
    return await this.call("rename_notebook", { notebookId, title }) as DocumentView;
  }
  async deletePreview(notebookId: string): Promise<DeletePreview> {
    return await this.call("delete_notebook", { notebookId, confirmArtifactCount: 0, dryRun: true }) as DeletePreview;
  }
  async deleteNotebook(notebookId: string, confirmArtifactCount: number): Promise<DeletePreview> {
    return await this.call("delete_notebook", { notebookId, confirmArtifactCount }) as DeletePreview;
  }
  async artifacts(notebookId: string): Promise<{ artifacts: ArtifactView[]; hasMore?: boolean }> {
    return await this.call("get_artifacts", { notebookId }, true) as unknown as { artifacts: ArtifactView[]; hasMore?: boolean };
  }
  async artifactLink(notebookId: string, artifactId: string): Promise<ArtifactView> {
    const result = await this.call("get_artifacts", { notebookId, artifactId });
    const rows = Array.isArray(result.artifacts) ? result.artifacts as ArtifactView[] : [];
    const row = rows.find((item) => item.id === artifactId);
    if (!row) throw new ApiError("artifact_not_found");
    return row;
  }
  async pin(artifactId: string, permanent: boolean): Promise<ArtifactView> {
    const result = await this.call("pin_artifact", { artifactId, permanent });
    return result.artifact as ArtifactView;
  }
  async settings(): Promise<Settings> {
    const result = await this.call("get_runtime_settings", {});
    return result.settings as Settings;
  }
  async saveSettings(expectedVersion: number, packages: string[]): Promise<Settings> {
    const result = await this.call("set_runtime_settings", { expectedVersion, packages });
    return result.settings as Settings;
  }
  async prepare(notebookId: string, target: "packages" | "blender"): Promise<ToolResult> {
    return await this.call("prepare_runtime", { notebookId, target, idempotencyKey: crypto.randomUUID() }, true);
  }
  async importFile(notebookId: string, file: ToolArgs["import_file"]["file"]): Promise<ToolResult> {
    return await this.call("import_file", { notebookId, idempotencyKey: crypto.randomUUID(), file }, true);
  }
}

const MESSAGES: Record<string, Message> = {
  version_conflict_or_document_limit: "This cell changed or the notebook size limit was reached",
  structure_version_conflict: "Notebook structure changed; reloaded",
  structure_version_required: "Structure version is missing",
  cell_running: "This cell is running; interrupt it first",
  cell_not_found: "Cell not found; it may have been deleted",
  cell_index_out_of_range: "Position is out of range",
  notebook_busy: "Notebook is busy; try again later",
  notebook_runtime_open: "Close the runtime before deleting",
  notebook_not_found: "Notebook not found",
  bridge_timeout_unknown: "Request timed out with an unknown result; refresh before trying again",
  request_failed_unknown: "Request did not complete; result is unknown",
  release_unconfirmed: "Runtime release is unconfirmed; refresh and try closing again",
};

/** Human-readable message for an error code; unknown codes are shown verbatim. */
export function describe(error: unknown, locale: Locale = "zh-TW"): string {
  if (error instanceof ApiError) return MESSAGES[error.code]
    ? translate(locale, MESSAGES[error.code]) : translate(locale, "Operation did not complete ({code})", { code: error.code });
  return translate(locale, "Operation did not complete");
}

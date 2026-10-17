/** Typed wrappers over the notebook tools for the UI; failures become ApiError. */
import { isFailure } from "../../lib/notebook/contract.ts";
import type { ArtifactView, DocumentView, NotebookToolName, ToolArgs } from "../../lib/notebook/contract.ts";
import type { NotebookClient, ToolResult } from "../../lib/notebook/client.ts";

export class ApiError extends Error {
  constructor(readonly code: string, readonly stage = "ui", readonly result?: ToolResult) {
    super(code);
  }
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
  balanceWarning?: boolean; eligibleGpus?: string[] | null; ownerRuntimeCount?: number; assignmentCount?: number;
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
      if (allowPartial && result.notebook) return { ...result, warning: code };
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
    return await this.call("get_compute_status", {}) as ComputeStatus;
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

const MESSAGES: Record<string, string> = {
  version_conflict_or_document_limit: "這一格已被修改，或 notebook 已達大小上限",
  structure_version_conflict: "notebook 結構剛被修改，已重新載入",
  structure_version_required: "缺少結構版本",
  cell_running: "這一格正在執行，請先中斷",
  cell_not_found: "找不到這一格，可能已被刪除",
  cell_index_out_of_range: "位置超出範圍",
  notebook_busy: "notebook 正在處理其他操作，請稍後再試",
  notebook_runtime_open: "請先關閉 runtime 再刪除",
  notebook_not_found: "找不到這本 notebook",
  bridge_timeout_unknown: "請求逾時，結果未確認；請重新整理後再操作",
  request_failed_unknown: "請求未完成，結果未確認",
  release_unconfirmed: "runtime 釋放未確認，請重新整理後再關閉一次",
};

/** Human-readable message for an error code; unknown codes are shown verbatim. */
export function describe(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? `操作未完成（${error.code}）`;
  return "操作未完成";
}

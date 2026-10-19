/** Bounded notebook documents and the persisted execution ledger. */
export const MAX_CELLS = 200;
export const MAX_CELL_SOURCE = 16_000;
export const MAX_NOTEBOOK_SOURCE = 400_000;
// Above either threshold, get_notebook(view=auto) returns an outline to the model.
export const OUTLINE_SOURCE_THRESHOLD = 60_000;
export const OUTLINE_CELL_THRESHOLD = 60;
export const MAX_DETAIL_CELLS = 40;
// PNG Base64 and text share this budget; text retains its smaller limit.
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_TEXT_OUTPUT_BYTES = 24_000;
// Allows sixfold text escaping and metadata, below D1's 2 MB row limit.
export const MAX_RESULT_BYTES = 768 * 1024;
export const MAX_RETURN_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_EXPORT_OUTPUT_BYTES = 8 * 1024 * 1024;
export const SHORT_REQUEST_MS = 30_000;
export const SUBMIT_ACK_MS = 8_000;

export type NotebookState = "closed" | "opening" | "open" | "preparing" | "importing" | "interrupting" | "closing" | "unknown" | "deleting";
export type RuntimeState = "opening" | "open" | "closed" | "unknown";
export type RunState = "dispatching" | "submitted" | "running" | "unknown" |
  "ok" | "error" | "interrupted" | "incomplete";
export const TERMINAL_RUNS = new Set<RunState>(["ok", "error", "interrupted", "incomplete"]);
export type Output = { output_type: "stream"; name: "stdout" | "stderr"; text: string } |
  { output_type: "display_data" | "execute_result"; data: Record<string, string>;
    metadata: Record<string, never>; execution_count?: number } |
  { output_type: "error"; ename: string; evalue: string; traceback: string[] };
export interface RunResult {
  protocol: 1; runId: string; status: "running" | "ok" | "error" | "interrupted";
  outputs: Output[]; truncated: boolean; startedAt: number; finishedAt: number | null;
  executionCount: number | null;
  artifacts?: ArtifactManifest;
}
export interface ArtifactManifest {
  files: { path: string; size: number; sha256: string }[];
  errors: { code: string; path?: string }[];
}
export interface ArtifactRow {
  id: string; owner_id: string; notebook_id: string; run_id: string; path: string;
  size: number; sha256: string; object_key: string; media_type: string;
  state: "pending" | "ready" | "deleting" | "expired";
  permanent: number; created_at: number; saved_at: number | null; expires_at: number | null;
  upload_id: string | null; uploaded_parts_json: string;
  upload_lease_token: string | null; upload_lease_expires_at: number;
  storage_version: string | null;
}
export interface NotebookRow {
  id: string; owner_id: string; title: string; version: number; structure_version: number; state: NotebookState;
  runtime_id: string | null; active_run_id: string | null;
  control_token: string | null;
  active_input_id: string | null;
  active_setup_id: string | null;
  last_activity_at: number; last_terminal_at: number | null;
  mutation_id: string | null; created_at: number; updated_at: number;
}
export interface CellRow {
  id: string; notebook_id: string; kind: "code" | "markdown"; source: string;
  version: number; position: number; updated_at: number; updated_by: "user" | "assistant";
}
export interface RuntimeRow {
  id: string; notebook_id: string; owner_id: string; request_key: string;
  state: RuntimeState; notebook_hash: string; endpoint: string | null;
  kernel_id: string | null; error_json: string | null; released: number;
  created_at: number; updated_at: number;
  accelerator: string;
  requested_compute: string; selected_accelerator: string | null;
  machine_kind: "CPU" | "GPU"; compute_verified: number;
  assignment_checked_at?: number | null;
  assignment_missing_since?: number | null;
}
export interface RunRow {
  id: string; notebook_id: string; runtime_id: string; cell_id: string; cell_version: number;
  request_key: string; source: string; actor: "user" | "assistant";
  state: RunState; result_json: string | null; error_json: string | null;
  interrupt_requested: number; created_at: number; updated_at: number;
  terminal_at: number | null; artifacts_state: "legacy" | "pending" | "saved" | "blocked" | "discarded";
  artifact_error_json: string | null;
  result_omitted?: number;
}

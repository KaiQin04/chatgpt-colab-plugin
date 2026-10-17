/** Server-owned policies. Clocks are injectable only through internal test options. */
import type { NotebookRow, RuntimeRow } from "./types.ts";

export const CPU_IDLE_MS = 5 * 60 * 60 * 1000;
export const GPU_IDLE_MS = 2 * 60 * 60 * 1000;
export const ARTIFACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
export const MAX_ARTIFACT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARTIFACT_RUN_BYTES = 128 * 1024 * 1024;
export const MAX_ARTIFACT_FILES = 32;
export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_ARCHIVE_FILES_PER_REQUEST = 1;

export function idlePolicy(runtime: RuntimeRow): number {
  return runtime.machine_kind === "GPU" ? GPU_IDLE_MS : CPU_IDLE_MS;
}
export function effectiveIdlePolicy(runtime: RuntimeRow): { milliseconds: number; source: "production" } {
  return { milliseconds: idlePolicy(runtime), source: "production" };
}
export function idleSince(notebook: Pick<NotebookRow, "last_activity_at" | "updated_at" | "last_terminal_at">,
  runtime: Pick<RuntimeRow, "created_at">): number {
  return Math.max(notebook.last_activity_at || notebook.updated_at,
    notebook.last_terminal_at ?? runtime.created_at);
}
export function idleDue(notebook: NotebookRow, runtime: RuntimeRow, now: number): boolean {
  return notebook.state === "open" && !notebook.active_run_id && !notebook.control_token &&
    ["CPU", "GPU"].includes(runtime.machine_kind) &&
    runtime.state === "open" && runtime.released === 0 &&
    now - idleSince(notebook, runtime) >= idlePolicy(runtime);
}

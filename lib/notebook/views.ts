/** Pure row-to-view mappers for the notebook wire contract. */
import type { ComputeNotebookView, RunView, RuntimeView } from "./contract.ts";
import { idleSince } from "./policy.ts";
import type { ComputeNotebookRow } from "./store.ts";
import type { RunRow, RuntimeRow } from "./types.ts";

export function runView(row: RunRow, includeSource = false): RunView {
  return { id: row.id, cellId: row.cell_id, cellVersion: row.cell_version, state: row.state,
    actor: row.actor, interruptRequested: row.interrupt_requested === 1,
    artifactsState: row.artifacts_state, artifactError: row.artifact_error_json ? JSON.parse(row.artifact_error_json) : null,
    terminalAt: row.terminal_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    ...(row.result_omitted ? { outputsOmitted: true } : {}),
    error: row.error_json ? JSON.parse(row.error_json) : null,
    ...(includeSource ? { source: row.source } : {}) };
}
export function runtimeView(row: RuntimeRow | null): RuntimeView | null {
  return row ? { id: row.id, state: row.state, released: row.released === 1,
    requestedCompute: row.requested_compute, selectedAccelerator: row.selected_accelerator,
    machineKind: row.machine_kind, accelerator: row.compute_verified === 1 ? row.accelerator : null,
    computeVerified: row.compute_verified === 1,
    createdAt: row.created_at, error: row.error_json ? JSON.parse(row.error_json) : null,
    ...(row.state === "unknown" && row.endpoint ? { recoveryEndpoint: row.endpoint } : {}) } : null;
}
export function computeNotebookView(row: ComputeNotebookRow, now: number): ComputeNotebookView {
  const since = idleSince(row, { created_at: row.runtime_created_at });
  return { id: row.id, title: row.title, state: row.state, activeRunId: row.active_run_id,
    idleSince: since, idleForMs: row.state === "open" && !row.active_run_id && !row.control_token ? Math.max(0, now - since) : null,
    runtime: { id: row.runtime_id, state: row.runtime_state, released: row.released === 1,
      requestedCompute: row.requested_compute, selectedAccelerator: row.selected_accelerator,
      machineKind: row.machine_kind, accelerator: row.compute_verified === 1 ? row.accelerator : null,
      computeVerified: row.compute_verified === 1, createdAt: row.runtime_created_at } };
}

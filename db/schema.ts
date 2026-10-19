import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const siteOwner = sqliteTable("site_owner", {
  singleton: integer("singleton").primaryKey(),
  ownerId: text("owner_id").notNull(),
});

export const oauthStates = sqliteTable("oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  ownerId: text("owner_id").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  nonce: text("nonce").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const googleGrants = sqliteTable("google_grants", {
  ownerId: text("owner_id").primaryKey(),
  googleSubject: text("google_subject").notNull(),
  maskedEmail: text("masked_email").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const latestStatus = sqliteTable("latest_status", {
  ownerId: text("owner_id").primaryKey(),
  resultJson: text("result_json").notNull(),
});

export const probeRuns = sqliteTable("probe_runs", {
  operationId: text("operation_id").primaryKey(),
  ownerId: text("owner_id").notNull().unique("probe_runs_owner_single_attempt"),
  notebookHash: text("notebook_hash").notNull(),
  endpoint: text("endpoint"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  released: integer("released").notNull().default(0),
  resultJson: text("result_json"),
});

export const operationLock = sqliteTable("operation_lock", {
  singleton: integer("singleton").primaryKey(),
  operationId: text("operation_id").notNull(),
});

export const waitDiagnostics = sqliteTable("wait_diagnostics", {
  diagnosticId: text("diagnostic_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  requestedSeconds: integer("requested_seconds").notNull(),
  transport: text("transport").notNull(),
  status: text("status").notNull(),
  startedAt: integer("started_at").notNull(),
  lastHeartbeatAt: integer("last_heartbeat_at"),
  heartbeatCount: integer("heartbeat_count").notNull().default(0),
  hasProgressToken: integer("has_progress_token").notNull().default(0),
  finishedAt: integer("finished_at"),
  elapsedMs: integer("elapsed_ms"),
  errorCode: text("error_code"),
});

export const notebooks = sqliteTable("notebooks", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  title: text("title").notNull(), version: integer("version").notNull(),
  structureVersion: integer("structure_version").notNull().default(1),
  state: text("state").notNull(), runtimeId: text("runtime_id"), activeRunId: text("active_run_id"),
  controlToken: text("control_token"),
  activeInputId: text("active_input_id"),
  activeSetupId: text("active_setup_id"),
  lastActivityAt: integer("last_activity_at").notNull().default(0),
  lastTerminalAt: integer("last_terminal_at"),
  mutationId: text("mutation_id"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [index("notebook_live_scan").on(table.ownerId, table.id)]);
export const notebookCells = sqliteTable("notebook_cells", {
  id: text("id").primaryKey(), notebookId: text("notebook_id").notNull(),
  kind: text("kind").notNull(), source: text("source").notNull(), version: integer("version").notNull(),
  position: integer("position").notNull(), updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").notNull().default("user"),
});
export const notebookRuntimes = sqliteTable("notebook_runtimes", {
  id: text("id").primaryKey(), notebookId: text("notebook_id").notNull(), ownerId: text("owner_id").notNull(),
  requestKey: text("request_key").notNull(), state: text("state").notNull(),
  notebookHash: text("notebook_hash").notNull(), endpoint: text("endpoint"), kernelId: text("kernel_id"),
  errorJson: text("error_json"), released: integer("released").notNull().default(0),
  accelerator: text("accelerator").notNull().default("CPU"),
  requestedCompute: text("requested_compute").notNull().default("CPU"),
  selectedAccelerator: text("selected_accelerator"),
  machineKind: text("machine_kind").notNull().default("CPU"),
  computeVerified: integer("compute_verified").notNull().default(0),
  assignmentCheckedAt: integer("assignment_checked_at"),
  assignmentMissingSince: integer("assignment_missing_since"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("notebook_open_idempotency").on(table.ownerId, table.requestKey),
  uniqueIndex("notebook_live_runtime").on(table.notebookId).where(sql`${table.released}=0`),
  index("notebook_runtime_ownership").on(table.ownerId, table.released)]);
export const notebookRuns = sqliteTable("notebook_runs", {
  id: text("id").primaryKey(), notebookId: text("notebook_id").notNull(), runtimeId: text("runtime_id").notNull(),
  cellId: text("cell_id").notNull(), cellVersion: integer("cell_version").notNull(),
  requestKey: text("request_key").notNull(), source: text("source").notNull(), actor: text("actor").notNull(),
  state: text("state").notNull(), resultJson: text("result_json"), errorJson: text("error_json"),
  interruptRequested: integer("interrupt_requested").notNull().default(0),
  terminalAt: integer("terminal_at"),
  artifactsState: text("artifacts_state").notNull().default("legacy"),
  artifactErrorJson: text("artifact_error_json"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, (table) => [uniqueIndex("notebook_run_idempotency").on(table.notebookId, table.requestKey)]);

export const notebookArtifacts = sqliteTable("notebook_artifacts", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), notebookId: text("notebook_id").notNull(),
  runId: text("run_id").notNull(), path: text("path").notNull(), size: integer("size").notNull(),
  sha256: text("sha256").notNull(), objectKey: text("object_key").notNull(), mediaType: text("media_type").notNull(),
  state: text("state").notNull(), permanent: integer("permanent").notNull().default(0),
  createdAt: integer("created_at").notNull(), savedAt: integer("saved_at"), expiresAt: integer("expires_at"),
  uploadId: text("upload_id"), uploadedPartsJson: text("uploaded_parts_json").notNull().default("[]"),
  uploadLeaseToken: text("upload_lease_token"), uploadLeaseExpiresAt: integer("upload_lease_expires_at").notNull().default(0),
  storageVersion: text("storage_version"),
}, (table) => [uniqueIndex("notebook_artifact_run_path").on(table.runId, table.path)]);
export const artifactDownloads = sqliteTable("artifact_downloads", {
  tokenHash: text("token_hash").primaryKey(), artifactId: text("artifact_id").notNull(),
  ownerId: text("owner_id").notNull(), expiresAt: integer("expires_at").notNull(),
});
export const maintenanceRuns = sqliteTable("maintenance_runs", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"), resultJson: text("result_json"),
});
export const maintenanceScan = sqliteTable("maintenance_scan", {
  ownerId: text("owner_id").primaryKey(), afterId: text("after_id").notNull().default(""),
  leaseToken: text("lease_token"), leaseExpiresAt: integer("lease_expires_at").notNull().default(0),
});
export const notebookInputs = sqliteTable("notebook_inputs", {
  id: text("id").primaryKey(), notebookId: text("notebook_id").notNull(), runtimeId: text("runtime_id").notNull(),
  requestKey: text("request_key").notNull(), fileId: text("file_id").notNull(), fileName: text("file_name").notNull(),
  mimeType: text("mime_type"), state: text("state").notNull(), size: integer("size"), sha256: text("sha256"),
  errorJson: text("error_json"), createdAt: integer("created_at").notNull(), finishedAt: integer("finished_at"),
}, (table) => [uniqueIndex("notebook_input_idempotency").on(table.notebookId, table.requestKey)]);
export const runtimeSettings = sqliteTable("runtime_settings", {
  ownerId: text("owner_id").primaryKey(), version: integer("version").notNull(), packagesJson: text("packages_json").notNull(),
});
export const runtimeTasks = sqliteTable("runtime_tasks", {
  id: text("id").primaryKey(), notebookId: text("notebook_id").notNull(), runtimeId: text("runtime_id").notNull(),
  requestKey: text("request_key").notNull(), kind: text("kind").notNull(), configJson: text("config_json").notNull(),
  state: text("state").notNull(), resultJson: text("result_json"), errorJson: text("error_json"),
  createdAt: integer("created_at").notNull(), finishedAt: integer("finished_at"),
}, (table) => [uniqueIndex("runtime_setup_idempotency").on(table.notebookId, table.requestKey)]);

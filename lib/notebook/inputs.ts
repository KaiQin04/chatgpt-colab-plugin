/** Attachment validation and metadata only; temporary URLs are never persisted. */
import { SpikeError } from "../platform/security.ts";
import type { InputView } from "./contract.ts";

export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
export interface InputFile { download_url: string; file_id: string; mime_type?: string; file_name?: string }
export interface InputRow {
  id: string; notebook_id: string; runtime_id: string; request_key: string; file_id: string;
  file_name: string; mime_type: string | null; state: string; size: number | null; sha256: string | null;
  error_json: string | null; created_at: number; finished_at: number | null;
}
export interface InputResult {
  protocol: 1; inputId: string; status: "running" | "ready" | "error";
  size: number | null; sha256: string | null; startedAt: number; finishedAt: number | null;
  error: { code: string; httpStatus?: number } | null;
}
export function inputName(value: unknown): string {
  if (value === undefined) return "input.bin";
  if (typeof value !== "string" || !value || value.startsWith(".") || /[\\/:\x00-\x1f\x7f%]/.test(value) ||
    new TextEncoder().encode(value).length > 180) throw new SpikeError("input_filename_invalid", "inputs", 400);
  return value;
}
export function inputUrl(raw: unknown): string {
  let url: URL;
  try { url = new URL(typeof raw === "string" && raw.length <= 8192 ? raw : ""); }
  catch { throw new SpikeError("input_url_invalid", "inputs", 400); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host) || /^\d+(?:\.\d+){3}$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)) {
    throw new SpikeError("input_url_not_public_https", "inputs", 400);
  }
  return url.href;
}
export function validateInputFile(raw: unknown): InputFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SpikeError("input_file_invalid", "inputs", 400);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["download_url", "file_id", "file_name", "mime_type"].includes(key)) ||
    typeof value.file_id !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value.file_id) ||
    (value.mime_type !== undefined && (typeof value.mime_type !== "string" ||
      !/^[A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]{1,100}$/.test(value.mime_type)))) {
    throw new SpikeError("input_file_invalid", "inputs", 400);
  }
  inputName(value.file_name);
  return { download_url: inputUrl(value.download_url), file_id: value.file_id,
    ...(value.file_name === undefined ? {} : { file_name: value.file_name as string }),
    ...(value.mime_type === undefined ? {} : { mime_type: value.mime_type as string }) };
}
export function inputResultPath(notebookId: string, inputId: string): string {
  if (![notebookId, inputId].every((value) => /^[a-f0-9-]{36}$/.test(value))) {
    throw new SpikeError("input_internal_id_invalid", "inputs");
  }
  return `content/colab_inputs/${notebookId}/${inputId}/result.json`;
}
export function parseInputResult(raw: unknown, row: InputRow): InputResult {
  if (typeof raw !== "string" || raw.length > 4096) throw new SpikeError("input_result_invalid", "inputs");
  let value: InputResult;
  try { value = JSON.parse(raw); } catch { throw new SpikeError("input_result_invalid", "inputs"); }
  if (!value || value.protocol !== 1 || value.inputId !== row.id || !["running", "ready", "error"].includes(value.status) ||
    !Number.isSafeInteger(value.startedAt) || value.startedAt < row.created_at - 60_000 ||
    value.startedAt > Date.now() + 60_000 ||
    (value.status !== "running" && (!Number.isSafeInteger(value.finishedAt) || Number(value.finishedAt) < value.startedAt ||
      Number(value.finishedAt) > Date.now() + 60_000)) ||
    (value.status === "ready" && (!Number.isSafeInteger(value.size) || Number(value.size) < 0 ||
      Number(value.size) > MAX_INPUT_BYTES || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)))) {
    throw new SpikeError("input_result_invalid", "inputs");
  }
  const codes = ["download_expired", "download_http_error", "download_timeout", "download_too_large", "download_incomplete",
    "download_url_invalid", "download_address_not_public", "input_path_invalid", "input_already_exists", "download_failed", "download_interrupted"];
  if (value.status === "error" && (!value.error || !codes.includes(value.error.code))) throw new SpikeError("input_result_invalid", "inputs");
  return { protocol: 1, inputId: row.id, status: value.status,
    size: value.status === "ready" ? value.size : null, sha256: value.status === "ready" ? value.sha256 : null,
    startedAt: value.startedAt, finishedAt: value.status === "running" ? null : value.finishedAt,
    error: value.status === "error" ? { code: value.error!.code,
      ...(Number.isInteger(value.error!.httpStatus) && Number(value.error!.httpStatus) >= 100 && Number(value.error!.httpStatus) <= 599
        ? { httpStatus: value.error!.httpStatus } : {}) } : null };
}
export function inputView(row: InputRow, runtimeId: string | null): InputView {
  return { id: row.id, fileId: row.file_id, filename: row.file_name, mimeType: row.mime_type, state: row.state,
    bytes: row.size, sha256: row.sha256, path: `/content/${row.notebook_id}/inputs/${row.id}/${row.file_name}`,
    currentRuntime: row.runtime_id === runtimeId, createdAt: row.created_at, finishedAt: row.finished_at,
    error: row.error_json ? JSON.parse(row.error_json) : null };
}

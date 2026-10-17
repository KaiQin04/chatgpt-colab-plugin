/** Bounded HTTPS requests. Error bodies and credential-bearing URLs stay private. */
import { HTTP_TIMEOUT_MS } from "./config.ts";
import type { Fetcher } from "./config.ts";
import { SpikeError } from "./security.ts";

const SAFE_OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client",
  "unsupported_grant_type", "invalid_scope", "access_denied", "server_error",
  "temporarily_unavailable", "rate_limit_exceeded",
]);

export function oauthErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_OAUTH_ERRORS.has(value)
    ? value : undefined;
}

export async function boundedRequest<T>(
  fetcher: Fetcher, url: URL | string, init: RequestInit, stage: string,
  parse: (response: Response) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      ...init, redirect: "manual", signal: controller.signal,
    });
    return await parse(response);
  } catch (error) {
    if (error instanceof SpikeError) throw error;
    if (controller.signal.aborted) throw new SpikeError("request_timeout", stage);
    throw new SpikeError("transport_failed", stage);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function limitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new SpikeError("upstream_response_too_large", "http");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(data);
}

export async function requestJson(
  fetcher: Fetcher, url: URL | string, init: RequestInit, stage: string,
  options: {
    signal?: AbortSignal; timeoutMs?: number; onStatus?: (status: number) => void;
  } = {},
): Promise<Record<string, unknown>> {
  return boundedRequest(fetcher, url, init, stage, async (response) => {
    options.onStatus?.(response.status);
    let text = await limitedText(response);
    if (text.startsWith(")]}'\n")) text = text.slice(5);
    let value: unknown;
    try { value = text.trim() ? JSON.parse(text) : {}; }
    catch {
      throw new SpikeError("upstream_invalid_json", stage, response.status);
    }
    if (!response.ok) {
      const code = value && typeof value === "object"
        ? oauthErrorCode((value as Record<string, unknown>).error) : undefined;
      throw new SpikeError("upstream_http_error", stage, response.status, code);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SpikeError("upstream_invalid_shape", stage, response.status);
    }
    return value as Record<string, unknown>;
  }, options);
}

/** Product Colab client: exact /tun/m request shapes and runtime release. */
import { CLEANUP_STEP_TIMEOUT_MS } from "../platform/config.ts";
import type { Fetcher } from "../platform/config.ts";
import { boundedStep, requireActive } from "../platform/deadline.ts";
import { requestJson } from "../platform/network.ts";
import { safeError, SpikeError } from "../platform/security.ts";

const COLAB_ORIGIN = "https://colab.research.google.com";
export const CLIENT_AGENT = "colab-compute-mcp";
type Statuses = Record<string, number>;
type Assignment = Record<string, unknown> & { endpoint: string };
export interface ComputeInfo {
  currentBalance: number; consumptionRateHourly: number; assignmentsCount: number;
  eligibleGpus: string[] | null; estimatedHoursRemaining: number | null;
  estimateScope: "account_current_rate"; balanceWarning: "balance_depleted" | null; observedAt: string;
}

export function endpoint(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(value)) {
    throw new SpikeError("assignment_endpoint_invalid", "allocation");
  }
  return value;
}

export class ColabClient {
  constructor(
    readonly token: string,
    readonly fetcher: Fetcher,
    readonly statuses: Statuses = {},
  ) {}

  async request(method: string, path: string, stage: string,
    options: {
      params?: Record<string, string>; xsrf?: string; signal?: AbortSignal; timeoutMs?: number;
    } = {}): Promise<Record<string, unknown>> {
    requireActive(options.signal, stage);
    const url = new URL(path, COLAB_ORIGIN);
    url.search = new URLSearchParams({ authuser: "0", ...options.params }).toString();
    return requestJson(this.fetcher, url, {
      method,
      headers: {
        Accept: "application/json", Authorization: `Bearer ${this.token}`,
        "X-Colab-Client-Agent": CLIENT_AGENT,
        ...(options.xsrf ? { "X-Goog-Colab-Token": options.xsrf } : {}),
      },
    }, stage, { signal: options.signal, timeoutMs: options.timeoutMs,
      onStatus: (status) => { this.statuses[stage] = status; } });
  }

  async assignments(stage: string, signal?: AbortSignal, timeoutMs?: number): Promise<Assignment[]> {
    const payload = await this.request("GET", "/tun/m/assignments", stage, { signal, timeoutMs });
    if (!Array.isArray(payload.assignments) || payload.hasMore || payload.nextPageToken || payload.next_page_token) {
      throw new SpikeError("assignments_shape_invalid", stage);
    }
    const seen = new Set<string>();
    return payload.assignments.map((value: unknown) => {
      if (!value || typeof value !== "object") {
        throw new SpikeError("assignments_shape_invalid", stage);
      }
      const assignment = value as Record<string, unknown>;
      const id = endpoint(assignment.endpoint);
      if (seen.has(id)) throw new SpikeError("assignments_duplicate_endpoint", stage);
      seen.add(id);
      return assignment as Assignment;
    });
  }

  async computeInfo(stage: string, signal?: AbortSignal, timeoutMs?: number): Promise<ComputeInfo> {
    return parseComputeInfo(await this.request("GET", "/tun/m/ccu-info", stage, { signal, timeoutMs }));
  }
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SpikeError(`${name}_invalid`, "colab_status");
  }
  return value;
}

/** Only allowlisted numeric/account fields leave the upstream credential boundary. */
export function parseComputeInfo(ccu: Record<string, unknown>): ComputeInfo {
  const eligible = ccu.eligibleGpus;
  if (eligible !== undefined && (!Array.isArray(eligible) || eligible.length > 64 ||
    eligible.some((gpu) => typeof gpu !== "string" || !/^[A-Z][A-Z0-9_-]{0,31}$/.test(gpu)))) {
    throw new SpikeError("eligibleGpus_invalid", "colab_status");
  }
  const count = finiteNumber(ccu.assignmentsCount, "assignmentsCount");
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new SpikeError("assignmentsCount_invalid", "colab_status");
  }
  const balance = finiteNumber(ccu.currentBalance, "currentBalance");
  const rate = finiteNumber(ccu.consumptionRateHourly, "consumptionRateHourly");
  if (rate < 0) throw new SpikeError("consumptionRateHourly_invalid", "colab_status");
  const estimate = rate > 0 ? Math.max(0, balance) / rate : NaN;
  return {
    currentBalance: balance, consumptionRateHourly: rate,
    assignmentsCount: count,
    eligibleGpus: eligible === undefined ? null : [...new Set(eligible as string[])],
    estimatedHoursRemaining: Number.isFinite(estimate) ? estimate : null,
    estimateScope: "account_current_rate", balanceWarning: balance <= 0 ? "balance_depleted" : null,
    observedAt: new Date().toISOString(),
  };
}

export function proxyConfig(assignment: Record<string, unknown>): { url: URL; token: string } {
  const raw = assignment.runtimeProxyInfo;
  if (!raw || typeof raw !== "object") throw new SpikeError("proxy_info_missing", "proxy");
  const info = raw as Record<string, unknown>;
  let url: URL;
  try { url = new URL(String(info.url)); }
  catch { throw new SpikeError("proxy_url_invalid", "proxy"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || typeof info.token !== "string" || !info.token || info.token.length > 32_768) {
    throw new SpikeError("proxy_info_invalid", "proxy");
  }
  return { url, token: info.token };
}

export function proxyUrl(base: URL, path: string, token: string,
  extra: Record<string, string> = {}): URL {
  const result = new URL(base);
  result.pathname = `${base.pathname.replace(/\/$/, "")}${path}`;
  result.search = new URLSearchParams({
    authuser: "0", "colab-runtime-proxy-token": token, ...extra,
  }).toString();
  return result;
}

export async function releaseRuntime(client: ColabClient, ownedEndpoint: string): Promise<{
  released: boolean; remainingAssignmentsCount?: number;
  cleanupError?: Record<string, unknown>; confirmationError?: Record<string, unknown>;
}> {
  let cleanupError: Record<string, unknown> | undefined;
  let confirmationError: Record<string, unknown> | undefined;
  let remaining: Assignment[] | undefined;
  const step = <T>(stage: string, work: (signal: AbortSignal) => Promise<T>) =>
    boundedStep(stage, CLEANUP_STEP_TIMEOUT_MS, undefined, work);
  try {
    const path = `/tun/m/unassign/${encodeURIComponent(ownedEndpoint)}`;
    const challenge = await step("unassignGet", (signal) => client.request("GET", path,
      "unassignGet", { signal, timeoutMs: CLEANUP_STEP_TIMEOUT_MS }));
    if (typeof challenge.token !== "string" || !challenge.token) {
      throw new SpikeError("unassign_challenge_invalid", "cleanup");
    }
    await step("unassignPost", (signal) => client.request("POST", path, "unassignPost", {
      xsrf: challenge.token as string, signal, timeoutMs: CLEANUP_STEP_TIMEOUT_MS,
    }));
  } catch (error) { cleanupError = safeError(error); }
  finally {
    // A separate five-second confirmation survives a timed-out GET or POST.
    try {
      remaining = await step("assignmentsAfter", (signal) => client.assignments(
        "assignmentsAfter", signal, CLEANUP_STEP_TIMEOUT_MS,
      ));
    } catch (error) { confirmationError = safeError(error); }
  }
  return {
    released: remaining !== undefined && !remaining.some((row) => row.endpoint === ownedEndpoint),
    ...(remaining ? { remainingAssignmentsCount: remaining.length } : {}),
    ...(cleanupError ? { cleanupError } : {}),
    ...(confirmationError ? { confirmationError } : {}),
  };
}

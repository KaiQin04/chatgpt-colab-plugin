/** Short Jupyter operations; the Colab kernel owns execution after WebSocket ACK. */
import { ColabClient, endpoint, proxyConfig, proxyUrl, releaseRuntime } from "../colab/client.ts";
import type { Fetcher } from "../platform/config.ts";
import { boundedStep, requireActive } from "../platform/deadline.ts";
import { boundedRequest, requestJson } from "../platform/network.ts";
import { SpikeError } from "../platform/security.ts";
import { MAX_OUTPUT_BYTES, MAX_TEXT_OUTPUT_BYTES, MAX_RESULT_BYTES, SUBMIT_ACK_MS } from "./types.ts";
import type { Output, RunResult, RuntimeRow } from "./types.ts";
import { pythonWrapper, resultPath } from "./wrapper.ts";
import { artifactManifest, artifactPath } from "./artifact-store.ts";
import { MAX_ARTIFACT_FILE_BYTES } from "./policy.ts";
import { CPU_COMPUTE, observedCompute } from "./compute.ts";
import type { ComputeChoice, ObservedCompute } from "./compute.ts";
import type { ComputeInfo } from "../colab/client.ts";
import { inputResultPath, parseInputResult } from "./inputs.ts";
import type { InputFile, InputResult, InputRow } from "./inputs.ts";
import { inputWrapper } from "./input-wrapper.ts";
import { parseSetupResult, setupPath } from "./setup.ts";
import type { SetupResult, SetupRow } from "./setup.ts";
import { setupWrapper } from "./setup-wrapper.ts";
import { base64PngWithinLimits } from "./png.ts";

const AGENT = "colab-compute-mcp";
interface Socket extends EventTarget { accept(): void; send(value: string): void; close(code?: number, reason?: string): void }

/** Revalidate remote files even though our own wrapper produced them: cell code can alter them. */
export function parseRunResult(raw: unknown, runId: string): RunResult {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_RESULT_BYTES) {
    throw new SpikeError("run_result_limit_exceeded", "poll");
  }
  let value: RunResult;
  try { value = JSON.parse(raw); } catch { throw new SpikeError("run_result_invalid", "poll"); }
  if (!value || value.protocol !== 1 || value.runId !== runId ||
    !["running", "ok", "error", "interrupted"].includes(value.status) ||
    !Array.isArray(value.outputs) || value.outputs.length > 64 || typeof value.truncated !== "boolean" ||
    !Number.isSafeInteger(value.startedAt) || value.startedAt < 0 ||
    (value.finishedAt !== null && (!Number.isSafeInteger(value.finishedAt) || value.finishedAt < value.startedAt)) ||
    (value.executionCount !== null && (!Number.isSafeInteger(value.executionCount) || value.executionCount < 0))) {
    throw new SpikeError("run_result_invalid", "poll");
  }
  let bytes = 0;
  let textBytes = 0;
  const text = (input: unknown, max = MAX_OUTPUT_BYTES, image = false) => {
    if (typeof input !== "string" || input.length > max) throw new SpikeError("run_output_invalid", "poll");
    const size = new TextEncoder().encode(input).length;
    bytes += size;
    if (!image) textBytes += size;
    if (textBytes > MAX_TEXT_OUTPUT_BYTES + 120) throw new SpikeError("run_output_limit_exceeded", "poll");
    if (bytes > MAX_OUTPUT_BYTES + 120) throw new SpikeError("run_output_limit_exceeded", "poll");
    return input;
  };
  const outputs: Output[] = value.outputs.map((item) => {
    if (!item || typeof item !== "object") throw new SpikeError("run_output_invalid", "poll");
    if (item.output_type === "stream" && ["stdout", "stderr"].includes(item.name)) {
      return { output_type: "stream", name: item.name, text: text(item.text) };
    }
    if (["display_data", "execute_result"].includes(item.output_type) && "data" in item &&
      item.data && typeof item.data === "object" && !Array.isArray(item.data)) {
      const data: Record<string, string> = {};
      if (Object.hasOwn(item.data, "text/plain")) data["text/plain"] = text(item.data["text/plain"]);
      if (Object.hasOwn(item.data, "image/png")) {
        const png = text(item.data["image/png"], MAX_OUTPUT_BYTES, true);
        // PNG only, never SVG/HTML/remote resource URLs.
        if (/^iVBORw0KGgo[A-Za-z0-9+/=\r\n]*$/.test(png) && base64PngWithinLimits(png)) data["image/png"] = png;
      }
      return { output_type: "display_data", data, metadata: {} };
    }
    if (item.output_type === "error" && Array.isArray(item.traceback) && item.traceback.length <= 20) {
      return { output_type: "error", ename: text(item.ename, 120), evalue: text(item.evalue),
        traceback: item.traceback.map((line) => text(line)) };
    }
    throw new SpikeError("run_output_invalid", "poll");
  });
  return { protocol: 1, runId, status: value.status, outputs, truncated: value.truncated,
    startedAt: value.startedAt, finishedAt: value.finishedAt, executionCount: value.executionCount,
    ...(value.artifacts === undefined ? {} : { artifacts: artifactManifest(value.artifacts) }) };
}

export class NotebookRuntime {
  constructor(readonly client: ColabClient, readonly fetcher: Fetcher) {}

  async computeStatus(signal: AbortSignal): Promise<ComputeInfo & { assignmentCount: number }> {
    const info = await boundedStep("notebookComputeInfo", 5000, signal,
      (stepSignal) => this.client.computeInfo("notebookComputeInfo", stepSignal, 5000));
    const assignments = await boundedStep("notebookComputeAssignments", 5000, signal,
      (stepSignal) => this.client.assignments("notebookComputeAssignments", stepSignal, 5000));
    return { ...info, assignmentCount: assignments.length };
  }

  async allocate(hash: string, signal: AbortSignal, capture: (endpoint: string) => Promise<void>,
    attempt: (mayExist: boolean) => void = () => {}, choice: ComputeChoice = CPU_COMPUTE): Promise<ObservedCompute> {
    const existing = await boundedStep("notebookAssignmentsBefore", 5000, signal,
      (stepSignal) => this.client.assignments("notebookAssignmentsBefore", stepSignal, 5000));
    requireActive(signal, "notebookAssign");
    const params = { nbh: hash.replace(/-/g, "_").padEnd(44, "."),
      variant: choice.kind === "CPU" ? "DEFAULT" : "GPU",
      ...(choice.kind === "GPU" ? { accelerator: choice.accelerator } : {}) };
    attempt(true);
    let assignment = await boundedStep("notebookAssignGet", 8000, signal,
      (stepSignal) => this.client.request("GET", "/tun/m/assign", "notebookAssignGet", { params, signal: stepSignal, timeoutMs: 8000 }));
    if (!("endpoint" in assignment)) {
      attempt(false);
      if (typeof assignment.token !== "string" || !assignment.token) throw new SpikeError("assign_challenge_invalid", "open");
      requireActive(signal, "notebookAssignPost");
      attempt(true);
      try {
        assignment = await boundedStep("notebookAssignPost", 8000, signal,
          (stepSignal) => this.client.request("POST", "/tun/m/assign", "notebookAssignPost", {
            params, signal: stepSignal, timeoutMs: 8000, xsrf: assignment.token as string,
          }));
      } catch (error) {
        // The Python reference identifies this exact status as refused assignment.
        // A transport failure or any other ambiguous response retains the unknown lock.
        if (error instanceof SpikeError && error.httpStatus === 412) attempt(false);
        throw error;
      }
    }
    const owned = endpoint(assignment.endpoint);
    if (existing.some((row) => row.endpoint === owned)) throw new SpikeError("endpoint_was_already_assigned_not_modified", "open");
    // Caller captures in memory before awaiting a possibly failing ledger write.
    await capture(owned);
    requireActive(signal, "notebookComputeVerification");
    const current = await boundedStep("notebookObservedAssignment", 5000, signal,
      (stepSignal) => this.client.assignments("notebookObservedAssignment", stepSignal, 5000));
    const actual = current.find((row) => row.endpoint === owned);
    if (!actual) throw new SpikeError("allocated_runtime_not_observed", "open");
    return observedCompute(actual, choice);
  }
  async proxy(owned: string, signal: AbortSignal): Promise<{ url: URL; token: string }> {
    const assignments = await boundedStep("notebookAssignments", 5000, signal,
      (stepSignal) => this.client.assignments("notebookAssignments", stepSignal, 5000));
    const assignment = assignments.find((row) => row.endpoint === owned);
    if (!assignment) throw new SpikeError("owned_runtime_not_assigned", "notebook", 409);
    return proxyConfig(assignment);
  }
  async request(runtime: RuntimeRow, method: string, path: string, stage: string, signal: AbortSignal,
    body?: unknown, query: Record<string, string> = {}, maxResponseBytes?: number): Promise<Record<string, unknown>> {
    if (!runtime.endpoint) throw new SpikeError("runtime_endpoint_unknown", stage, 409);
    const proxy = await this.proxy(runtime.endpoint, signal);
    requireActive(signal, stage);
    return boundedStep(stage, 5000, signal, (stepSignal) => requestJson(this.fetcher, proxyUrl(proxy.url, path, proxy.token, query), {
      method, headers: { "Content-Type": "application/json", "X-Colab-Runtime-Proxy-Token": proxy.token,
        "X-Colab-Client-Agent": AGENT }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, stage, { signal: stepSignal, timeoutMs: 5000, maxResponseBytes }));
  }
  async startKernel(runtime: RuntimeRow, signal: AbortSignal): Promise<string> {
    const value = await this.request(runtime, "POST", "/api/kernels", "notebookKernelStart", signal, { name: "python3" });
    if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)) {
      throw new SpikeError("kernel_id_invalid", "open");
    }
    return value.id;
  }
  async submit(runtime: RuntimeRow, runId: string, source: string, signal: AbortSignal): Promise<void> {
    return this.submitCode(runtime, pythonWrapper(runtime.notebook_id, runId, source), false, signal);
  }
  async submitInput(runtime: RuntimeRow, inputId: string, file: InputFile, signal: AbortSignal): Promise<void> {
    return this.submitCode(runtime, inputWrapper(runtime.notebook_id, inputId, file), true, signal);
  }
  async submitSetup(runtime: RuntimeRow, job: SetupRow, signal: AbortSignal): Promise<void> {
    return this.submitCode(runtime, setupWrapper(job), true, signal);
  }
  private async submitCode(runtime: RuntimeRow, code: string, silent: boolean, signal: AbortSignal): Promise<void> {
    if (!runtime.endpoint || !runtime.kernel_id) throw new SpikeError("runtime_not_ready", "submit", 409);
    const proxy = await this.proxy(runtime.endpoint, signal);
    const msgId = crypto.randomUUID();
    const session = crypto.randomUUID();
    const url = proxyUrl(proxy.url, `/api/kernels/${encodeURIComponent(runtime.kernel_id)}/channels`, proxy.token,
      { session_id: session });
    const socket = await boundedStep("notebookWsHandshake", 5000, signal, (stepSignal) => boundedRequest(this.fetcher, url, { headers: {
      Upgrade: "websocket", "X-Colab-Runtime-Proxy-Token": proxy.token, "X-Colab-Client-Agent": AGENT,
    } }, "notebookWsHandshake", async (response) => {
      const ws = (response as unknown as { webSocket?: Socket }).webSocket;
      if (response.status !== 101 || !ws) throw new SpikeError("websocket_upgrade_failed", "submit", response.status);
      return ws;
    }, { signal: stepSignal, timeoutMs: 5000 }));
    try {
      socket.accept();
      requireActive(signal, "submit");
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: SpikeError) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          socket.removeEventListener("message", message);
          socket.removeEventListener("close", close);
          socket.removeEventListener("error", failed);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new SpikeError("dispatch_ack_unknown", "submit"));
        const close = () => finish(new SpikeError("dispatch_ack_unknown", "submit"));
        const failed = () => finish(new SpikeError("dispatch_ack_unknown", "submit"));
        const message = (event: Event) => {
          const data = (event as MessageEvent).data;
          if (typeof data !== "string" || data.length > 65_536) return;
          try {
            const packet = JSON.parse(data);
            if (packet.parent_header?.msg_id !== msgId) return;
            if ((packet.header?.msg_type === "status" && packet.content?.execution_state === "busy") ||
              packet.header?.msg_type === "execute_reply") finish();
            // No stdin or colab_request responses: no Drive/auth interaction.
          } catch { /* Invalid frames cannot acknowledge dispatch. */ }
        };
        const timer = setTimeout(() => finish(new SpikeError("dispatch_ack_unknown", "submit")), SUBMIT_ACK_MS);
        signal.addEventListener("abort", abort, { once: true });
        socket.addEventListener("message", message);
        socket.addEventListener("close", close);
        socket.addEventListener("error", failed);
        if (signal.aborted) { abort(); return; }
        try {
          socket.send(JSON.stringify({ header: { msg_id: msgId, msg_type: "execute_request", session,
            username: AGENT, date: new Date().toISOString(), version: "5.3" },
          parent_header: {}, metadata: {}, channel: "shell", buffers: [], content: {
            code, silent, store_history: false,
            user_expressions: {}, allow_stdin: false, stop_on_error: true,
          } }));
        } catch { finish(new SpikeError("dispatch_ack_unknown", "submit")); }
      });
    } finally {
      try { socket.close(1000, "submission acknowledged or unknown"); } catch { /* No background socket. */ }
    }
  }
  /** Read a small JSON result file the wrapper wrote; null while it does not exist yet. */
  async readResultFile(runtime: RuntimeRow, apiPath: string, signal: AbortSignal, spec: {
    metadataStage: string; readStage: string; maxBytes: number;
    limitError: [code: string, stage: string]; invalidError: [code: string, stage: string];
  }): Promise<unknown> {
    let metadata: Record<string, unknown>;
    try { metadata = await this.request(runtime, "GET", apiPath, spec.metadataStage, signal,
      undefined, { content: "0" }); }
    catch (error) { if (error instanceof SpikeError && error.httpStatus === 404) return null; throw error; }
    if (metadata.type !== "file" || typeof metadata.size !== "number" || metadata.size < 0 || metadata.size > spec.maxBytes) {
      throw new SpikeError(...spec.limitError);
    }
    const file = await this.request(runtime, "GET", apiPath, spec.readStage, signal,
      undefined, { content: "1", format: "text", type: "file" }, spec.maxBytes * 6 + 4096);
    if (file.type !== "file" || file.format !== "text") throw new SpikeError(...spec.invalidError);
    return file.content;
  }
  async poll(runtime: RuntimeRow, runId: string, signal: AbortSignal): Promise<RunResult | null> {
    const path = resultPath(runtime.notebook_id, runId);
    const apiPath = `/api/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const content = await this.readResultFile(runtime, apiPath, signal, {
      metadataStage: "notebookResultMetadata", readStage: "notebookResultRead", maxBytes: MAX_RESULT_BYTES,
      limitError: ["run_result_file_limit_exceeded", "poll"], invalidError: ["run_result_file_invalid", "poll"],
    });
    return content === null ? null : parseRunResult(content, runId);
  }
  async pollInput(runtime: RuntimeRow, input: InputRow, signal: AbortSignal): Promise<InputResult | null> {
    const content = await this.readResultFile(runtime, `/api/contents/${inputResultPath(runtime.notebook_id, input.id)}`, signal, {
      metadataStage: "inputResultMetadata", readStage: "inputResultRead", maxBytes: 4096,
      limitError: ["input_result_invalid", "inputs"], invalidError: ["input_result_invalid", "inputs"],
    });
    return content === null ? null : parseInputResult(content, input);
  }
  async pollSetup(runtime: RuntimeRow, job: SetupRow, signal: AbortSignal): Promise<SetupResult | null> {
    const content = await this.readResultFile(runtime, `/api/contents/${setupPath(runtime.notebook_id, job.id)}`, signal, {
      metadataStage: "setupResultMetadata", readStage: "setupResultRead", maxBytes: 16_000,
      limitError: ["setup_result_invalid", "setup"], invalidError: ["setup_result_invalid", "setup"],
    });
    return content === null ? null : parseSetupResult(content, job);
  }
  async interrupt(runtime: RuntimeRow, signal: AbortSignal): Promise<void> {
    if (!runtime.kernel_id) throw new SpikeError("kernel_id_missing", "interrupt", 409);
    await this.request(runtime, "POST", `/api/kernels/${encodeURIComponent(runtime.kernel_id)}/interrupt`,
      "notebookInterrupt", signal);
  }
  async readArtifact(runtime: RuntimeRow, relativePath: string, size: number,
    signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    artifactPath(relativePath);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARTIFACT_FILE_BYTES || !runtime.endpoint) {
      throw new SpikeError("artifact_file_too_large", "artifacts");
    }
    const path = `content/${runtime.notebook_id}/outputs/${relativePath}`.split("/").map(encodeURIComponent).join("/");
    const metadata = await this.request(runtime, "GET", `/api/contents/${path}`, "artifactMetadata", signal,
      undefined, { content: "0" });
    if (metadata.type !== "file" || metadata.size !== size) throw new SpikeError("artifact_changed", "artifacts");
    const proxy = await this.proxy(runtime.endpoint, signal);
    requireActive(signal, "artifactRead");
    return boundedStep("artifactRead", 15_000, signal, (stepSignal) => boundedRequest(this.fetcher,
      proxyUrl(proxy.url, `/files/${path}`, proxy.token), { headers: {
        "X-Colab-Runtime-Proxy-Token": proxy.token, "X-Colab-Client-Agent": AGENT,
      } }, "artifactRead", async (response) => {
        if (response.status !== 200 || !response.body) throw new SpikeError("artifact_read_http_error", "artifacts", response.status);
        const declared = response.headers.get("Content-Length");
        if (declared && Number(declared) > MAX_ARTIFACT_FILE_BYTES) throw new SpikeError("artifact_file_too_large", "artifacts");
        const data = new Uint8Array(size);
        const reader = response.body.getReader(); let offset = 0;
        try {
          while (true) {
            requireActive(stepSignal, "artifactRead");
            const chunk = await reader.read(); if (chunk.done) break;
            if (offset + chunk.value.byteLength > size) throw new SpikeError("artifact_changed_or_too_large", "artifacts");
            data.set(chunk.value, offset); offset += chunk.value.byteLength;
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        if (offset !== size) throw new SpikeError("artifact_changed", "artifacts");
        return data;
      }, { signal: stepSignal, timeoutMs: 15_000 }));
  }
  release(runtime: RuntimeRow): ReturnType<typeof releaseRuntime> {
    if (!runtime.endpoint) throw new SpikeError("runtime_endpoint_unknown", "close", 409);
    return releaseRuntime(this.client, runtime.endpoint);
  }
}

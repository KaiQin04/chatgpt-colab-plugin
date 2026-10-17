/**
 * Local notebook UI dev server: the real notebook service on an in-memory D1
 * (tests/helpers.ts) with a simulated Colab runtime. No network, no Google
 * account, no compute units. Run: npm run build:ui && npm run dev:ui
 * Header `x-dev-actor: assistant` makes a request act as ChatGPT.
 */
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { notebookCall } from "../lib/notebook/service.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import { CPU_COMPUTE } from "../lib/notebook/compute.ts";
import type { ComputeChoice, ObservedCompute } from "../lib/notebook/compute.ts";
import type { RunResult, RuntimeRow } from "../lib/notebook/types.ts";
import type { SetupRow } from "../lib/notebook/setup.ts";
import { notebookUiHtml } from "../lib/notebook/ui.ts";
import { notebookExportDownload } from "../lib/notebook/export-download.ts";
import { encryptToken } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";
import { fixture, OWNER, REFRESH, syntheticComputeStatus, tokenPayload } from "../tests/helpers.ts";

const PORT = Number(process.env.PORT ?? 8800);
const f = fixture();
const security = new Store(f.env);
await security.owner(OWNER);
await security.saveGrant({ owner_id: OWNER.userId, google_subject: "synthetic-google-subject", masked_email: "d…@e…st",
  encrypted_refresh_token: await encryptToken(REFRESH, f.env.TOKEN_ENCRYPTION_KEY!, OWNER.userId, "synthetic-google-subject") });

/** Minimal RGBA PNG encoder for a synthetic chart (no image libraries). */
function chartPng(width = 320, height = 160): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const series = (x: number) => height - 20 - (x / width) * (height - 50) - 10 * Math.sin(x / 18);
  const bench = (x: number) => height - 20 - (x / width) * (height - 90);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4;
      let [r, g, b] = [250, 252, 253];
      if (y % 40 === 0) [r, g, b] = [207, 216, 223];
      if (Math.abs(y - bench(x)) < 1.2 && x % 8 < 5) [r, g, b] = [94, 107, 120];
      if (Math.abs(y - series(x)) < 2) [r, g, b] = [52, 87, 125];
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

type Sim = { started: number; duration: number; interrupted: boolean; count: number; source: string };
let executionCount = 0;
const runs = new Map<string, Sim>();

function simulate(sim: Sim, now: number): RunResult & { runId: string } {
  const lines = sim.source.split("\n");
  const prints = lines.map((line) => /^\s*print\((.*)\)\s*$/.exec(line)?.[1]).filter((value): value is string => value !== undefined)
    .map((expr) => expr.replace(/^f?["'](.*)["']$/, "$1"));
  const progress = Math.min(1, (now - sim.started) / sim.duration);
  const running = progress < 1 && !sim.interrupted;
  const shown = running ? prints.slice(0, Math.floor(prints.length * progress)) : prints;
  const outputs: RunResult["outputs"] = [];
  if (shown.length) outputs.push({ output_type: "stream", name: "stdout", text: shown.join("\n") + "\n" });
  let status: RunResult["status"] = running ? "running" : sim.interrupted ? "interrupted" : "ok";
  if (!running && !sim.interrupted && /1\s*\/\s*0|raise /.test(sim.source)) {
    status = "error";
    outputs.push({ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: [
      "\u001b[0;31m---------------------------------------------------------------------------\u001b[0m",
      "\u001b[0;31mZeroDivisionError\u001b[0m                         Traceback (most recent call last)",
      "Cell \u001b[0;32mIn[" + sim.count + "], line 1\u001b[0m", "\u001b[0;31mZeroDivisionError\u001b[0m: division by zero"] });
  }
  if (!running && !sim.interrupted && /plot/.test(sim.source)) {
    outputs.push({ output_type: "display_data", data: { "image/png": chartPng(), "text/plain": "<Figure size 640x320>" }, metadata: {} });
  }
  if (sim.interrupted) outputs.push({ output_type: "error", ename: "KeyboardInterrupt", evalue: "", traceback: [] });
  return { protocol: 1, runId: "", status, outputs, truncated: false, startedAt: sim.started,
    finishedAt: running ? null : sim.started + Math.min(now - sim.started, sim.duration), executionCount: sim.count,
    artifacts: { files: [], errors: [] } };
}

class SimRuntime {
  async computeStatus() {
    const live = Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notebook_runtimes WHERE released=0").get()!.n);
    return syntheticComputeStatus({ currentBalance: 160.5, consumptionRateHourly: live ? 1.54 * live : 0, assignmentsCount: live });
  }
  async allocate(_hash: string, _signal: AbortSignal, capture: (endpoint: string) => Promise<void>,
    attempt: (value: boolean) => void, choice: ComputeChoice = CPU_COMPUTE): Promise<ObservedCompute> {
    attempt(true); await capture(`dev-endpoint-${crypto.randomUUID()}`);
    return { ...choice, variant: choice.kind === "CPU" ? "DEFAULT" : "GPU" };
  }
  async startKernel() { return "dev-kernel"; }
  async submit(_runtime: RuntimeRow, id: string) {
    const row = f.sqlite.prepare("SELECT source FROM notebook_runs WHERE id=?").get(id) as { source: string };
    const sleeps = [...row.source.matchAll(/sleep\((\d+(?:\.\d+)?)\)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    runs.set(id, { started: Date.now(), duration: Math.max(1200, sleeps * 1000), interrupted: false, count: ++executionCount, source: row.source });
  }
  async poll(_runtime: RuntimeRow, runId: string): Promise<RunResult | null> {
    const sim = runs.get(runId);
    return sim ? { ...simulate(sim, Date.now()), runId } : null;
  }
  async interrupt() { for (const sim of runs.values()) if (Date.now() - sim.started < sim.duration) sim.interrupted = true; }
  async release() { return { released: true }; }
  async submitInput() { throw new Error("dev server has no attachment simulation"); }
  async pollInput() { return null; }
  async submitSetup() {}
  async pollSetup(_runtime: RuntimeRow, job: SetupRow) {
    return { protocol: 1 as const, jobId: job.id, status: "ready" as const, phase: "ready",
      packages: (JSON.parse(job.config_json) as string[]).map((name) => ({ name, version: "1.0.0", installed: false })),
      blender: null, error: null, startedAt: Date.now(), finishedAt: Date.now() };
  }
  async readArtifact(): Promise<Uint8Array<ArrayBuffer>> { throw new Error("no artifacts in dev"); }
}
const runtime = new SimRuntime();

createServer(async (request, response) => {
  const exportPath = /^\/api\/notebooks\/([^/]+)\/export$/.exec(request.url ?? "");
  if (request.method === "GET" && exportPath) {
    const download = await notebookExportDownload(new Request(`http://localhost:${PORT}${request.url}`, {
      headers: { "oai-authenticated-user-id": OWNER.userId, "oai-authenticated-user-email": OWNER.email },
    }), f.env, decodeURIComponent(exportPath[1]));
    response.writeHead(download.status, Object.fromEntries(download.headers));
    response.end(Buffer.from(await download.arrayBuffer()));
    return;
  }
  if (request.method === "GET" && (request.url === "/" || request.url?.startsWith("/?"))) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(notebookUiHtml("site").replace(/window\.__CCM_SITE_ORIGIN__="[^"]*"/, `window.__CCM_SITE_ORIGIN__="http://localhost:${PORT}"`));
    return;
  }
  if (request.method === "POST" && request.url === "/api/notebooks") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let value: Record<string, unknown>;
    try {
      const body = JSON.parse(raw) as { name: string; arguments: unknown };
      const actor = request.headers["x-dev-actor"] === "assistant" ? "assistant" : "user";
      value = await notebookCall(body.name, validateNotebookArguments(body.name, body.arguments), f.env, OWNER, {
        fetcher: async () => Response.json(tokenPayload(f.env)), runtimeFactory: () => runtime as never, actor,
      });
    } catch (error) {
      value = { error: { code: error instanceof Error && "code" in error ? String((error as { code: string }).code) : "dev_error", stage: "dev" } };
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
    return;
  }
  response.writeHead(404); response.end();
}).listen(PORT, "127.0.0.1", () => console.log(`notebook UI dev server: http://localhost:${PORT}`));

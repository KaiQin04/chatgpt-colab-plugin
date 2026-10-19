import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { NotebookRuntime, parseRunResult } from "../lib/notebook/runtime.ts";
import type { RuntimeRow } from "../lib/notebook/types.ts";
import { resultPath } from "../lib/notebook/wrapper.ts";
import { ColabClient } from "../lib/colab/client.ts";
import type { Fetcher } from "../lib/platform/config.ts";
import { safeError } from "../lib/platform/security.ts";
import { ACCESS, json, PROXY } from "./helpers.ts";
import { MAX_OUTPUT_BYTES, MAX_RESULT_BYTES } from "../lib/notebook/types.ts";
import { requestJson } from "../lib/platform/network.ts";
import { syntheticPng } from "./png-fixture.ts";

const notebookId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const row: RuntimeRow = { id: crypto.randomUUID(), notebook_id: notebookId, notebook_hash: crypto.randomUUID(),
  owner_id: "synthetic-owner", request_key: "synthetic-key", state: "open", endpoint: "owned-endpoint",
  kernel_id: "synthetic-kernel", created_at: 100, updated_at: 100, released: 0, error_json: null, accelerator: "CPU",
  requested_compute: "CPU", selected_accelerator: "CPU", machine_kind: "CPU", compute_verified: 1 };
const payload = { protocol: 1, runId, status: "ok", outputs: [{ output_type: "stream", name: "stdout", text: "42\n" }],
  startedAt: 100, finishedAt: 200, executionCount: 1, truncated: false };

test("PNG at the cell limit survives the Jupyter JSON envelope; generic HTTP stays bounded", async () => {
  const png = syntheticPng();
  // Whitespace is valid Base64; fill to the exact capture boundary.
  const image = png + "\n".repeat(MAX_OUTPUT_BYTES - png.length);
  const value = { ...payload, outputs: [{ output_type: "display_data", data: { "image/png": image }, metadata: {} }] };
  const raw = JSON.stringify(value);
  assert.ok(Buffer.byteLength(raw) < MAX_RESULT_BYTES);
  const mock = remote({ size: Buffer.byteLength(raw), result: value });
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  assert.deepEqual(await runtime.poll(row, runId, new AbortController().signal), value);
  assert.throws(() => parseRunResult(JSON.stringify({ ...value, outputs: [{
    output_type: "display_data", data: { "image/png": image + "\n" },
  }] }), runId), /output_invalid/);
  await assert.rejects(requestJson(async () => json({ content: raw }), "https://example.test", {}, "test"), /too_large/);
});

test("runtime result parsing drops oversized PNGs while preserving text and valid PNGs", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const oversized = Buffer.from(png, "base64");
  oversized.writeUInt32BE(20000, 16); oversized.writeUInt32BE(20000, 20);
  for (const image of [oversized.toString("base64"), "iVBORw0KGgoAAAAA", png]) {
    const data = { "text/plain": "image description", "image/png": image };
    const parsed = parseRunResult(JSON.stringify({ ...payload,
      outputs: [{ output_type: "display_data", data }] }), runId);
    assert.deepEqual(parsed.outputs, [{ output_type: "display_data", metadata: {},
      data: image === png ? data : { "text/plain": "image description" } }]);
  }
});

class Socket extends EventTarget {
  closed = false; sent = ""; sends = 0;
  constructor(readonly unknown = false) { super(); }
  accept(): void {}
  send(raw: string): void {
    this.sends++;
    this.sent = raw;
    const request = JSON.parse(raw);
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ header: { msg_type: "status" },
        parent_header: { msg_id: "foreign" }, content: { execution_state: "busy" } }) }));
      if (this.unknown) { this.dispatchEvent(new Event("close")); return; }
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ header: { msg_type: "status" },
        parent_header: { msg_id: request.header.msg_id }, content: { execution_state: "busy" } }) }));
    });
  }
  close(): void { this.closed = true; }
}
function remote(options: { unknown?: boolean; size?: number; missing?: boolean; result?: unknown } = {}) {
  const socket = new Socket(options.unknown);
  let assignments = 0, reads = 0;
  const calls: { path: string; method: string }[] = [];
  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ path: url.pathname, method: init.method ?? "GET" });
    if (url.origin === "https://colab.research.google.com") {
      assert.equal(url.pathname, "/tun/m/assignments"); assignments++;
      return json({ assignments: [{ endpoint: row.endpoint, runtimeProxyInfo: {
        url: "https://synthetic-proxy.example.test/base", token: `${PROXY}-${assignments}`,
      } }] });
    }
    const token = `${PROXY}-${assignments}`;
    assert.equal(new Headers(init.headers).get("X-Colab-Runtime-Proxy-Token"), token);
    assert.equal(url.searchParams.get("colab-runtime-proxy-token"), token);
    if (url.pathname.endsWith("/channels")) return { status: 101, webSocket: socket } as unknown as Response;
    if (url.pathname.includes("/api/contents/")) {
      assert.equal(url.pathname, `/base/api/contents/${resultPath(notebookId, runId)}`);
      if (options.missing) return json({ error: "not_found" }, 404);
      if (url.searchParams.get("content") === "0") return json({ type: "file", size: options.size ?? 1000 });
      reads++; return json({ type: "file", format: "text", content: JSON.stringify(options.result ?? payload) });
    }
    if (url.pathname.endsWith("/interrupt")) return new Response(null, { status: 204 });
    throw new Error("unexpected_test_request");
  };
  return { socket, calls, fetcher, info: () => ({ assignments, reads }) };
}

test("submit returns on a matched parent ACK and closes WS without waiting for completion", async () => {
  const mock = remote(), runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  await runtime.submit(row, runId, "x = 42\nprint(x)", new AbortController().signal);
  assert.equal(mock.socket.closed, true);
  const sent = JSON.parse(mock.socket.sent);
  assert.equal(sent.content.allow_stdin, false); assert.equal(sent.content.store_history, false);
  assert.equal(sent.channel, "shell");
  const code = Buffer.from(sent.content.code.match(/b64decode\('([^']+)'/)[1], "base64").toString();
  assert.ok(code.includes("store_history=True"));
  assert.ok(code.includes("root.mkdir(exist_ok=False)"));
  assert.ok(code.includes("os.replace"));
  for (const secret of [ACCESS, PROXY]) assert.ok(!code.includes(secret));
  assert.equal(mock.info().reads, 0);
  assert.equal(mock.info().assignments, 1);
});

test("disconnect before matched ACK is explicit unknown and the socket still closes", async () => {
  const mock = remote({ unknown: true }), runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  await assert.rejects(runtime.submit(row, runId, "print(42)", new AbortController().signal), /dispatch_ack_unknown/);
  assert.equal(mock.socket.closed, true);
  assert.equal(mock.info().assignments, 1, "never retry after send");
});

test("a transient handshake failure refreshes the proxy and sends the cell only once", async () => {
  const mock = remote();
  let handshakes = 0;
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/channels") && ++handshakes === 1) {
      throw new TypeError("synthetic connection reset");
    }
    return mock.fetcher(input, init);
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  await runtime.submit(row, runId, "print(42)", new AbortController().signal);
  assert.equal(handshakes, 2); assert.equal(mock.info().assignments, 2);
  assert.equal(mock.socket.sends, 1); assert.equal(mock.socket.closed, true);
});

test("handshake timeout retries once and closes a late first socket without replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = remote(), late = new Socket();
  let complete!: (response: Response) => void;
  let handshakes = 0;
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/channels") && ++handshakes === 1) {
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    return mock.fetcher(input, init);
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  const submission = runtime.submit(row, runId, "print(42)", new AbortController().signal);
  while (!complete) await setImmediate();
  t.mock.timers.tick(5000);
  await submission;
  complete({ status: 101, webSocket: late } as unknown as Response);
  await setImmediate();
  assert.equal(handshakes, 2); assert.equal(mock.info().assignments, 2);
  assert.equal(mock.socket.sends, 1); assert.equal(late.sends, 0); assert.equal(late.closed, true);
});

test("a throwing send is ambiguous and is never retried", async () => {
  const mock = remote();
  mock.socket.send = () => { mock.socket.sends++; throw new Error("synthetic uncertain send"); };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  await assert.rejects(runtime.submit(row, runId, "print(42)", new AbortController().signal), (error: Error) => {
    assert.notEqual(error.name, "SubmissionNotSentError"); assert.match(error.message, /dispatch_ack_unknown/); return true;
  });
  assert.equal(mock.socket.sends, 1); assert.equal(mock.info().assignments, 1);
  assert.equal(mock.socket.closed, true);
});

test("permanent upgrade rejection does not retry and cannot execute code", async () => {
  const mock = remote();
  let handshakes = 0;
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/channels")) { handshakes++; return new Response(null, { status: 404 }); }
    return mock.fetcher(input, init);
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  await assert.rejects(runtime.submit(row, runId, "print(42)", new AbortController().signal), { name: "SubmissionNotSentError" });
  assert.equal(handshakes, 1); assert.equal(mock.socket.sends, 0);
});

test("exhausted handshake attempts are proven not sent, not an unknown ACK", async () => {
  const mock = remote();
  let handshakes = 0;
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/channels")) {
      handshakes++; throw new TypeError("synthetic connection reset");
    }
    return mock.fetcher(input, init);
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  await assert.rejects(runtime.submit(row, runId, "print(42)", new AbortController().signal), (error: Error) => {
    assert.equal(error.name, "SubmissionNotSentError"); return true;
  });
  assert.equal(handshakes, 2); assert.equal(mock.socket.sent, "");
});

test("a late upgrade after cancellation is closed without sending or retrying", async () => {
  const mock = remote();
  let complete!: (response: Response) => void;
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/channels")) {
      return new Promise<Response>(resolve => { complete = resolve; });
    }
    return mock.fetcher(input, init);
  };
  const controller = new AbortController();
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  const submission = runtime.submit(row, runId, "print(42)", controller.signal);
  while (!complete) await setImmediate();
  controller.abort();
  await assert.rejects(submission, /deadline/);
  complete({ status: 101, webSocket: mock.socket } as unknown as Response);
  await setImmediate();
  assert.equal(mock.socket.sent, ""); assert.equal(mock.socket.closed, true);
  assert.equal(mock.info().assignments, 1);
});

test("attachment execution is silent with history disabled and no Google/proxy credentials in VM code", async () => {
  const mock = remote(), runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  await runtime.submitInput(row, runId, { download_url: "https://files.example.com/input?signature=synthetic", file_id: "file_synthetic" }, new AbortController().signal);
  const request = JSON.parse(mock.socket.sent);
  assert.equal(request.content.store_history, false); assert.equal(request.content.silent, true);
  assert.equal(request.content.allow_stdin, false); assert.equal(mock.socket.closed, true);
  const code = Buffer.from(request.content.code.match(/b64decode\('([^']+)'/)[1], "base64").toString();
  assert.ok(code.includes("download_input"));
  for (const credential of [ACCESS, PROXY]) assert.ok(!code.includes(credential));
});

test("poll refreshes proxy credentials from assignments for metadata and content, interrupt refreshes again", async () => {
  const mock = remote(), runtime = new NotebookRuntime(new ColabClient(ACCESS, mock.fetcher), mock.fetcher);
  assert.deepEqual(await runtime.poll(row, runId, new AbortController().signal), payload);
  await runtime.interrupt(row, new AbortController().signal);
  assert.equal(mock.info().assignments, 3); assert.equal(mock.info().reads, 1);
});

test("metadata size bounds stop file reads, missing files are pending, UUID-only paths", async () => {
  const large = remote({ size: MAX_RESULT_BYTES + 1 }), runtime = new NotebookRuntime(new ColabClient(ACCESS, large.fetcher), large.fetcher);
  await assert.rejects(runtime.poll(row, runId, new AbortController().signal), /file_limit/);
  assert.equal(large.info().reads, 0);
  const missing = remote({ missing: true });
  assert.equal(await new NotebookRuntime(new ColabClient(ACCESS, missing.fetcher), missing.fetcher)
    .poll(row, runId, new AbortController().signal), null);
  assert.throws(() => resultPath(notebookId, "../private"), /invalid_internal_run_path/);
});

test("allocation never captures a pre-existing endpoint and never continues POST after cancellation", async () => {
  let captured = 0, posts = 0;
  let resolveGet!: (response: Response) => void;
  const preexisting: Fetcher = async (input) => {
    const path = new URL(String(input)).pathname;
    return path.endsWith("assignments") ? json({ assignments: [{ endpoint: "user-existing" }] }) : json({ endpoint: "user-existing" });
  };
  const first = new NotebookRuntime(new ColabClient(ACCESS, preexisting), preexisting);
  await assert.rejects(first.allocate(row.notebook_hash, new AbortController().signal, async () => { captured++; }), /already_assigned/);
  assert.equal(captured, 0);
  const hanging: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("assignments")) return json({ assignments: [] });
    if (init?.method === "POST") { posts++; return json({ endpoint: "should-not-exist" }); }
    return new Promise<Response>((resolve) => { resolveGet = resolve; });
  };
  const controller = new AbortController();
  const second = new NotebookRuntime(new ColabClient(ACCESS, hanging), hanging);
  const allocation = second.allocate(row.notebook_hash, controller.signal, async () => { captured++; });
  while (!resolveGet) await setImmediate();
  controller.abort(); await assert.rejects(allocation, /deadline/);
  resolveGet(json({ token: "synthetic-xsrf" })); await setImmediate();
  assert.equal(posts, 0); assert.equal(captured, 0);
});

test("credential-bearing transport errors are never reflected in the safe result", async () => {
  const mock = remote();
  const fetcher: Fetcher = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("assignments")) return mock.fetcher(input, init);
    throw new TypeError(`transport failed ${String(input)} ${PROXY}`);
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  try { await runtime.submit(row, runId, "print(42)", new AbortController().signal); assert.fail("must fail"); }
  catch (error) {
    const safe = JSON.stringify(safeError(error)); assert.ok(!safe.includes(PROXY)); assert.ok(!safe.includes("https://"));
  }
});

test("raw artifact files bypass the JSON size cap but enforce exact byte size and 16 MiB hard limit", async () => {
  const data = new Uint8Array(600_000).fill(42);
  let rawReads = 0;
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("assignments")) return json({ assignments: [{ endpoint: row.endpoint,
      runtimeProxyInfo: { url: "https://synthetic-proxy.example.test/base", token: PROXY } }] });
    if (url.pathname.includes("/api/contents/")) return json({ type: "file", size: data.length });
    assert.equal(url.pathname, `/base/files/content/${notebookId}/outputs/nested/result.bin`); rawReads++;
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < data.length; offset += 32_000) controller.enqueue(data.subarray(offset, offset + 32_000));
      controller.close();
    } }));
  };
  const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
  assert.deepEqual(await runtime.readArtifact(row, "nested/result.bin", data.length, new AbortController().signal), data);
  assert.equal(rawReads, 1);
  await assert.rejects(runtime.readArtifact(row, "x", 16 * 1024 * 1024 + 1, new AbortController().signal), /too_large/);
  await assert.rejects(runtime.readArtifact(row, "../private", data.length, new AbortController().signal), /path_invalid/);
});

test("large artifact reads require exact 206 ranges and never buffer an ignored Range response", async () => {
  const size = 1024 * 1024 * 1024, start = 32 * 1024 * 1024, length = 8 * 1024 * 1024;
  for (const mode of ["valid", "ignored", "wrong-range", "short", "overflow", "wrong-length"]) {
    let cancelled = false;
    const fetcher: Fetcher = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("assignments")) return json({ assignments: [{ endpoint: row.endpoint,
        runtimeProxyInfo: { url: "https://synthetic-proxy.example.test/base", token: PROXY } }] });
      if (url.pathname.includes("/api/contents/")) return json({ type: "file", size });
      assert.equal(new Headers(init?.headers).get("Range"), `bytes=${start}-${start + length - 1}`);
      assert.equal(new Headers(init?.headers).get("Accept-Encoding"), "identity");
      const headers: Record<string, string> = { "Content-Range": `bytes ${mode === "wrong-range" ? 0 : start}-${start + length - 1}/${size}` };
      if (mode === "wrong-length") headers["Content-Length"] = String(size);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        if (["ignored", "wrong-range", "wrong-length"].includes(mode)) return;
        controller.enqueue(new Uint8Array(length + (mode === "short" ? -1 : mode === "overflow" ? 1 : 0)));
        controller.close();
      }, cancel() { cancelled = true; } }), { status: mode === "ignored" ? 200 : 206, headers });
    };
    const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
    const read = runtime.readArtifactRange(row, "large.bin", size, start, length, new AbortController().signal);
    if (mode === "valid") assert.equal((await read).byteLength, length);
    else await assert.rejects(read, /range_unsupported|changed/);
    if (["ignored", "wrong-range", "wrong-length"].includes(mode)) assert.equal(cancelled, true);
    await assert.rejects(runtime.readArtifactRange(row, "x", size, -1, length, new AbortController().signal), /range_invalid/);
    await assert.rejects(runtime.readArtifactRange(row, "x", size, 0, length + 1, new AbortController().signal), /range_invalid/);
  }
});

test("largest cell (16,000 CJK characters) builds wrappers under a small stack and round-trips", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const wrapperModule = fileURLToPath(new URL("../lib/notebook/wrapper.ts", import.meta.url));
  const securityModule = fileURLToPath(new URL("../lib/platform/security.ts", import.meta.url));
  const script = `
    const { pythonWrapper, pythonWrapperSource } = await import(${JSON.stringify(wrapperModule)});
    const { base64 } = await import(${JSON.stringify(securityModule)});
    const source = "中".repeat(16000);
    const id = "11111111-1111-4111-8111-111111111111";
    const outer = pythonWrapper(id, id, source);
    const encoded = outer.match(/b64decode\\('([^']+)'\\)/)[1];
    const inner = Buffer.from(encoded, "base64").toString("utf8");
    if (inner !== pythonWrapperSource(id, id, source)) throw new Error("wrapper_round_trip");
    const bytes = new TextEncoder().encode(source);
    if (Buffer.from(base64(bytes), "base64").toString("utf8") !== source) throw new Error("base64_round_trip");
    console.log("ok", outer.length);
  `;
  const child = spawnSync(process.execPath, ["--stack-size=400", "--experimental-transform-types",
    "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr.split("\n").find((line) => /Error/.test(line)) ?? child.stderr);
  assert.match(child.stdout, /^ok \d+/);
});

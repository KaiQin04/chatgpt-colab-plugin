import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientPollError, startPolling } from "../ui/app/polling.ts";
import { NotebookApi } from "../ui/app/api.ts";

test("document polling recovers after a failed read without a document update", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = startPolling(async () => { calls++; return calls === 1 ? null : { state: "open" }; }, () => false, 2500);
  t.after(stop);
  t.mock.timers.tick(2500);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(2500);
  await Promise.resolve();
  assert.equal(calls, 2, "a failed read must not strand the busy gutter");
});

test("partial timeout documents recover by reads only; storage integrity failures stay explicit", async () => {
  const methods: string[] = [];
  const api = new NotebookApi({ mode: "site", onToolResult: () => () => {}, dispose: () => {}, call: async (name: string) => {
    methods.push(name);
    return { notebook: { id: "test" }, ...(methods.length === 1 ? { pollError: { code: "step_timeout", stage: "artifacts" } } : {}) };
  } });
  const pending = await api.document("test");
  assert.equal(pending.warning, "step_timeout");
  assert.equal(isTransientPollError(pending.warning), true);
  assert.equal((await api.document("test")).warning, undefined);
  assert.deepEqual(methods, ["get_notebook", "get_notebook"]);
  assert.equal(isTransientPollError("artifact_checksum_mismatch"), false);
  assert.equal(isTransientPollError("artifact_storage_readback_mismatch"), false);
  assert.equal(isTransientPollError("artifact_manifest_blocked"), false);
});

test("hidden tabs resume polling; pending reads never overlap and teardown cancels retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hidden = true, calls = 0;
  let finish!: () => void;
  const stop = startPolling(async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); }, () => hidden, 2500);
  t.after(stop);
  t.mock.timers.tick(2500);
  await Promise.resolve();
  assert.equal(calls, 0);
  hidden = false;
  t.mock.timers.tick(2500);
  await Promise.resolve();
  assert.equal(calls, 1);
  t.mock.timers.tick(25_000);
  assert.equal(calls, 1);
  stop();
  finish();
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(25_000);
  assert.equal(calls, 1);
});

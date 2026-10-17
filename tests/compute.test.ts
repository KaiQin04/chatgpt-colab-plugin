import assert from "node:assert/strict";
import { test } from "node:test";
import { observedCompute, selectCompute } from "../lib/notebook/compute.ts";
import { NotebookRuntime } from "../lib/notebook/runtime.ts";
import { validateNotebookArguments } from "../lib/notebook/tools.ts";
import { ColabClient, parseComputeInfo } from "../lib/colab/client.ts";
import type { Fetcher } from "../lib/platform/config.ts";
import { safeError } from "../lib/platform/security.ts";
import { ACCESS, json, PROXY } from "./helpers.ts";

test("dynamic GPU eligibility, explicit TPU rejection and deterministic pre-allocation AUTO", () => {
  assert.deepEqual(selectCompute("CPU", null), { kind: "CPU", accelerator: "CPU" });
  for (const gpu of ["G4", "A100", "L4", "T4", "H100", "FUTURE_GPU"]) {
    assert.deepEqual(selectCompute(gpu, [gpu]), { kind: "GPU", accelerator: gpu });
  }
  const remaining = ["G4", "H100", "A100", "T4", "L4"];
  for (const expected of ["L4", "T4", "A100", "G4", "H100"]) {
    assert.equal(selectCompute("AUTO", remaining).accelerator, expected);
    remaining.splice(remaining.indexOf(expected), 1);
  }
  for (const eligible of [null, [], ["TPU"], ["V5E1"], ["V6E1"]]) {
    assert.throws(() => selectCompute("AUTO", eligible));
  }
  assert.throws(() => selectCompute("L4", ["T4"]), /gpu_not_eligible/);
  for (const compute of ["TPU", "TPU_V5", "V5E1", "V6E1", "l4", "../L4"]) {
    assert.throws(() => validateNotebookArguments("open_notebook", {
      notebookId: crypto.randomUUID(), idempotencyKey: "test-compute-key", compute,
    }));
  }
});

test("account estimates are finite, zero-rate unknown, and depleted balance is a warning only", () => {
  const payload = { currentBalance: 100, consumptionRateHourly: 2, assignmentsCount: 1, eligibleGpus: ["L4"],
    secretField: PROXY, ineligibleTpus: ["V5E1"] };
  const info = parseComputeInfo(payload);
  assert.equal(info.estimatedHoursRemaining, 50); assert.equal(info.estimateScope, "account_current_rate");
  assert.equal(parseComputeInfo({ ...payload, consumptionRateHourly: 0 }).estimatedHoursRemaining, null);
  const depleted = parseComputeInfo({ ...payload, currentBalance: -1 });
  assert.equal(depleted.balanceWarning, "balance_depleted"); assert.equal(depleted.estimatedHoursRemaining, 0);
  assert.equal(parseComputeInfo({ ...payload, currentBalance: 1e308, consumptionRateHourly: 1e-308 }).estimatedHoursRemaining, null);
  assert.throws(() => parseComputeInfo({ ...payload, consumptionRateHourly: -1 }), /invalid/);
  assert.throws(() => parseComputeInfo({ ...payload, currentBalance: Infinity }), /invalid/);
  assert.ok(!JSON.stringify(info).includes(PROXY)); assert.ok(!JSON.stringify(info).includes("Tpus"));
});

test("assignment observation rejects guessed, missing, mismatched and TPU machines", () => {
  assert.equal(observedCompute({ accelerator: "NONE", variant: 0 }, selectCompute("CPU", null)).kind, "CPU");
  const selected = selectCompute("L4", ["L4"]);
  assert.equal(observedCompute({ accelerator: "L4", variant: 1 }, selected).accelerator, "L4");
  assert.throws(() => observedCompute({ accelerator: "T4", variant: 1 }, selected), /compute_mismatch/);
  assert.throws(() => observedCompute({ accelerator: "L4" }, selected), /compute_unverified/);
  assert.throws(() => observedCompute({ accelerator: "V5E1", variant: 2 }, selected), /compute_unverified/);
});

test("CPU/GPU assignment sends exact reference parameters and verifies the fresh owned listing", async () => {
  for (const accelerator of ["CPU", "L4", "T4", "A100", "G4", "H100"]) {
    let lists = 0, posts = 0, captures = 0;
    const selected = selectCompute(accelerator, [accelerator]);
    const fetcher: Fetcher = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("assignments")) {
        lists++;
        const previous = { endpoint: "user-existing", accelerator: "T4", variant: 1 };
        if (lists === 1) return json({ assignments: [previous] });
        assert.equal(captures, 1, "capture precedes compute verification");
        return json({ assignments: [previous, { endpoint: "owned", variant: selected.kind === "CPU" ? 0 : 1,
          accelerator: selected.kind === "CPU" ? "NONE" : accelerator, runtimeProxyInfo: { token: PROXY } }] });
      }
      assert.equal(url.pathname, "/tun/m/assign");
      assert.equal(url.searchParams.get("variant"), selected.kind === "CPU" ? "DEFAULT" : "GPU");
      assert.equal(url.searchParams.get("accelerator"), selected.kind === "CPU" ? null : accelerator);
      assert.equal(url.searchParams.get("shape"), null);
      assert.equal(url.searchParams.get("nbh"), "11111111_1111_4111_8111_111111111111........");
      if (init.method === "POST") { posts++; return json({ endpoint: "owned", accelerator: "untrusted-request-echo" }); }
      return json({ token: "synthetic-xsrf" });
    };
    const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
    const actual = await runtime.allocate("11111111-1111-4111-8111-111111111111", new AbortController().signal,
      async (value) => { assert.equal(value, "owned"); captures++; }, () => {}, selected);
    assert.equal(actual.accelerator, accelerator); assert.equal(posts, 1); assert.equal(lists, 2);
    assert.ok(!JSON.stringify(actual).includes(PROXY));
  }
});

test("known 412 is a direct refusal, transport/503 stays unknown, and neither retries nor falls back", async () => {
  for (const failure of ["412", "503", "transport"]) {
    let posts = 0, mayExist = false, captures = 0;
    const selected = selectCompute("AUTO", ["T4", "L4", "A100"]);
    const fetcher: Fetcher = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("assignments")) return json({ assignments: [] });
      assert.equal(url.searchParams.get("accelerator"), "L4");
      if (init.method !== "POST") return json({ token: "synthetic-xsrf" });
      posts++;
      if (failure === "transport") throw new TypeError(`failed ${PROXY}`);
      return json({ error: PROXY }, Number(failure));
    };
    const runtime = new NotebookRuntime(new ColabClient(ACCESS, fetcher), fetcher);
    try {
      await runtime.allocate(crypto.randomUUID(), new AbortController().signal, async () => { captures++; },
        (value) => { mayExist = value; }, selected);
      assert.fail("assignment must fail");
    } catch (error) {
      const safe = safeError(error);
      if (failure !== "transport") assert.equal(safe.httpStatus, Number(failure));
      assert.ok(!JSON.stringify(safe).includes(PROXY));
    }
    assert.equal(posts, 1); assert.equal(captures, 0); assert.equal(mayExist, failure !== "412");
  }
});

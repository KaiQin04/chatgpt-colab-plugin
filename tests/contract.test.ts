import assert from "node:assert/strict";
import { test } from "node:test";
import { FAILURE_FIELDS, isFailure } from "../lib/notebook/contract.ts";

test("isFailure flags every failure field, ok=false and released=false only", () => {
  assert.equal(isFailure({ notebook: {}, ok: true, released: true }), false);
  assert.equal(isFailure({}), false);
  assert.equal(isFailure({ ok: false }), true);
  assert.equal(isFailure({ released: false }), true);
  for (const field of FAILURE_FIELDS) {
    assert.equal(isFailure({ [field]: { code: "synthetic", stage: "test" } }), true, field);
    assert.equal(isFailure({ [field]: null }), false, field);
  }
});

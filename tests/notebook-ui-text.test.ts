import assert from "node:assert/strict";
import { test } from "node:test";
import { ansiSpans, formatBytes, formatDuration, lineDiff } from "../ui/app/text.ts";

test("ANSI tracebacks become classed spans; other escapes are dropped", () => {
  const spans = ansiSpans("\u001b[0;31mZeroDivisionError\u001b[0m: division\u001b[1m bold\u001b[0m\u001b[2K");
  assert.deepEqual(spans, [
    { text: "ZeroDivisionError", classes: ["ansi-red"] },
    { text: ": division", classes: [] },
    { text: " bold", classes: ["ansi-bold"] },
  ]);
  assert.deepEqual(ansiSpans("\u001b[38;5;196mred256\u001b[0m"), [{ text: "red256", classes: [] }]);
  assert.deepEqual(ansiSpans("plain"), [{ text: "plain", classes: [] }]);
});

test("line diff marks removed and added lines around shared context", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nx\nc"), [
    { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "x" }, { kind: "same", text: "c" },
  ]);
  const big = Array.from({ length: 600 }, (_, n) => String(n)).join("\n");
  const fallback = lineDiff(big, big + "\nnew");
  assert.equal(fallback.filter((line) => line.kind === "add").length, 601);
});

test("byte and duration formatting", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(84 * 1024), "84 KB");
  assert.equal(formatBytes(38.2 * 1024 * 1024), "38.2 MB");
  assert.equal(formatDuration(1200), "1.2 秒");
  assert.equal(formatDuration(134_000), "2 分 14 秒");
  assert.equal(formatDuration(7_260_000), "2 小時 1 分");
});

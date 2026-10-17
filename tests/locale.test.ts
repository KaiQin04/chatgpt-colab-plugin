import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLocale, initialLocale, rememberLocale, translate, traditionalChinese } from "../ui/app/i18n.ts";
import { ApiError, describe } from "../ui/app/api.ts";
import { formatAgo, formatDuration, formatNumber } from "../ui/app/text.ts";

test("language selection honors browser preference order and falls back to English", () => {
  assert.equal(browserLocale(["en-GB", "zh-TW"]), "en");
  assert.equal(browserLocale(["fr-FR", "zh-Hant-HK", "en"]), "zh-TW");
  assert.equal(browserLocale(["zh-CN"]), "zh-TW");
  assert.equal(browserLocale(["ja-JP"]), "en");
  assert.equal(browserLocale([]), "en");
});

test("saved selection wins; corrupt or blocked storage cannot prevent the UI from loading", () => {
  assert.equal(initialLocale({ getItem: () => "en" }, ["zh-TW"]), "en");
  assert.equal(initialLocale({ getItem: () => "zh-TW" }, ["en-US"]), "zh-TW");
  assert.equal(initialLocale({ getItem: () => "unknown" }, ["zh-TW"]), "zh-TW");
  const denied = () => { throw new Error("storage denied"); };
  assert.equal(initialLocale({ getItem: denied }, ["en-US"]), "en");
  assert.doesNotThrow(() => rememberLocale({ setItem: denied }, "en"));
  const saved: string[] = [];
  rememberLocale({ setItem: (_key, value) => saved.push(value) }, "zh-TW");
  assert.deepEqual(saved, ["zh-TW"]);
});

test("translations preserve placeholders and treat interpolated user content as plain text", () => {
  for (const [english, chinese] of Object.entries(traditionalChinese)) {
    const tokens = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(tokens(chinese), tokens(english), english);
    assert.ok(chinese.trim(), english);
  }
  assert.equal(translate("en", "Run by you"), "Run by you");
  assert.equal(translate("zh-TW", "Run by you"), "由你執行");
  assert.equal(translate("en", "Deleted “{title}”", { title: "<b>{title}</b>" }), "Deleted “<b>{title}</b>”");
});

test("time, number and error messages use the selected language", () => {
  assert.equal(formatDuration(134_000, "en"), "2 min 14 sec");
  assert.equal(formatDuration(134_000, "zh-TW"), "2 分 14 秒");
  assert.equal(formatAgo(0, 120_000, "en"), "2 minutes ago");
  assert.equal(formatAgo(0, 120_000, "zh-TW"), "2 分鐘前");
  assert.equal(formatNumber(null, 2, "en"), "Unknown");
  assert.equal(describe(new ApiError("cell_running"), "en"), "This cell is running; interrupt it first");
  assert.match(describe(new ApiError("new_error"), "en"), /new_error/);
});

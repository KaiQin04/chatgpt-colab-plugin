/** Dependency-free text helpers for the UI: ANSI tracebacks, line diffs and formatting. */

export type AnsiSpan = { text: string; classes: string[] };

const SGR_COLORS: Record<number, string> = {
  30: "ansi-dim", 31: "ansi-red", 32: "ansi-green", 33: "ansi-yellow", 34: "ansi-blue", 35: "ansi-magenta", 36: "ansi-cyan",
  90: "ansi-dim", 91: "ansi-red", 92: "ansi-green", 93: "ansi-yellow", 94: "ansi-blue", 95: "ansi-magenta", 96: "ansi-cyan",
};

/** Split ANSI SGR-coloured text (IPython tracebacks) into styled spans; other escapes are dropped. */
export function ansiSpans(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let color: string | null = null;
  let bold = false;
  const pattern = /\u001b\[([0-9;]*)([A-Za-z])/g;
  let last = 0;
  for (let match = pattern.exec(input); match; match = pattern.exec(input)) {
    if (match.index > last) spans.push({ text: input.slice(last, match.index), classes: [color, bold ? "ansi-bold" : null].filter(Boolean) as string[] });
    last = pattern.lastIndex;
    if (match[2] !== "m") continue;
    const codes = match[1] === "" ? [0] : match[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { color = null; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = null;
      else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : 4;
      else if (SGR_COLORS[code]) color = SGR_COLORS[code];
    }
  }
  if (last < input.length) spans.push({ text: input.slice(last), classes: [color, bold ? "ansi-bold" : null].filter(Boolean) as string[] });
  return spans.filter((span) => span.text.length > 0);
}

export type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** Line diff via LCS; bounded to keep the UI responsive on large cells. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
}

export function formatAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return "剛剛";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return new Date(timestamp).toLocaleDateString("zh-TW", { month: "long", day: "numeric" });
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: digits }) : "未知";
}

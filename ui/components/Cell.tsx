/** One notebook cell: gutter, code or Markdown, toolbar, meta line, outputs and conflict bar. */
import { memo } from "react";
import { useI18n } from "../app/Locale.tsx";
import type { CellView, FullCellView, RunView } from "../../lib/notebook/contract.ts";
import type { RunResult } from "../../lib/notebook/types.ts";
import { MAX_OUTPUT_BYTES } from "../../lib/notebook/types.ts";
import { base64PngWithinLimits } from "../../lib/notebook/png.ts";
import { renderMarkdown } from "../app/markdown.ts";
import { isTransientPollError } from "../app/polling.ts";
import { ansiSpans, formatAgo, formatDuration, lineDiff } from "../app/text.ts";
import { CodeEditor, StaticCode } from "./code.tsx";
import type { EditorCommands } from "./code.tsx";
import { Icon } from "./icons.tsx";

export type Draft = { source: string; kind: "code" | "markdown"; baseVersion: number; status: "dirty" | "saving" | "error" };
export type Conflict = { theirs: string; theirsVersion: number; showDiff: boolean };

const ACTIVE = new Set(["dispatching", "submitted", "running", "unknown"]);

function Ansi({ text, className }: { text: string; className?: string }) {
  return <pre className={className}>{ansiSpans(text).map((span, index) => span.classes.length
    ? <span key={index} className={span.classes.join(" ")}>{span.text}</span> : span.text)}</pre>;
}

function Outputs({ result }: { result: RunResult }) {
  const { t } = useI18n();
  return <>
    {result.outputs.map((output, index) => {
      if (output.output_type === "stream") {
        return <Ansi key={index} text={output.text} className={output.name === "stderr" ? "stderr" : undefined} />;
      }
      if (output.output_type === "error") {
        return <div key={index} className="error-out">
          <div className="ename">{output.ename}: {output.evalue}</div>
          {output.traceback.length > 0 && <Ansi text={output.traceback.join("\n")} />}
        </div>;
      }
      const png = output.data["image/png"];
      if (typeof png === "string" && png.length <= MAX_OUTPUT_BYTES && /^iVBORw0KGgo[A-Za-z0-9+/=\r\n]*$/.test(png) && base64PngWithinLimits(png)) {
        return <img key={index} alt={t("Cell image output")} src={`data:image/png;base64,${png}`} />;
      }
      const text = output.data["text/plain"];
      return typeof text === "string" ? <Ansi key={index} text={text} /> : null;
    })}
    {result.truncated && <div className="note">{t("Output limit reached; additional output was not captured.")}</div>}
  </>;
}

export type CellProps = {
  cell: CellView; index: number; total: number;
  selected: boolean; editing: boolean; activeRun: boolean;
  draft?: Draft; conflict?: Conflict; loadedRun?: RunView; now: number;
  onSelect(edit: boolean): void;
  onMove(delta: -1 | 1): void; onDelete(): void; onToggleKind(): void; onInterrupt(): void;
  onResolve(choice: "theirs" | "mine" | "diff"): void; onLoadOutput(runId: string): void;
  /** Focus left this cell's editor area (Jupyter: back to command mode). */
  onLeave(): void;
} & EditorCommands;

export const Cell = memo(function Cell(props: CellProps) {
  const { t, locale } = useI18n();
  const { cell, draft, conflict } = props;
  const full = cell.outline ? null : cell as FullCellView;
  const source = draft?.source ?? full?.source ?? (cell.outline ? cell.preview : "");
  const kind = draft?.kind ?? cell.kind;
  const lastRun = full?.lastRun ?? null;
  const run = props.loadedRun && lastRun && props.loadedRun.id === lastRun.id ? props.loadedRun : lastRun;
  const result = run?.result ?? null;
  const active = Boolean(run && ACTIVE.has(run.state)) || props.activeRun;
  const count = active ? "[*]" : result?.executionCount ? `[${result.executionCount}]` : kind === "code" ? "[ ]" : "";
  const started = result?.startedAt ?? run?.createdAt;
  const elapsed = result?.finishedAt && result.startedAt ? result.finishedAt - result.startedAt
    : active && started ? props.now - started : null;
  const saveText = draft ? { dirty: t("Unsaved"), saving: t("Saving"), error: t("Save failed") }[draft.status] : `v${cell.version}`;

  return (
    <section className={`cell${props.selected ? " selected" : ""}`} aria-label={t("Cell {number}, {kind}", { number: props.index + 1, kind: kind === "code" ? t("Code") : "Markdown" })}
      data-cell-id={cell.id} onMouseDown={() => { if (!props.selected) props.onSelect(false); }}>
      <div className="gutter">{active ? <span className="busy">{count}</span> : count}</div>
      <div className="cell-main">
        {conflict && <>
          <div className="conflict" role="status">
            <span className="status status-watch">{t("Watch")}</span>
            <span>{t("ChatGPT updated this cell while you were editing (v{from} → v{to})", { from: draft?.baseVersion ?? "?", to: conflict.theirsVersion })}</span>
            <span className="actions">
              <button type="button" className="link-btn" onClick={() => props.onResolve("diff")}>{conflict.showDiff ? t("Hide diff") : t("Compare changes")}</button>
              <button type="button" className="link-btn" onClick={() => props.onResolve("theirs")}>{t("Use ChatGPT version")}</button>
              <button type="button" className="link-btn" onClick={() => props.onResolve("mine")}>{t("Keep my changes")}</button>
            </span>
          </div>
          {conflict.showDiff && <pre className="diff" aria-label={t("Diff: red lines are removed from ChatGPT's version; green lines are your changes")}>
            {lineDiff(conflict.theirs, source).map((line, index) => (
              <div key={index} className={line.kind === "same" ? undefined : line.kind}>
                {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}{line.text}
              </div>))}
          </pre>}
        </>}
        {kind === "markdown" && !props.editing
          ? <div className={`md${source ? "" : " empty"}`} onDoubleClick={() => props.onSelect(true)}
              {...(source ? { dangerouslySetInnerHTML: { __html: renderMarkdown(source) } } : { children: t("Empty Markdown; double-click to edit") })} />
          : <div className={`cell-input${props.editing ? " editing" : ""}`} onClick={() => { if (!props.editing && !cell.outline) props.onSelect(true); }}
              onBlur={(event) => { if (props.editing && !event.currentTarget.contains(event.relatedTarget as Node | null)) props.onLeave(); }}>
              {props.selected && <div className="tools" role="toolbar" aria-label={t("Cell tools")}>
                {kind === "code" && (active
                  ? <button type="button" className="icon-btn" aria-label={t("Interrupt execution")} title={t("Interrupt execution")} onClick={(event) => { event.stopPropagation(); props.onInterrupt(); }}><Icon.stop /></button>
                  : <button type="button" className="icon-btn" aria-label={t("Run this cell")} title={t("Run (Shift + Enter)")} onClick={(event) => { event.stopPropagation(); props.onRun(false); }}><Icon.run /></button>)}
                <button type="button" className="icon-btn" aria-label={t("Move up")} title={t("Move up (Alt + ↑)")} disabled={props.index === 0} onClick={(event) => { event.stopPropagation(); props.onMove(-1); }}><Icon.up /></button>
                <button type="button" className="icon-btn" aria-label={t("Move down")} title={t("Move down (Alt + ↓)")} disabled={props.index === props.total - 1} onClick={(event) => { event.stopPropagation(); props.onMove(1); }}><Icon.down /></button>
                <button type="button" className="icon-btn" aria-label={kind === "code" ? t("Convert to Markdown") : t("Convert to code")} title={kind === "code" ? t("Convert to Markdown (M)") : t("Convert to code (Y)")} onClick={(event) => { event.stopPropagation(); props.onToggleKind(); }}><Icon.type /></button>
                <button type="button" className="icon-btn" aria-label={t("Delete this cell")} title={t("Delete (D D)")} disabled={active} onClick={(event) => { event.stopPropagation(); props.onDelete(); }}><Icon.trash /></button>
              </div>}
              {props.editing
                ? <CodeEditor value={source} language={kind === "code" ? "python" : "text"} label={t("Cell {number}", { number: props.index + 1 })}
                    placeholder={kind === "code" ? t("Enter Python; Shift + Enter to run") : t("Enter Markdown")}
                    onChange={props.onChange} onRun={props.onRun} onEscape={props.onEscape} onSaveNow={props.onSaveNow} onBlur={props.onBlur} />
                : <StaticCode source={source} language={kind === "code" ? "python" : "text"} placeholder={t("Enter Python; Shift + Enter to run")} />}
            </div>}
        <div className="meta">
          <span className={`who${cell.updatedBy === "assistant" ? " assistant" : ""}`}>{cell.updatedBy === "assistant" ? "ChatGPT" : t("You")}</span>
          <span className="sep">{formatAgo(cell.updatedAt, props.now, locale)}</span>
          {active && <span className="sep running">{t("Executing")}{elapsed !== null ? ` ${formatDuration(elapsed, locale)}` : ""}</span>}
          {!active && elapsed !== null && <span className="sep">{formatDuration(elapsed, locale)}</span>}
          <span className={`sep${draft?.status === "error" ? " save-error" : ""}`}>{saveText}</span>
          {run && run.cellVersion !== cell.version && !active && <span className="sep">{t("Output from v{version}", { version: run.cellVersion })}</span>}
          {run?.actor && <span className="sep">{t(run.actor === "assistant" ? "Run by ChatGPT" : "Run by you")}</span>}
        </div>
        {run && (result || run.error || run.outputsOmitted) && <div className="output" aria-live={active ? "polite" : undefined}>
          {result && <Outputs result={result} />}
          {!result && run.outputsOmitted && <div className="note">{t("Large output was not loaded with the document.")}
            <button type="button" className="link-btn" onClick={() => props.onLoadOutput(run.id)}>{t("Load output")}</button></div>}
          {run.state === "interrupted" && <div className="note">{t("Interrupted.")}</div>}
          {run.state === "incomplete" && <div className="note">{t("Incomplete result ({reason}).", { reason: run.error?.code ?? t("unknown reason") })}</div>}
          {run.artifactsState === "blocked" && <div className="note save-error">{isTransientPollError(run.artifactError?.code)
            ? t("Artifact saving timed out. Rechecking; the runtime will stay until saving is confirmed.")
            : t("Artifact saving is blocked; the runtime will stay for recovery.")}</div>}
        </div>}
      </div>
    </section>
  );
});

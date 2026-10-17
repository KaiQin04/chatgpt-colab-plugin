/** One notebook cell: gutter, code or Markdown, toolbar, meta line, outputs and conflict bar. */
import { memo } from "react";
import type { CellView, FullCellView, RunView } from "../../lib/notebook/contract.ts";
import type { RunResult } from "../../lib/notebook/types.ts";
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
      if (typeof png === "string" && /^iVBORw0KGgo[A-Za-z0-9+/=\r\n]*$/.test(png)) {
        return <img key={index} alt="Cell 圖片輸出" src={`data:image/png;base64,${png}`} />;
      }
      const text = output.data["text/plain"];
      return typeof text === "string" ? <Ansi key={index} text={text} /> : null;
    })}
    {result.truncated && <div className="note">輸出已達上限，後續內容未收錄。</div>}
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
  const saveText = draft ? { dirty: "尚未儲存", saving: "儲存中", error: "儲存失敗" }[draft.status] : `v${cell.version}`;

  return (
    <section className={`cell${props.selected ? " selected" : ""}`} aria-label={`第 ${props.index + 1} 格，${kind === "code" ? "程式碼" : "Markdown"}`}
      data-cell-id={cell.id} onMouseDown={() => { if (!props.selected) props.onSelect(false); }}>
      <div className="gutter">{active ? <span className="busy">{count}</span> : count}</div>
      <div className="cell-main">
        {conflict && <>
          <div className="conflict" role="status">
            <span className="status status-watch">觀察</span>
            <span>ChatGPT 在你編輯時更新了這一格（v{draft?.baseVersion ?? "?"} → v{conflict.theirsVersion}）</span>
            <span className="actions">
              <button type="button" className="link-btn" onClick={() => props.onResolve("diff")}>{conflict.showDiff ? "隱藏差異" : "比較差異"}</button>
              <button type="button" className="link-btn" onClick={() => props.onResolve("theirs")}>採用 ChatGPT 版本</button>
              <button type="button" className="link-btn" onClick={() => props.onResolve("mine")}>保留我的修改</button>
            </span>
          </div>
          {conflict.showDiff && <pre className="diff" aria-label="差異：紅色是 ChatGPT 版本刪除的行，綠色是你的修改">
            {lineDiff(conflict.theirs, source).map((line, index) => (
              <div key={index} className={line.kind === "same" ? undefined : line.kind}>
                {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}{line.text}
              </div>))}
          </pre>}
        </>}
        {kind === "markdown" && !props.editing
          ? <div className={`md${source ? "" : " empty"}`} onDoubleClick={() => props.onSelect(true)}
              {...(source ? { dangerouslySetInnerHTML: { __html: renderMarkdown(source) } } : { children: "空白 Markdown，按兩下編輯" })} />
          : <div className={`cell-input${props.editing ? " editing" : ""}`} onClick={() => { if (!props.editing && !cell.outline) props.onSelect(true); }}
              onBlur={(event) => { if (props.editing && !event.currentTarget.contains(event.relatedTarget as Node | null)) props.onLeave(); }}>
              {props.selected && <div className="tools" role="toolbar" aria-label="這一格的工具">
                {kind === "code" && (active
                  ? <button type="button" className="icon-btn" aria-label="中斷執行" title="中斷執行" onClick={(event) => { event.stopPropagation(); props.onInterrupt(); }}><Icon.stop /></button>
                  : <button type="button" className="icon-btn" aria-label="執行這一格" title="執行（Shift + Enter）" onClick={(event) => { event.stopPropagation(); props.onRun(false); }}><Icon.run /></button>)}
                <button type="button" className="icon-btn" aria-label="上移" title="上移（Alt + ↑）" disabled={props.index === 0} onClick={(event) => { event.stopPropagation(); props.onMove(-1); }}><Icon.up /></button>
                <button type="button" className="icon-btn" aria-label="下移" title="下移（Alt + ↓）" disabled={props.index === props.total - 1} onClick={(event) => { event.stopPropagation(); props.onMove(1); }}><Icon.down /></button>
                <button type="button" className="icon-btn" aria-label={kind === "code" ? "轉成 Markdown" : "轉成程式碼"} title={kind === "code" ? "轉成 Markdown（M）" : "轉成程式碼（Y）"} onClick={(event) => { event.stopPropagation(); props.onToggleKind(); }}><Icon.type /></button>
                <button type="button" className="icon-btn" aria-label="刪除這一格" title="刪除（D D）" disabled={active} onClick={(event) => { event.stopPropagation(); props.onDelete(); }}><Icon.trash /></button>
              </div>}
              {props.editing
                ? <CodeEditor value={source} language={kind === "code" ? "python" : "text"} label={`第 ${props.index + 1} 格`}
                    placeholder={kind === "code" ? "輸入 Python，Shift + Enter 執行" : "輸入 Markdown"}
                    onChange={props.onChange} onRun={props.onRun} onEscape={props.onEscape} onSaveNow={props.onSaveNow} onBlur={props.onBlur} />
                : <StaticCode source={source} language={kind === "code" ? "python" : "text"} placeholder="輸入 Python，Shift + Enter 執行" />}
            </div>}
        <div className="meta">
          <span className={`who${cell.updatedBy === "assistant" ? " assistant" : ""}`}>{cell.updatedBy === "assistant" ? "ChatGPT" : "你"}</span>
          <span className="sep">{formatAgo(cell.updatedAt, props.now)}</span>
          {active && <span className="sep running">執行中{elapsed !== null ? ` ${formatDuration(elapsed)}` : ""}</span>}
          {!active && elapsed !== null && <span className="sep">{formatDuration(elapsed)}</span>}
          <span className={`sep${draft?.status === "error" ? " save-error" : ""}`}>{saveText}</span>
          {run && run.cellVersion !== cell.version && !active && <span className="sep">輸出來自 v{run.cellVersion}</span>}
          {run?.actor && <span className="sep">由{run.actor === "assistant" ? " ChatGPT " : "你"}執行</span>}
        </div>
        {run && (result || run.error || run.outputsOmitted) && <div className="output" aria-live={active ? "polite" : undefined}>
          {result && <Outputs result={result} />}
          {!result && run.outputsOmitted && <div className="note">輸出較大，未隨文件載入。
            <button type="button" className="link-btn" onClick={() => props.onLoadOutput(run.id)}>載入輸出</button></div>}
          {run.state === "interrupted" && <div className="note">已中斷。</div>}
          {run.state === "incomplete" && <div className="note">結果不完整（{run.error?.code ?? "未知原因"}）。</div>}
          {run.artifactsState === "blocked" && <div className="note save-error">{isTransientPollError(run.artifactError?.code)
            ? "成品保存暫時逾時，正在重新確認；保存確認前會保留 runtime。"
            : "成品保存受阻，runtime 會保留到救援完成。"}</div>}
        </div>}
      </div>
    </section>
  );
});

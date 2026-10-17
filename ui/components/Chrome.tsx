/** Top bar, status bar, menus, dialogs and toasts. */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NotebookView } from "../../lib/notebook/contract.ts";
import type { ComputeStatus } from "../app/api.ts";
import { formatDuration, formatNumber } from "../app/text.ts";
import { Icon } from "./icons.tsx";

export function machineLabel(notebook: NotebookView): string {
  const runtime = notebook.runtime;
  if (!runtime || runtime.released) return "未開機";
  if (runtime.computeVerified && runtime.accelerator) return runtime.accelerator;
  return `${runtime.selectedAccelerator ?? runtime.requestedCompute}（核對中）`;
}

export function runtimeStatus(notebook: NotebookView): { label: string; tone: "ok" | "watch" | "alert" | "idle" } {
  switch (notebook.state) {
    case "open": return { label: `${machineLabel(notebook)} 已連線`, tone: "ok" };
    case "opening": return { label: "開機中", tone: "watch" };
    case "preparing": return { label: "準備環境中", tone: "watch" };
    case "importing": return { label: "匯入附件中", tone: "watch" };
    case "interrupting": return { label: "中斷處理中", tone: "watch" };
    case "closing": return { label: "關閉中", tone: "watch" };
    case "unknown": return { label: "狀態不明", tone: "alert" };
    case "deleting": return { label: "刪除中", tone: "alert" };
    default: return { label: "runtime 已關閉", tone: "idle" };
  }
}

export function Menu(props: { label: string; items: { label: string; onSelect(): void; danger?: boolean; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  return (
    <div className="rel" ref={ref}>
      <button type="button" className="icon-btn" aria-label={props.label} title={props.label} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}><Icon.more /></button>
      {open && <div className="menu" role="menu">
        {props.items.map((item) => (
          <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled}
            onClick={() => { setOpen(false); item.onSelect(); }}>{item.label}</button>))}
      </div>}
    </div>
  );
}

export function Dialog(props: { title: string; children: ReactNode; onClose(): void; actions: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, input")?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); previous?.focus(); };
  }, [props]);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <h2>{props.title}</h2>
        {props.children}
        <div className="actions">{props.actions}</div>
      </div>
    </div>
  );
}

export type ToastState = { text: string; error?: boolean; action?: { label: string; run(): void } } | null;

export function Toast(props: { toast: ToastState; onDone(): void }) {
  useEffect(() => {
    if (!props.toast) return;
    const timer = setTimeout(props.onDone, props.toast.action ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [props.toast, props.onDone]);
  if (!props.toast) return null;
  return (
    <div className={`toast${props.toast.error ? " error" : ""}`} role="status" aria-live="polite">
      <span>{props.toast.text}</span>
      {props.toast.action && <button type="button" className="link-btn" onClick={() => { props.toast!.action!.run(); props.onDone(); }}>{props.toast.action.label}</button>}
    </div>
  );
}

export function StatusBar(props: { notebook: NotebookView | null; compute: ComputeStatus | null; now: number; saving: boolean }) {
  const { notebook, compute } = props;
  const status = notebook ? runtimeStatus(notebook) : null;
  const idleLeft = notebook?.idle && notebook.state === "open" && !notebook.activeRunId
    ? notebook.idle.since + notebook.idle.milliseconds - props.now : null;
  const kernel = !notebook || notebook.state !== "open" ? null : notebook.activeRunId ? "kernel 忙碌" : "kernel 閒置";
  return (
    <footer className="statusbar">
      {status && <span className={`status status-${status.tone}`}>{status.label}</span>}
      {kernel && <span>{kernel}</span>}
      {idleLeft !== null && <span className="optional">{idleLeft > 0 ? `閒置 ${formatDuration(idleLeft)}後釋放` : "已達閒置門檻，等待巡檢釋放"}</span>}
      <span className="grow" />
      {compute && <span>餘額 <span className="num">{formatNumber(compute.currentBalance)}</span> units</span>}
      {compute && <span className="optional"><span className="num">{formatNumber(compute.consumptionRateHourly)}</span> units/hr
        {compute.estimatedHoursRemaining ? <> · 約 <span className="num">{formatNumber(compute.estimatedHoursRemaining, 0)}</span> 小時</> : null}</span>}
      {compute?.balanceWarning && <span className="status status-watch">餘額偏低</span>}
      {notebook && <span className="optional">{props.saving ? "儲存中" : `已儲存 v${notebook.version}`}</span>}
    </footer>
  );
}

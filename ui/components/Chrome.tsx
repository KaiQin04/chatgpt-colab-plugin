/** Top bar, status bar, menus, dialogs and toasts. */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { NotebookView } from "../../lib/notebook/contract.ts";
import type { ComputeStatus } from "../app/api.ts";
import { formatDuration, formatNumber } from "../app/text.ts";
import { useI18n } from "../app/Locale.tsx";
import { translate } from "../app/i18n.ts";
import type { Locale } from "../app/i18n.ts";
import { Icon } from "./icons.tsx";

export function machineLabel(notebook: NotebookView, locale: Locale = "zh-TW"): string {
  const runtime = notebook.runtime;
  if (!runtime || runtime.released) return translate(locale, "Not started");
  if (runtime.computeVerified && runtime.accelerator) return runtime.accelerator;
  return translate(locale, "{machine} (verifying)", { machine: runtime.selectedAccelerator ?? runtime.requestedCompute });
}

export function runtimeStatus(notebook: NotebookView, locale: Locale = "zh-TW"): { label: string; tone: "ok" | "watch" | "alert" | "idle" } {
  const t = (message: Parameters<typeof translate>[1]) => translate(locale, message);
  switch (notebook.state) {
    case "open": return { label: translate(locale, "{machine} connected", { machine: machineLabel(notebook, locale) }), tone: "ok" };
    case "opening": return { label: t("Starting"), tone: "watch" };
    case "preparing": return { label: t("Preparing environment"), tone: "watch" };
    case "importing": return { label: t("Importing attachments"), tone: "watch" };
    case "interrupting": return { label: t("Interrupting"), tone: "watch" };
    case "closing": return { label: t("Closing"), tone: "watch" };
    case "unknown": return { label: t("Unknown state"), tone: "alert" };
    case "deleting": return { label: t("Deleting"), tone: "alert" };
    default: return { label: t("Runtime closed"), tone: "idle" };
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
  const { t, locale } = useI18n();
  const { notebook, compute } = props;
  const status = notebook ? runtimeStatus(notebook, locale) : null;
  const idleLeft = notebook?.idle && notebook.state === "open" && !notebook.activeRunId
    ? notebook.idle.since + notebook.idle.milliseconds - props.now : null;
  const kernel = !notebook || notebook.state !== "open" ? null : notebook.activeRunId ? t("Kernel busy") : t("Kernel idle");
  return (
    <footer className="statusbar">
      {status && <span className={`status status-${status.tone}`}>{status.label}</span>}
      {kernel && <span>{kernel}</span>}
      {idleLeft !== null && <span className="optional">{idleLeft > 0 ? t("Releases after {duration} idle", { duration: formatDuration(idleLeft, locale) }) : t("Idle limit reached; awaiting cleanup")}</span>}
      <span className="grow" />
      {compute && <span>{t("Balance")} <span className="num">{formatNumber(compute.currentBalance, 2, locale)}</span> units</span>}
      {compute && <span className="optional"><span className="num">{formatNumber(compute.consumptionRateHourly, 2, locale)}</span> units/hr
        {compute.estimatedHoursRemaining ? <> · {t("About {hours} hours", { hours: formatNumber(compute.estimatedHoursRemaining, 0, locale) })}</> : null}</span>}
      {compute?.balanceWarning && <span className="status status-watch">{t("Low balance")}</span>}
      {notebook && <span className="optional">{props.saving ? t("Saving") : t("Saved v{version}", { version: notebook.version })}</span>}
    </footer>
  );
}

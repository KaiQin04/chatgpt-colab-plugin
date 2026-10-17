/** Notebook application: document sync, autosave, runs, structure edits and keyboard model. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CellView, FullCellView, NotebookView, RunView } from "../../lib/notebook/contract.ts";
import type { ToolResult } from "../../lib/notebook/client.ts";
import { Cell } from "../components/Cell.tsx";
import type { Conflict, Draft } from "../components/Cell.tsx";
import { Dialog, Menu, runtimeStatus, StatusBar, Toast } from "../components/Chrome.tsx";
import type { ToastState } from "../components/Chrome.tsx";
import { Drawer } from "../components/Drawer.tsx";
import { Home } from "../components/Home.tsx";
import { Icon } from "../components/icons.tsx";
import { ApiError, describe } from "./api.ts";
import type { ComputeStatus, DeletePreview, NotebookApi, NotebookSummary } from "./api.ts";
import { formatBytes } from "./text.ts";
import { isTransientPollError, startPolling } from "./polling.ts";

const AUTOSAVE_MS = 1500;
const POLL_MS = 2500;
const IDLE_REFRESH_MS = 20_000;
const TERMINAL = new Set(["ok", "error", "interrupted", "incomplete"]);
const TRANSITIONAL = new Set(["opening", "preparing", "importing", "interrupting", "closing"]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type DialogState =
  | { kind: "delete"; preview: DeletePreview }
  | { kind: "rename"; id: string; title: string }
  | { kind: "discard"; notebookId: string };

function fullSource(cell: CellView | undefined): string | null {
  return cell && !cell.outline ? (cell as FullCellView).source : null;
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
    || element.closest(".cm-editor")));
}

export function App(props: {
  api: NotebookApi; siteOrigin: string; openLink(url: string): void;
  onToolResult(listener: (value: ToolResult) => void): () => void;
}) {
  const { api } = props;
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [compute, setCompute] = useState<ComputeStatus | null>(null);
  const [doc, setDoc] = useState<NotebookView | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [conflicts, setConflicts] = useState<Record<string, Conflict>>({});
  const [loadedRuns, setLoadedRuns] = useState<Record<string, RunView>>({});
  const [toast, setToast] = useState<ToastState>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 1100);
  const [now, setNow] = useState(() => Date.now());
  const [runAll, setRunAll] = useState<{ total: number; done: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [openCompute, setOpenCompute] = useState("CPU");

  // Refs mirror state for async handlers; every writer also updates them synchronously.
  const docRef = useRef(doc);
  const draftsRef = useRef(drafts);
  const conflictsRef = useRef(conflicts);
  useLayoutEffect(() => { docRef.current = doc; draftsRef.current = drafts; conflictsRef.current = conflicts; }, [doc, drafts, conflicts]);
  const saveCellRef = useRef<(cellId: string) => Promise<void>>(async () => {});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saving = useRef(new Map<string, Promise<void>>());
  const refreshing = useRef<Promise<NotebookView | null> | null>(null);
  const pollToast = useRef<ToastState>(null);
  const runAllCancel = useRef<{ cancelled: boolean } | null>(null);
  const cellsRef = useRef<HTMLElement>(null);
  const lastD = useRef(0);

  const notify = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const fail = useCallback((error: unknown) => setToast({ text: describe(error), error: true }), []);

  const setDraft = (cellId: string, draft: Draft | null) => {
    const next = { ...draftsRef.current };
    if (draft) next[cellId] = draft; else delete next[cellId];
    draftsRef.current = next; setDrafts(next);
  };
  const setConflict = (cellId: string, conflict: Conflict | null) => {
    const next = { ...conflictsRef.current };
    if (conflict) next[cellId] = conflict; else delete next[cellId];
    conflictsRef.current = next; setConflicts(next);
  };

  /** Adopt a server document, reconciling local drafts (converged, deleted or conflicting). */
  const adopt = useCallback((next: NotebookView) => {
    if (docRef.current && docRef.current.id !== next.id) return;
    docRef.current = next; setDoc(next);
    for (const [cellId, draft] of Object.entries(draftsRef.current)) {
      const cell = next.cells.find((item) => item.id === cellId);
      const source = fullSource(cell);
      if (!cell) { setDraft(cellId, null); setConflict(cellId, null); continue; }
      if (cell.version > draft.baseVersion && draft.status !== "saving" && source !== null) {
        if (source === draft.source && cell.kind === draft.kind) { setDraft(cellId, null); setConflict(cellId, null); }
        else if (!conflictsRef.current[cellId] || conflictsRef.current[cellId].theirsVersion !== cell.version) {
          setConflict(cellId, { theirs: source, theirsVersion: cell.version, showDiff: false });
        }
      }
    }
    setSelected((current) => current && next.cells.some((cell) => cell.id === current) ? current : next.cells[0]?.id ?? null);
  }, []);

  /** Reload the document; `force` waits out an in-flight (possibly stale) request and fetches again. */
  const refresh = useCallback(async (force = false): Promise<NotebookView | null> => {
    const current = docRef.current;
    if (!current) return null;
    if (refreshing.current) {
      const pending = refreshing.current;
      if (!force) return pending;
      await pending;
      if (refreshing.current) return refreshing.current;
    }
    refreshing.current = (async () => {
      try {
        const result = await api.document(current.id);
        adopt(result.notebook);
        if (result.warning) {
          const temporary = isTransientPollError(result.warning);
          pollToast.current = { text: temporary ? "狀態讀取暫時逾時，正在重新確認；不會重複執行。" : describe(new ApiError(result.warning)), error: !temporary };
          setToast(pollToast.current);
        } else {
          const previous = pollToast.current;
          setToast((currentToast) => currentToast === previous ? null : currentToast);
          pollToast.current = null;
        }
        return result.notebook;
      } catch (error) {
        const temporary = error instanceof ApiError && isTransientPollError(error.code);
        pollToast.current = { text: temporary ? "狀態讀取暫時逾時，正在重新確認；不會重複執行。" : describe(error), error: !temporary };
        setToast(pollToast.current);
        return null;
      }
      finally { refreshing.current = null; }
    })();
    return refreshing.current;
  }, [api, adopt]);

  const loadHome = useCallback(async () => {
    try { setNotebooks(await api.list()); } catch (error) { fail(error); }
    try { setCompute(await api.compute()); } catch { /* Balance is optional on the home view. */ }
  }, [api, fail]);

  useEffect(() => {
    let alive = true;
    api.list().then((rows) => { if (alive) setNotebooks(rows); }, fail);
    api.compute().then((value) => { if (alive) setCompute(value); }, () => { /* Balance is optional. */ });
    return () => { alive = false; };
  }, [api, fail]);

  // Host-pushed results (MCP Apps) keep the panel in sync with ChatGPT's own tool calls.
  useEffect(() => props.onToolResult((value) => {
    const notebook = value.notebook as NotebookView | undefined;
    if (notebook && docRef.current?.id === notebook.id && notebook.view === "full") adopt(notebook);
  }), [props, adopt]);

  // Poll while work is in flight; otherwise refresh slowly to pick up ChatGPT edits.
  useEffect(() => {
    if (!doc) return;
    const active = Boolean(doc.activeRunId || doc.activeInputId || doc.activeSetupId) || TRANSITIONAL.has(doc.state);
    return startPolling(() => refresh(), () => document.hidden, active ? POLL_MS : IDLE_REFRESH_MS);
  }, [doc, refresh]);

  useEffect(() => {
    const busy = Boolean(doc?.activeRunId) || TRANSITIONAL.has(doc?.state ?? "");
    const timer = setInterval(() => setNow(Date.now()), busy ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [doc?.activeRunId, doc?.state]);

  // On narrow layouts the drawer is an overlay: close it when the viewport becomes narrow.
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1100px)");
    const onChange = () => { if (narrow.matches) setDrawerOpen(false); };
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!selected) return;
    document.querySelector(`[data-cell-id="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ---------- Saving ----------
  const scheduleSave = useCallback((cellId: string) => {
    clearTimeout(timers.current.get(cellId));
    timers.current.set(cellId, setTimeout(() => { timers.current.delete(cellId); void saveCellRef.current(cellId); }, AUTOSAVE_MS));
  }, []);

  const saveCell = useCallback(async (cellId: string): Promise<void> => {
    const pending = saving.current.get(cellId);
    if (pending) { await pending; return saveCellRef.current(cellId); }
    const draft = draftsRef.current[cellId];
    const notebook = docRef.current;
    if (!draft || !notebook || conflictsRef.current[cellId]) return;
    const task = (async () => {
      setDraft(cellId, { ...draft, status: "saving" });
      try {
        const result = await api.save({ notebookId: notebook.id, cellId, kind: draft.kind, source: draft.source, expectedVersion: draft.baseVersion });
        const savedVersion = result.notebook.cells.find((cell) => cell.id === cellId)?.version ?? draft.baseVersion + 1;
        const latest = draftsRef.current[cellId];
        if (latest && latest.source === draft.source && latest.kind === draft.kind) setDraft(cellId, null);
        else if (latest) setDraft(cellId, { ...latest, baseVersion: savedVersion, status: "dirty" });
        adopt(result.notebook);
        if (draftsRef.current[cellId]) scheduleSave(cellId);
      } catch (error) {
        const latest = draftsRef.current[cellId] ?? draft;
        setDraft(cellId, { ...latest, status: error instanceof ApiError && error.code.includes("version_conflict") ? "dirty" : "error" });
        if (error instanceof ApiError && error.code.includes("version_conflict")) await refresh(true);
        else fail(error);
      }
    })();
    saving.current.set(cellId, task);
    try { await task; } finally { saving.current.delete(cellId); }
  }, [api, adopt, refresh, fail, scheduleSave]);
  useLayoutEffect(() => { saveCellRef.current = saveCell; }, [saveCell]);

  /** Save now; true when the cell has no unsaved changes afterwards. */
  const flush = useCallback(async (cellId: string): Promise<boolean> => {
    clearTimeout(timers.current.get(cellId)); timers.current.delete(cellId);
    if (draftsRef.current[cellId]) await saveCell(cellId);
    return !draftsRef.current[cellId] && !conflictsRef.current[cellId];
  }, [saveCell]);

  const edit = useCallback((cellId: string, change: Partial<Pick<Draft, "source" | "kind">>) => {
    const cell = docRef.current?.cells.find((item) => item.id === cellId);
    const source = fullSource(cell);
    if (!cell || source === null) return;
    const current = draftsRef.current[cellId];
    setDraft(cellId, {
      source: change.source ?? current?.source ?? source, kind: change.kind ?? current?.kind ?? cell.kind,
      baseVersion: current?.baseVersion ?? cell.version, status: current?.status === "saving" ? "saving" : "dirty",
    });
    scheduleSave(cellId);
  }, [scheduleSave]);

  const resolve = useCallback((cellId: string, choice: "theirs" | "mine" | "diff") => {
    const conflict = conflictsRef.current[cellId];
    if (!conflict) return;
    if (choice === "diff") { setConflict(cellId, { ...conflict, showDiff: !conflict.showDiff }); return; }
    if (choice === "theirs") { setDraft(cellId, null); setConflict(cellId, null); return; }
    const draft = draftsRef.current[cellId];
    setConflict(cellId, null);
    if (draft) { setDraft(cellId, { ...draft, baseVersion: conflict.theirsVersion, status: "dirty" }); void saveCell(cellId); }
  }, [saveCell]);

  // ---------- Structure ----------
  const insert = useCallback(async (index: number, kind: "code" | "markdown" = "code", source = "", startEditing = true): Promise<string | null> => {
    const notebook = docRef.current;
    if (!notebook) return null;
    const cellId = crypto.randomUUID();
    const attempt = (target: NotebookView) => api.save({ notebookId: target.id, cellId, kind, source, expectedVersion: 0,
      index: Math.min(index, target.cells.length), structureVersion: target.structureVersion });
    try {
      let result;
      try { result = await attempt(notebook); }
      catch (error) {
        if (!(error instanceof ApiError && error.code === "structure_version_conflict")) throw error;
        const latest = await refresh(true);
        if (!latest) throw error;
        result = await attempt(latest);
      }
      adopt(result.notebook); setSelected(cellId); setEditing(startEditing);
      return cellId;
    } catch (error) { fail(error); return null; }
  }, [api, adopt, refresh, fail]);

  const move = useCallback(async (cellId: string, delta: -1 | 1) => {
    const notebook = docRef.current;
    if (!notebook) return;
    const index = notebook.cells.findIndex((cell) => cell.id === cellId);
    const toIndex = index + delta;
    if (index < 0 || toIndex < 0 || toIndex >= notebook.cells.length) return;
    try { adopt((await api.move({ notebookId: notebook.id, cellId, toIndex, structureVersion: notebook.structureVersion })).notebook); }
    catch (error) { fail(error); if (error instanceof ApiError && error.code === "structure_version_conflict") await refresh(true); }
  }, [api, adopt, refresh, fail]);

  const remove = useCallback(async (cellId: string) => {
    const notebook = docRef.current;
    if (!notebook) return;
    const index = notebook.cells.findIndex((cell) => cell.id === cellId);
    const cell = notebook.cells[index];
    if (!cell) return;
    clearTimeout(timers.current.get(cellId));
    const keep = { source: draftsRef.current[cellId]?.source ?? fullSource(cell) ?? "", kind: draftsRef.current[cellId]?.kind ?? cell.kind };
    try {
      const result = await api.remove({ notebookId: notebook.id, cellId, structureVersion: notebook.structureVersion });
      setDraft(cellId, null); setConflict(cellId, null);
      adopt(result.notebook);
      setSelected(result.notebook.cells[Math.min(index, result.notebook.cells.length - 1)]?.id ?? null);
      setEditing(false);
      setToast({ text: `已刪除第 ${index + 1} 格`, action: { label: "復原", run: () => { void insert(index, keep.kind, keep.source, false); } } });
    } catch (error) { fail(error); if (error instanceof ApiError && error.code === "structure_version_conflict") await refresh(true); }
  }, [api, adopt, refresh, insert, fail]);

  // ---------- Running ----------
  const runCell = useCallback(async (cellId: string, advance: boolean): Promise<boolean> => {
    const notebook = docRef.current;
    if (!notebook) return false;
    const index = notebook.cells.findIndex((cell) => cell.id === cellId);
    const cell = notebook.cells[index];
    if (!cell) return false;
    const kind = draftsRef.current[cellId]?.kind ?? cell.kind;
    const goNext = async () => {
      if (!advance) return;
      const latest = docRef.current!;
      const next = latest.cells[index + 1];
      if (next) { setSelected(next.id); setEditing(false); }
      else await insert(latest.cells.length);
    };
    if (!await flush(cellId)) { notify("這一格還有未解決的衝突或儲存失敗，尚未執行", true); return false; }
    if (kind === "markdown") { setEditing(false); await goNext(); return true; }
    if (notebook.state !== "open") { notify("runtime 尚未開機，先開機才能執行", true); return false; }
    const saved = docRef.current!.cells.find((item) => item.id === cellId)!;
    try {
      const result = await api.run({ notebookId: notebook.id, cellId, cellVersion: saved.version, idempotencyKey: crypto.randomUUID() });
      if (result.notebook) adopt(result.notebook as NotebookView);
      if (result.warning) notify(describe(new ApiError(String(result.warning))), true);
      void refresh();
      await goNext();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  }, [api, adopt, refresh, insert, flush, notify, fail]);

  const runMany = useCallback(async (mode: "all" | "from" | "to") => {
    const notebook = docRef.current;
    if (!notebook || runAllCancel.current) return;
    const start = selected ? notebook.cells.findIndex((cell) => cell.id === selected) : 0;
    const scope = mode === "all" ? notebook.cells : mode === "from" ? notebook.cells.slice(Math.max(0, start)) : notebook.cells.slice(0, start + 1);
    const ids = scope.filter((cell) => (draftsRef.current[cell.id]?.kind ?? cell.kind) === "code").map((cell) => cell.id);
    const token = { cancelled: false };
    runAllCancel.current = token;
    setRunAll({ total: ids.length, done: 0 });
    try {
      for (const [position, cellId] of ids.entries()) {
        if (token.cancelled) break;
        setSelected(cellId);
        if (!await runCell(cellId, false)) break;
        let run: RunView | null = null;
        while (!token.cancelled) {
          await sleep(POLL_MS);
          const latest = await refresh(true);
          const cell = latest?.cells.find((item) => item.id === cellId);
          run = cell && !cell.outline ? (cell as FullCellView).lastRun : null;
          if (latest && !latest.activeRunId && run && TERMINAL.has(run.state)) break;
        }
        setRunAll({ total: ids.length, done: position + 1 });
        if (run && run.state !== "ok") {
          const index = docRef.current!.cells.findIndex((cell) => cell.id === cellId);
          notify(`全部執行停在第 ${index + 1} 格（${run.state === "interrupted" ? "已中斷" : "發生錯誤"}）`, true);
          break;
        }
      }
    } finally { runAllCancel.current = null; setRunAll(null); }
  }, [selected, runCell, refresh, notify]);

  const interrupt = useCallback(async () => {
    const notebook = docRef.current;
    if (!notebook) return;
    if (runAllCancel.current) runAllCancel.current.cancelled = true;
    try { await api.interrupt(notebook.id); void refresh(); } catch (error) { fail(error); }
  }, [api, refresh, fail]);

  // ---------- Notebook lifecycle ----------
  const openNotebook = useCallback(async (id: string) => {
    try {
      setDrafts({}); draftsRef.current = {}; setConflicts({}); conflictsRef.current = {}; setLoadedRuns({});
      docRef.current = null;
      const result = await api.document(id);
      docRef.current = result.notebook; setDoc(result.notebook);
      setSelected(result.notebook.cells[0]?.id ?? null); setEditing(false);
      if (result.warning) notify(describe(new ApiError(result.warning)), true);
    } catch (error) { fail(error); }
  }, [api, notify, fail]);

  const create = useCallback(async (title: string, machine: string) => {
    setCreating(true);
    try {
      const notebookId = crypto.randomUUID();
      const result = await api.open({ notebookId, title, idempotencyKey: crypto.randomUUID(), compute: machine });
      docRef.current = result.notebook; setDoc(result.notebook); setSelected(null);
      const cellId = await insert(0);
      if (!cellId) void refresh();
    } catch (error) { fail(error); }
    finally { setCreating(false); }
  }, [api, insert, refresh, fail]);

  const startRuntime = useCallback(async () => {
    const notebook = docRef.current;
    if (!notebook) return;
    try {
      const result = await api.open({ notebookId: notebook.id, title: notebook.title, idempotencyKey: crypto.randomUUID(), compute: openCompute });
      adopt(result.notebook);
      setCompute(await api.compute().catch(() => null));
    } catch (error) { fail(error); }
  }, [api, adopt, openCompute, fail]);

  const closeRuntime = useCallback(async (discardOutputs = false) => {
    const notebook = docRef.current;
    if (!notebook) return;
    try {
      await api.close(notebook.id, discardOutputs);
      notify("runtime 已釋放");
      await refresh();
      setCompute(await api.compute().catch(() => null));
    } catch (error) {
      if (error instanceof ApiError && error.result?.outputsPersisted === false) setDialog({ kind: "discard", notebookId: notebook.id });
      else fail(error);
    }
  }, [api, refresh, notify, fail]);

  const exportIpynb = useCallback(() => {
    const notebook = docRef.current;
    if (!notebook) return;
    try {
      // Keep this synchronous with the click so the browser preserves user activation.
      props.openLink(`${props.siteOrigin}/api/notebooks/${encodeURIComponent(notebook.id)}/export`);
      notify("已開啟 notebook 下載（只含已儲存的版本）");
    } catch (error) { fail(error); }
  }, [props.openLink, props.siteOrigin, notify, fail]);

  const askDelete = useCallback(async (id: string) => {
    try { setDialog({ kind: "delete", preview: await api.deletePreview(id) }); } catch (error) { fail(error); }
  }, [api, fail]);

  const confirmDelete = useCallback(async (preview: DeletePreview) => {
    try {
      await api.deleteNotebook(preview.notebookId, preview.artifactCount);
      setDialog(null);
      if (docRef.current?.id === preview.notebookId) { docRef.current = null; setDoc(null); }
      notify(`已刪除「${preview.title}」`);
      await loadHome();
    } catch (error) { setDialog(null); fail(error); }
  }, [api, loadHome, notify, fail]);

  const rename = useCallback(async (id: string, title: string) => {
    const value = title.trim();
    if (!value) return;
    try {
      const result = await api.rename(id, value);
      if (docRef.current?.id === id) adopt({ ...docRef.current, title: result.notebook.title, version: result.notebook.version });
      setNotebooks((rows) => rows?.map((row) => row.id === id ? { ...row, title: value } : row) ?? null);
    } catch (error) { fail(error); }
  }, [api, adopt, fail]);

  const loadOutput = useCallback(async (runId: string) => {
    const notebook = docRef.current;
    if (!notebook) return;
    try {
      const result = await api.document(notebook.id, runId);
      if (result.run) setLoadedRuns((runs) => ({ ...runs, [runId]: result.run! }));
    } catch (error) { fail(error); }
  }, [api, fail]);

  const goHome = useCallback(async () => {
    for (const cellId of Object.keys(draftsRef.current)) await flush(cellId);
    docRef.current = null; setDoc(null); setEditing(false);
    await loadHome();
  }, [flush, loadHome]);

  // ---------- Keyboard (command mode) ----------
  useEffect(() => {
    if (!doc || dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (editing && event.key === "Escape" && !isTyping(event.target)) {
        event.preventDefault(); setEditing(false); cellsRef.current?.focus(); return;
      }
      if (editing || isTyping(event.target)) return;
      const cells = docRef.current?.cells ?? [];
      const index = cells.findIndex((cell) => cell.id === selected);
      const cell = cells[index];
      const go = (offset: number) => { const next = cells[index + offset]; if (next) { setSelected(next.id); event.preventDefault(); } };
      if (event.altKey && event.key === "ArrowUp" && cell) { event.preventDefault(); void move(cell.id, -1); return; }
      if (event.altKey && event.key === "ArrowDown" && cell) { event.preventDefault(); void move(cell.id, 1); return; }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && cell) { event.preventDefault(); void runCell(cell.id, false); return; }
      if (event.key === "Enter" && event.shiftKey && cell) { event.preventDefault(); void runCell(cell.id, true); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "ArrowUp": case "k": go(-1); break;
        case "ArrowDown": case "j": go(1); break;
        case "Enter": if (cell && !cell.outline) { event.preventDefault(); setEditing(true); } break;
        case "a": event.preventDefault(); void insert(Math.max(0, index)); break;
        case "b": event.preventDefault(); void insert(index + 1); break;
        case "m": if (cell) edit(cell.id, { kind: "markdown" }); break;
        case "y": if (cell) edit(cell.id, { kind: "code" }); break;
        case "d":
          if (cell && Date.now() - lastD.current < 600) { lastD.current = 0; void remove(cell.id); }
          else lastD.current = Date.now();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [doc, dialog, editing, selected, move, runCell, insert, edit, remove]);

  // ---------- Render ----------
  const anySaving = Object.values(drafts).some((draft) => draft.status === "saving");
  const dialogs = dialog && <>
    {dialog.kind === "delete" && <Dialog title={`刪除「${dialog.preview.title}」？`} onClose={() => setDialog(null)} actions={<>
      <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>取消</button>
      <button type="button" className="btn btn-danger" disabled={dialog.preview.state !== "closed" && dialog.preview.state !== "deleting"}
        onClick={() => void confirmDelete(dialog.preview)}>永久刪除</button>
    </>}>
      <p>會一起刪除 {dialog.preview.cellCount ?? 0} 格、{dialog.preview.runCount ?? 0} 筆執行紀錄，以及 {dialog.preview.artifactCount} 個成品（{formatBytes(dialog.preview.totalBytes)}）
        {dialog.preview.permanentCount ? `，其中 ${dialog.preview.permanentCount} 個是永久保留` : ""}。這個動作無法復原。</p>
      {dialog.preview.state !== "closed" && dialog.preview.state !== "deleting" && <p className="save-error">runtime 還開著，請先關閉 runtime 再刪除。</p>}
    </Dialog>}
    {dialog.kind === "rename" && <Dialog title="改名" onClose={() => setDialog(null)} actions={<>
      <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>取消</button>
      <button type="button" className="btn btn-primary" onClick={() => { void rename(dialog.id, dialog.title); setDialog(null); }}>儲存</button>
    </>}>
      <input className="input" value={dialog.title} maxLength={120} aria-label="新名稱"
        onChange={(event) => setDialog({ ...dialog, title: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Enter") { void rename(dialog.id, dialog.title); setDialog(null); } }} />
    </Dialog>}
    {dialog.kind === "discard" && <Dialog title="成品還沒保存完" onClose={() => setDialog(null)} actions={<>
      <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>保留 runtime</button>
      <button type="button" className="btn btn-danger" onClick={() => { setDialog(null); void closeRuntime(true); }}>放棄未保存內容並關閉</button>
    </>}>
      <p>正常關閉會保留 runtime，讓結果與成品先保存完。只有在接受遺失未保存內容時才強制關閉。</p>
    </Dialog>}
  </>;

  if (!doc) {
    return <div className="app">
      <Home notebooks={notebooks} compute={compute} creating={creating} now={now}
        onOpen={(id) => void openNotebook(id)} onCreate={(title, machine) => void create(title, machine)}
        onRename={(row) => setDialog({ kind: "rename", id: row.id, title: row.title })} onDelete={(row) => void askDelete(row.id)} />
      <StatusBar notebook={null} compute={compute} now={now} saving={false} />
      <Toast toast={toast} onDone={() => setToast(null)} />
      {dialogs}
    </div>;
  }

  const status = runtimeStatus(doc);
  const open = doc.state === "open";
  const gpus = compute?.eligibleGpus ?? [];
  return (
    <div className="app">
      <header className="top">
        <div className="top-inner">
          <div className="top-title">
            <div className="crumb"><button type="button" onClick={() => void goHome()}>所有 notebook</button><span>／ 由你與 ChatGPT 共同編輯</span></div>
            {titleDraft === null
              ? <h1 className="title" title="按一下改名" onClick={() => setTitleDraft(doc.title)}>{doc.title}</h1>
              : <input className="title-input" autoFocus value={titleDraft} maxLength={120} aria-label="notebook 名稱"
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => { if (titleDraft.trim() && titleDraft !== doc.title) void rename(doc.id, titleDraft); setTitleDraft(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") setTitleDraft(null); }} />}
          </div>
          <div className="top-actions">
            <span className={`status status-${status.tone}`}>{status.label}</span>
            {runAll
              ? <button type="button" className="btn btn-secondary" onClick={() => { if (runAllCancel.current) runAllCancel.current.cancelled = true; }}>停止全部執行（{runAll.done}／{runAll.total}）</button>
              : <button type="button" className="btn btn-primary" disabled={!open || Boolean(doc.activeRunId)} onClick={() => void runMany("all")}>全部執行</button>}
            <button type="button" className="btn btn-secondary" disabled={!doc.activeRunId} onClick={() => void interrupt()}>中斷</button>
            <button type="button" className="icon-btn" aria-label="匯出 .ipynb" title="匯出 .ipynb" onClick={() => void exportIpynb()}><Icon.download /></button>
            <button type="button" className="icon-btn" aria-label={drawerOpen ? "收起側欄" : "打開側欄"} title="成品與設定" aria-pressed={drawerOpen}
              onClick={() => setDrawerOpen((value) => !value)}><Icon.panel /></button>
            <Menu label="更多操作" items={[
              { label: "從選取的格子往下執行", disabled: !open || Boolean(runAll), onSelect: () => void runMany("from") },
              { label: "執行到選取的格子", disabled: !open || Boolean(runAll), onSelect: () => void runMany("to") },
              { label: "重新整理", onSelect: () => void refresh() },
              open ? { label: "關閉 runtime", onSelect: () => void closeRuntime() }
                : { label: "開機", disabled: doc.state !== "closed", onSelect: () => void startRuntime() },
              { label: "刪除 notebook", danger: true, onSelect: () => void askDelete(doc.id) },
            ]} />
          </div>
        </div>
        <div className="hintbar" aria-label="快捷鍵">
          <span><kbd>Shift</kbd> + <kbd>Enter</kbd> 儲存、執行並跳到下一格</span>
          <span><kbd>Esc</kbd> 指令模式</span>
          <span><kbd>A</kbd>／<kbd>B</kbd> 在上方／下方新增</span>
          <span><kbd>M</kbd>／<kbd>Y</kbd> 轉成 Markdown／程式碼</span>
          <span><kbd>Alt</kbd> + <kbd>↑</kbd>／<kbd>↓</kbd> 移動</span>
          <span><kbd>D</kbd> <kbd>D</kbd> 刪除</span>
        </div>
      </header>

      <div className={`body${drawerOpen ? "" : " no-drawer"}`}>
        <main className="cells" ref={cellsRef} tabIndex={-1} aria-label="notebook cells">
          {doc.state === "closed" && <div className="banner">
            <span className="grow">runtime 已關閉。可以繼續編輯，開機後才能執行。</span>
            <select className="select" value={openCompute} onChange={(event) => setOpenCompute(event.target.value)} aria-label="開機機型">
              <option value="CPU">CPU</option>
              {gpus.length > 0 && <option value="AUTO">GPU（自動，L4 優先）</option>}
              {gpus.map((gpu) => <option key={gpu} value={gpu}>{gpu}</option>)}
            </select>
            <button type="button" className="btn btn-primary" onClick={() => void startRuntime()}>開機</button>
          </div>}
          {doc.state === "unknown" && <div className="banner"><span className="status status-alert">警示</span>
            <span className="grow">runtime 狀態不明，可能仍在計費。請重新整理，或從選單關閉 runtime。</span></div>}
          {doc.cells.length === 0 && <p className="note" style={{ marginLeft: "var(--gutter)" }}>這本 notebook 還沒有內容。</p>}
          {doc.cells.map((cell, index) => (
            <Cell key={cell.id} cell={cell} index={index} total={doc.cells.length} now={now}
              selected={selected === cell.id} editing={editing && selected === cell.id}
              activeRun={!cell.outline && Boolean(doc.activeRunId) && (cell as FullCellView).lastRun?.id === doc.activeRunId}
              draft={drafts[cell.id]} conflict={conflicts[cell.id]} loadedRun={(cell as FullCellView).lastRun ? loadedRuns[(cell as FullCellView).lastRun!.id] : undefined}
              onSelect={(startEditing) => { setSelected(cell.id); setEditing(startEditing); }}
              onChange={(source) => edit(cell.id, { source })}
              onRun={(advance) => void runCell(cell.id, advance)}
              onEscape={() => { setEditing(false); void flush(cell.id); cellsRef.current?.focus(); }}
              onSaveNow={() => void flush(cell.id)}
              onBlur={() => { if (draftsRef.current[cell.id]) void flush(cell.id); }}
              onLeave={() => { setEditing(false); void flush(cell.id); }}
              onMove={(delta) => void move(cell.id, delta)} onDelete={() => void remove(cell.id)}
              onToggleKind={() => edit(cell.id, { kind: (drafts[cell.id]?.kind ?? cell.kind) === "code" ? "markdown" : "code" })}
              onInterrupt={() => void interrupt()} onResolve={(choice) => resolve(cell.id, choice)} onLoadOutput={(runId) => void loadOutput(runId)} />
          ))}
          <div className="adder">
            <button type="button" className="btn btn-secondary" onClick={() => void insert(doc.cells.length)}>新增程式碼</button>
            <button type="button" className="btn btn-secondary" onClick={() => void insert(doc.cells.length, "markdown")}>新增 Markdown</button>
          </div>
        </main>
        <Drawer api={api} notebook={doc} open={drawerOpen} siteOrigin={props.siteOrigin} onClose={() => setDrawerOpen(false)}
          onRefresh={() => void refresh()} openLink={props.openLink} notify={notify} />
      </div>
      <StatusBar notebook={doc} compute={compute} now={now} saving={anySaving} />
      <Toast toast={toast} onDone={() => setToast(null)} />
      {dialogs}
    </div>
  );
}

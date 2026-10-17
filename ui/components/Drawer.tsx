/** Right drawer: artifacts, inputs, packages and settings for the open notebook. */
import { useEffect, useState } from "react";
import { useI18n } from "../app/Locale.tsx";
import type { ArtifactView, NotebookView } from "../../lib/notebook/contract.ts";
import { describe } from "../app/api.ts";
import type { NotebookApi, Settings } from "../app/api.ts";
import { formatAgo, formatBytes } from "../app/text.ts";

type Tab = "artifacts" | "inputs" | "packages" | "settings";
type HostFiles = {
  uploadFile?(file: File): Promise<{ fileId: string }>;
  getFileDownloadUrl?(args: { fileId: string }): Promise<{ downloadUrl: string }>;
};

export function Drawer(props: {
  api: NotebookApi; notebook: NotebookView; open: boolean; siteOrigin: string;
  onClose(): void; onRefresh(): void; openLink(url: string): void; notify(text: string, error?: boolean): void;
}) {
  const { t, locale } = useI18n();
  const { api, notebook } = props;
  const [tab, setTab] = useState<Tab>("artifacts");
  const [artifacts, setArtifacts] = useState<ArtifactView[] | null>(null);
  const [preview, setPreview] = useState<Record<string, string | null>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [packages, setPackages] = useState("");
  const host = (window as unknown as { openai?: HostFiles }).openai;

  const { notify } = props;
  const lastTerminalAt = notebook.lastTerminalAt;
  // Reload when the tab opens, the notebook changes, or a run finishes (lastTerminalAt).
  useEffect(() => {
    if (tab !== "artifacts") return;
    let alive = true;
    api.artifacts(notebook.id).then((value) => { if (alive) setArtifacts(value.artifacts); },
      (error) => notify(describe(error, locale), true));
    return () => { alive = false; };
  }, [tab, api, notebook.id, lastTerminalAt, notify, locale]);
  useEffect(() => {
    if (tab !== "packages" || settings) return;
    let alive = true;
    api.settings().then((value) => { if (alive) { setSettings(value); setPackages(value.packages.join("\n")); } },
      (error) => notify(describe(error, locale), true));
    return () => { alive = false; };
  }, [tab, settings, api, notify, locale]);

  const download = async (row: ArtifactView) => {
    try {
      const linked = await api.artifactLink(notebook.id, row.id);
      if (linked.previewDataUrl) setPreview((value) => ({ ...value, [row.id]: linked.previewDataUrl ?? null }));
      if (linked.downloadUrl) props.openLink(linked.downloadUrl);
    } catch (error) { props.notify(describe(error, locale), true); }
  };
  const pin = async (row: ArtifactView) => {
    try {
      const updated = await api.pin(row.id, !row.permanent);
      setArtifacts((rows) => rows?.map((item) => item.id === row.id ? { ...item, ...updated } : item) ?? null);
    } catch (error) { props.notify(describe(error, locale), true); }
  };
  const upload = async (file: File) => {
    if (!host?.uploadFile || !host.getFileDownloadUrl) return;
    try {
      const { fileId } = await host.uploadFile(file);
      const { downloadUrl } = await host.getFileDownloadUrl({ fileId });
      await api.importFile(notebook.id, { download_url: downloadUrl, file_id: fileId, file_name: file.name, mime_type: file.type || undefined });
      props.notify(t("Import submitted: {name}", { name: file.name })); props.onRefresh();
    } catch (error) { props.notify(describe(error, locale), true); }
  };
  const saveSettings = async () => {
    if (!settings) return;
    try {
      const next = await api.saveSettings(settings.version, packages.split(/[\s,]+/).filter(Boolean));
      setSettings(next); props.notify(t("Package list saved; applies on next startup or environment preparation"));
    } catch (error) { props.notify(describe(error, locale), true); }
  };
  const prepare = async (target: "packages" | "blender") => {
    try { await api.prepare(notebook.id, target); props.notify(target === "blender" ? t("Preparing Blender started") : t("Installing missing packages started")); props.onRefresh(); }
    catch (error) { props.notify(describe(error, locale), true); }
  };
  const runtimeIdle = notebook.state === "open" && !notebook.activeRunId && !notebook.activeInputId && !notebook.activeSetupId;

  return (
    <aside className={`drawer${props.open ? "" : " closed"}`} aria-label={t("Artifacts and settings")}>
      <div className="tabs" role="tablist">
        {([["artifacts", t("Artifacts"), artifacts?.length], ["inputs", t("Inputs"), notebook.inputs.length], ["packages", t("Packages"), undefined], ["settings", t("Settings"), undefined]] as const)
          .map(([key, label, count]) => (
            <button key={key} type="button" role="tab" className="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}{count ? <span className="count">{count}</span> : null}
            </button>))}
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label={t("Close sidebar")} onClick={props.onClose}>×</button>
      </div>

      {tab === "artifacts" && <>
        <p className="drawer-note">{t("Files in outputs/ are saved after each cell and kept for 30 days unless marked permanent.")}</p>
        {artifacts === null && <p className="drawer-note">{t("Loading")}</p>}
        {artifacts?.length === 0 && <p className="drawer-note">{t("No artifacts yet.")}</p>}
        {artifacts?.map((row) => (
          <div className="row" key={row.id}>
            <div className="row-name">{row.path}</div>
            <div className="row-meta">{formatBytes(row.size)} · {row.permanent ? t("Keep permanently") : row.expiresAt ? t("Kept until {date}", { date: new Date(row.expiresAt).toLocaleDateString(locale, { month: "long", day: "numeric" }) }) : row.state}</div>
            <div className="row-meta num">sha256 {row.sha256.slice(0, 4)}…{row.sha256.slice(-4)}</div>
            {preview[row.id] && <img className="preview-img" src={preview[row.id]!} alt={t("Preview of {path}", { path: row.path })} />}
            <div className="row-actions">
              <button type="button" className="btn btn-secondary" disabled={row.state !== "ready"} onClick={() => void download(row)}>{t("Download")}</button>
              <button type="button" className="btn btn-quiet" disabled={row.state !== "ready"} onClick={() => void pin(row)}>{row.permanent ? t("Remove permanent retention") : t("Keep permanently")}</button>
            </div>
          </div>))}
      </>}

      {tab === "inputs" && <>
        <p className="drawer-note">{t("Attachments download into the runtime's inputs/ directory, up to 128 MiB each. They are not retained after closing the runtime.")}</p>
        {host?.uploadFile && host.getFileDownloadUrl
          ? <label className="field">{t("Choose a file to import")}
              <input type="file" disabled={!runtimeIdle} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
            </label>
          : <p className="drawer-note">{t("Upload attachments in the ChatGPT notebook panel, or attach a file in the conversation and ask ChatGPT to import it.")}</p>}
        {notebook.inputs.map((row) => (
          <div className="row" key={row.id}>
            <div className="row-name">{row.path}</div>
            <div className="row-meta">{row.state}{row.bytes !== null ? ` · ${formatBytes(row.bytes)}` : ""}{row.currentRuntime ? "" : ` · ${t("Not in the current runtime")}`}</div>
            {row.error && <div className="row-meta save-error">{row.error.code}</div>}
          </div>))}
      </>}

      {tab === "packages" && <>
        <p className="drawer-note">{t("Only missing packages are installed on startup. One PyPI name per line, up to 16.")}</p>
        <label className="field">{t("Preinstalled packages")}
          <textarea className="textarea" rows={7} value={packages} onChange={(event) => setPackages(event.target.value)} disabled={!settings} />
        </label>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" disabled={!settings} onClick={() => void saveSettings()}>{t("Save list")}</button>
          <button type="button" className="btn btn-quiet" disabled={!runtimeIdle} onClick={() => void prepare("packages")}>{t("Install missing packages")}</button>
          <button type="button" className="btn btn-quiet" disabled={!runtimeIdle} onClick={() => void prepare("blender")}>{t("Prepare Blender")}</button>
        </div>
        {notebook.setupTasks.map((task) => (
          <div className="row" key={task.id}>
            <div className="row-name">{task.kind === "blender" ? "Blender" : t("Packages")} · {task.state}</div>
            <div className="row-meta">{formatAgo(task.createdAt, Date.now(), locale)}{task.error ? ` · ${task.error.code}` : ""}</div>
          </div>))}
      </>}

      {tab === "settings" && <>
        <p className="drawer-note">{t("Google authorization includes only openid, userinfo.email and colaboratory.")}</p>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" onClick={() => props.openLink(`${props.siteOrigin}/oauth/google/start`)}>{t("Reauthorize Google Colab")}</button>
        </div>
        <p className="drawer-note" style={{ marginTop: 16 }}>{t("Working directory")} {notebook.workingDirectory}<br />{t("Output directory")} {notebook.outputsDirectory}</p>
      </>}
    </aside>
  );
}

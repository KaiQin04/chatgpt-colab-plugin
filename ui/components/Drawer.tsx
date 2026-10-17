/** Right drawer: artifacts, inputs, packages and settings for the open notebook. */
import { useEffect, useState } from "react";
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
      (error) => notify(describe(error), true));
    return () => { alive = false; };
  }, [tab, api, notebook.id, lastTerminalAt, notify]);
  useEffect(() => {
    if (tab !== "packages" || settings) return;
    let alive = true;
    api.settings().then((value) => { if (alive) { setSettings(value); setPackages(value.packages.join("\n")); } },
      (error) => notify(describe(error), true));
    return () => { alive = false; };
  }, [tab, settings, api, notify]);

  const download = async (row: ArtifactView) => {
    try {
      const linked = await api.artifactLink(notebook.id, row.id);
      if (linked.previewDataUrl) setPreview((value) => ({ ...value, [row.id]: linked.previewDataUrl ?? null }));
      if (linked.downloadUrl) props.openLink(linked.downloadUrl);
    } catch (error) { props.notify(describe(error), true); }
  };
  const pin = async (row: ArtifactView) => {
    try {
      const updated = await api.pin(row.id, !row.permanent);
      setArtifacts((rows) => rows?.map((item) => item.id === row.id ? { ...item, ...updated } : item) ?? null);
    } catch (error) { props.notify(describe(error), true); }
  };
  const upload = async (file: File) => {
    if (!host?.uploadFile || !host.getFileDownloadUrl) return;
    try {
      const { fileId } = await host.uploadFile(file);
      const { downloadUrl } = await host.getFileDownloadUrl({ fileId });
      await api.importFile(notebook.id, { download_url: downloadUrl, file_id: fileId, file_name: file.name, mime_type: file.type || undefined });
      props.notify(`已送出匯入：${file.name}`); props.onRefresh();
    } catch (error) { props.notify(describe(error), true); }
  };
  const saveSettings = async () => {
    if (!settings) return;
    try {
      const next = await api.saveSettings(settings.version, packages.split(/[\s,]+/).filter(Boolean));
      setSettings(next); props.notify("套件清單已儲存，下次開機或重新準備時套用");
    } catch (error) { props.notify(describe(error), true); }
  };
  const prepare = async (target: "packages" | "blender") => {
    try { await api.prepare(notebook.id, target); props.notify(target === "blender" ? "已開始準備 Blender" : "已開始補裝套件"); props.onRefresh(); }
    catch (error) { props.notify(describe(error), true); }
  };
  const runtimeIdle = notebook.state === "open" && !notebook.activeRunId && !notebook.activeInputId && !notebook.activeSetupId;

  return (
    <aside className={`drawer${props.open ? "" : " closed"}`} aria-label="成品與設定">
      <div className="tabs" role="tablist">
        {([["artifacts", "成品", artifacts?.length], ["inputs", "輸入檔", notebook.inputs.length], ["packages", "套件", undefined], ["settings", "設定", undefined]] as const)
          .map(([key, label, count]) => (
            <button key={key} type="button" role="tab" className="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
              {label}{count ? <span className="count">{count}</span> : null}
            </button>))}
        <span style={{ flex: 1 }} />
        <button type="button" className="icon-btn" aria-label="關閉側欄" onClick={props.onClose}>×</button>
      </div>

      {tab === "artifacts" && <>
        <p className="drawer-note">寫進 outputs/ 的檔案會在每格執行完自動保存，保留 30 天，可設為永久保留。</p>
        {artifacts === null && <p className="drawer-note">載入中</p>}
        {artifacts?.length === 0 && <p className="drawer-note">還沒有成品。</p>}
        {artifacts?.map((row) => (
          <div className="row" key={row.id}>
            <div className="row-name">{row.path}</div>
            <div className="row-meta">{formatBytes(row.size)} · {row.permanent ? "永久保留" : row.expiresAt ? `保留至 ${new Date(row.expiresAt).toLocaleDateString("zh-TW", { month: "long", day: "numeric" })}` : row.state}</div>
            <div className="row-meta num">sha256 {row.sha256.slice(0, 4)}…{row.sha256.slice(-4)}</div>
            {preview[row.id] && <img className="preview-img" src={preview[row.id]!} alt={`${row.path} 預覽`} />}
            <div className="row-actions">
              <button type="button" className="btn btn-secondary" disabled={row.state !== "ready"} onClick={() => void download(row)}>下載</button>
              <button type="button" className="btn btn-quiet" disabled={row.state !== "ready"} onClick={() => void pin(row)}>{row.permanent ? "取消永久保留" : "永久保留"}</button>
            </div>
          </div>))}
      </>}

      {tab === "inputs" && <>
        <p className="drawer-note">附件會直接下載到 runtime 的 inputs/，每檔最多 128 MiB；關閉 runtime 後不保留。</p>
        {host?.uploadFile && host.getFileDownloadUrl
          ? <label className="field">選擇檔案並匯入
              <input type="file" disabled={!runtimeIdle} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
            </label>
          : <p className="drawer-note">在 ChatGPT 的 notebook 面板中可以上傳附件；也可以在對話中附檔請 ChatGPT 匯入。</p>}
        {notebook.inputs.map((row) => (
          <div className="row" key={row.id}>
            <div className="row-name">{row.path}</div>
            <div className="row-meta">{row.state}{row.bytes !== null ? ` · ${formatBytes(row.bytes)}` : ""}{row.currentRuntime ? "" : " · 不在目前的 runtime"}</div>
            {row.error && <div className="row-meta save-error">{row.error.code}</div>}
          </div>))}
      </>}

      {tab === "packages" && <>
        <p className="drawer-note">開機時只補裝缺少的套件。每行一個 PyPI 名稱，最多 16 個。</p>
        <label className="field">預裝套件
          <textarea className="textarea" rows={7} value={packages} onChange={(event) => setPackages(event.target.value)} disabled={!settings} />
        </label>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" disabled={!settings} onClick={() => void saveSettings()}>儲存清單</button>
          <button type="button" className="btn btn-quiet" disabled={!runtimeIdle} onClick={() => void prepare("packages")}>補裝缺少套件</button>
          <button type="button" className="btn btn-quiet" disabled={!runtimeIdle} onClick={() => void prepare("blender")}>準備 Blender</button>
        </div>
        {notebook.setupTasks.map((task) => (
          <div className="row" key={task.id}>
            <div className="row-name">{task.kind === "blender" ? "Blender" : "套件"} · {task.state}</div>
            <div className="row-meta">{formatAgo(task.createdAt)}{task.error ? ` · ${task.error.code}` : ""}</div>
          </div>))}
      </>}

      {tab === "settings" && <>
        <p className="drawer-note">Google 授權只包含 openid、userinfo.email 與 colaboratory。</p>
        <div className="row-actions">
          <button type="button" className="btn btn-secondary" onClick={() => props.openLink(`${props.siteOrigin}/oauth/google/start`)}>重新授權 Google Colab</button>
        </div>
        <p className="drawer-note" style={{ marginTop: 16 }}>工作目錄 {notebook.workingDirectory}<br />成品目錄 {notebook.outputsDirectory}</p>
      </>}
    </aside>
  );
}

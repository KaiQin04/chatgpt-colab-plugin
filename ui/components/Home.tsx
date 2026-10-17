/** Landing view: compute summary, new notebook, and the saved notebook list. */
import { useState } from "react";
import type { ComputeStatus, NotebookSummary } from "../app/api.ts";
import { formatAgo, formatNumber } from "../app/text.ts";
import { Menu } from "./Chrome.tsx";

const STATE_LABEL: Record<string, string> = {
  open: "已開機", opening: "開機中", closed: "已關閉", closing: "關閉中", preparing: "準備中",
  importing: "匯入中", interrupting: "中斷中", unknown: "狀態不明", deleting: "刪除中",
};

export function Home(props: {
  notebooks: NotebookSummary[] | null; compute: ComputeStatus | null; creating: boolean; now: number;
  onOpen(id: string): void; onCreate(title: string, compute: string): void;
  onRename(row: NotebookSummary): void; onDelete(row: NotebookSummary): void;
}) {
  const [title, setTitle] = useState("");
  const [machine, setMachine] = useState("CPU");
  const gpus = props.compute?.eligibleGpus ?? [];
  return (
    <main className="home">
      <div>
        <h1>Colab Notebook</h1>
        <p className="note">在 ChatGPT 旁邊使用你 Colab Pro 的 CPU 與 GPU。runtime 一開機就計費，閒置時 CPU 5 小時、GPU 2 小時後自動釋放。</p>
      </div>

      <section className="panel" aria-label="運算額度">
        <div className="stats">
          <div className="stat"><div className="label">餘額</div><div className="value">{formatNumber(props.compute?.currentBalance)} <span className="note">units</span></div></div>
          <div className="stat"><div className="label">目前消耗</div><div className="value">{formatNumber(props.compute?.consumptionRateHourly)} <span className="note">units/hr</span></div></div>
          <div className="stat"><div className="label">開著的 runtime</div><div className="value">{props.compute?.ownerRuntimeCount ?? "未知"}</div></div>
        </div>
        {gpus.length > 0 && <p className="note" style={{ marginTop: 12 }}>可用 GPU：{gpus.join("、")}</p>}
      </section>

      <section className="panel" aria-label="新建 notebook">
        <h2>新建 notebook</h2>
        <form className="create" onSubmit={(event) => { event.preventDefault(); props.onCreate(title.trim() || "未命名 notebook", machine); }}>
          <input className="input" placeholder="名稱" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="notebook 名稱" />
          <select className="select" value={machine} onChange={(event) => setMachine(event.target.value)} aria-label="機型">
            <option value="CPU">CPU</option>
            {gpus.length > 0 && <option value="AUTO">GPU（自動，L4 優先）</option>}
            {gpus.map((gpu) => <option key={gpu} value={gpu}>{gpu}</option>)}
          </select>
          <button type="submit" className="btn btn-primary" disabled={props.creating}>{props.creating ? "開機中" : "建立並開機"}</button>
        </form>
      </section>

      <section aria-label="已儲存的 notebook">
        <h2>notebook</h2>
        {props.notebooks === null && <p className="note">載入中</p>}
        {props.notebooks?.length === 0 && <p className="note">還沒有 notebook。</p>}
        <ul className="list">
          {props.notebooks?.map((row) => (
            <li key={row.id}>
              <div className="name">
                <button type="button" onClick={() => props.onOpen(row.id)}>{row.title}</button>
                <div className="note">{STATE_LABEL[row.state] ?? row.state} · {formatAgo(row.updatedAt, props.now)}更新</div>
              </div>
              <Menu label={`${row.title} 的操作`} items={[
                { label: "開啟", onSelect: () => props.onOpen(row.id) },
                { label: "改名", onSelect: () => props.onRename(row) },
                { label: "刪除 notebook", danger: true, onSelect: () => props.onDelete(row) },
              ]} />
            </li>))}
        </ul>
      </section>
    </main>
  );
}

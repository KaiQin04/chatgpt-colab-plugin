/** Landing view: compute summary, new notebook, and the saved notebook list. */
import { useState } from "react";
import { LanguagePicker, useI18n } from "../app/Locale.tsx";
import type { Message } from "../app/i18n.ts";
import type { ComputeStatus, NotebookSummary } from "../app/api.ts";
import { formatAgo, formatNumber } from "../app/text.ts";
import { Menu } from "./Chrome.tsx";

const STATE_LABEL: Record<string, Message> = {
  open: "Running", opening: "Starting", closed: "Closed", closing: "Closing", preparing: "Preparing",
  importing: "Importing", interrupting: "Interrupting", unknown: "Unknown state", deleting: "Deleting",
};

export function Home(props: {
  notebooks: NotebookSummary[] | null; compute: ComputeStatus | null; creating: boolean; now: number;
  onOpen(id: string): void; onCreate(title: string, compute: string): void;
  onRename(row: NotebookSummary): void; onDelete(row: NotebookSummary): void;
}) {
  const { t, locale } = useI18n();
  const [title, setTitle] = useState("");
  const [machine, setMachine] = useState("CPU");
  const gpus = props.compute?.eligibleGpus ?? [];
  return (
    <main className="home">
      <div>
        <div className="home-heading"><h1>Colab Notebook</h1><LanguagePicker /></div>
        <p className="note">{t("Use your own Colab CPU and GPU from ChatGPT. Runtimes consume credits while running. Idle runtimes are released after 5 hours for CPU or 2 hours for GPU, plus the cleanup interval.")}</p>
      </div>

      <section className="panel" aria-label={t("Compute credits")}>
        <div className="stats">
          <div className="stat"><div className="label">{t("Balance")}</div><div className="value">{formatNumber(props.compute?.currentBalance, 2, locale)} <span className="note">units</span></div></div>
          <div className="stat"><div className="label">{t("Current usage")}</div><div className="value">{formatNumber(props.compute?.consumptionRateHourly, 2, locale)} <span className="note">units/hr</span></div></div>
          <div className="stat"><div className="label">{t("Open runtimes")}</div><div className="value">{props.compute?.ownerRuntimeCount ?? t("Unknown")}</div></div>
        </div>
        {gpus.length > 0 && <p className="note" style={{ marginTop: 12 }}>{t("Eligible GPUs: {gpus}", { gpus: gpus.join(", ") })}</p>}
      </section>

      <section className="panel" aria-label={t("New notebook")}>
        <h2>{t("New notebook")}</h2>
        <form className="create" onSubmit={(event) => { event.preventDefault(); props.onCreate(title.trim() || t("Untitled notebook"), machine); }}>
          <input className="input" placeholder={t("Name")} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} aria-label={t("Notebook name")} />
          <select className="select" value={machine} onChange={(event) => setMachine(event.target.value)} aria-label={t("Machine")}>
            <option value="CPU">CPU</option>
            {gpus.length > 0 && <option value="AUTO">{t("GPU (automatic, L4 preferred)")}</option>}
            {gpus.map((gpu) => <option key={gpu} value={gpu}>{gpu}</option>)}
          </select>
          <button type="submit" className="btn btn-primary" disabled={props.creating}>{props.creating ? t("Starting") : t("Create and start")}</button>
        </form>
      </section>

      <section aria-label={t("Saved notebooks")}>
        <h2>{t("Notebooks")}</h2>
        {props.notebooks === null && <p className="note">{t("Loading")}</p>}
        {props.notebooks?.length === 0 && <p className="note">{t("No notebooks yet.")}</p>}
        <ul className="list">
          {props.notebooks?.map((row) => (
            <li key={row.id}>
              <div className="name">
                <button type="button" onClick={() => props.onOpen(row.id)}>{row.title}</button>
                <div className="note">{STATE_LABEL[row.state] ? t(STATE_LABEL[row.state]) : row.state} · {t("Updated {time}", { time: formatAgo(row.updatedAt, props.now, locale) })}</div>
              </div>
              <Menu label={t("Actions for {title}", { title: row.title })} items={[
                { label: t("Open"), onSelect: () => props.onOpen(row.id) },
                { label: t("Rename"), onSelect: () => props.onRename(row) },
                { label: t("Delete notebook"), danger: true, onSelect: () => props.onDelete(row) },
              ]} />
            </li>))}
        </ul>
      </section>
    </main>
  );
}

/** One self-contained, bounded editor used by both the Site and MCP Apps. */
import { SITE_ORIGIN } from "../platform/config.ts";
import { MAX_OUTPUT_BYTES } from "./types.ts";

function editorBrowser(mode: "site" | "mcp", siteOrigin: string, maxOutputBytes: number): void {
  type Value = Record<string, any>;
  const el = (id: string): any => document.getElementById(id)!;
  const object = (v: unknown): v is Value => Boolean(v && typeof v === "object" && !Array.isArray(v));
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const requests = new Set<AbortController>();
  const drafts = new Map<string, { notebookId: string; source: string; kind: string; version: number }>();
  const retries = new Map<string, string>();
  let next = 0, busy = false, alive = true, ready = mode === "site";
  let current: Value | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let opening: { notebookId: string; idempotencyKey: string; title: string; compute: string } | null = null;
  let compute: Value | null = null;
  let discardAllowed = false, downloadUrl: string | null = null;
  let artifactRows: Value[] = [], artifactNotebookId: string | null = null, artifactNext: string | null = null;
  let inputAttempt: { notebookId: string; fileId: string; name: string; key: string; id?: string } | null = null;
  const setupAttempts = new Map<string, { notebookId: string; key: string; id?: string }>();
  let settingsVersion = 0, settingsDirty = false;
  const select = el("notebooks") as HTMLSelectElement;
  const labels: Record<string, string> = { open: "已開啟", opening: "開機中", closed: "已關閉", closing: "關閉中／待救援",
    unknown: "狀態不明，請查核", interrupting: "中斷處理中", dispatching: "送出中", submitted: "已確認提交", running: "執行中",
    ok: "完成", error: "程式錯誤", interrupted: "已中斷", incomplete: "結果不完整", importing: "附件匯入中", preparing: "環境準備中" };
  const state = (v: string) => labels[v] || v;
  function note(text: string, error = false): void { el("message").textContent = text; el("message").className = error ? "error" : ""; }
  function failure(v: Value): string | null {
    const e = v.error || v.pollError || v.ledgerError || v.cleanupError || v.confirmationError || v.artifactError;
    return object(e) ? `${String(e.code)} · ${String(e.stage)}` : v.released === false ? "release_unconfirmed" : null;
  }
  const requestTimeout = (name: string) => ["get_notebook", "get_artifacts", "close_notebook", "maintain_notebooks"].includes(name) ? 240_000 : 55_000;
  function bridge(method: string, params: Value): Promise<Value> {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("bridge_timeout_unknown")); }, requestTimeout(String(params.name)));
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
  async function call(name: string, args: Value): Promise<Value> {
    if (!alive) throw new Error("page_closed");
    if (mode === "mcp") {
      const response = await bridge("tools/call", { name: name === "upsert_cell" || name === "run_cell" ? `ui_${name}` : name, arguments: args });
      if (!object(response.structuredContent)) throw new Error("invalid_host_result");
      return response.structuredContent;
    }
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeout(name));
    try {
      const response = await fetch("/api/notebooks", { method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin", body: JSON.stringify({ name, arguments: args }), signal: controller.signal });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const result = await response.json(); if (!object(result)) throw new Error("invalid_site_result"); return result;
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function adopt(v: Value): void {
    if (object(v.settings) && Array.isArray(v.settings.packages) && !settingsDirty) {
      settingsVersion = v.settings.version;
      el("runtime-packages").value = v.settings.packages.join("\n");
      el("runtime-settings-version").textContent = `設定 v${settingsVersion} · 套用於下次開機或明確重新準備套件`;
    }
    if (Object.hasOwn(v, "ownerRuntimeCount")) compute = v;
    if (object(v.notebook) && Array.isArray(v.notebook.cells)) {
      if (current?.id !== v.notebook.id) {
        artifactRows = []; artifactNext = null; artifactNotebookId = null;
        el("artifact-preview").replaceChildren(); el("artifact-more").hidden = true;
      }
      current = v.notebook;
      if (inputAttempt?.id && current!.inputs?.some((row: Value) => row.id === inputAttempt!.id && ["ready", "error", "incomplete"].includes(row.state))) inputAttempt = null;
      for (const [target, attempt] of setupAttempts) if (attempt.id && current!.setupTasks?.some((row: Value) => row.id === attempt.id && ["ready", "error", "incomplete"].includes(row.state))) setupAttempts.delete(target);
    }
    if (Array.isArray(v.notebooks) && !Object.hasOwn(v, "ownerRuntimeCount")) {
      select.replaceChildren();
      const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "選取已儲存 notebook"; select.appendChild(placeholder);
      for (const row of v.notebooks.filter(object).slice(0, 30)) {
        const option = document.createElement("option"); option.value = row.id; option.textContent = `${row.title} · ${state(row.state)}`; select.appendChild(option);
      }
    }
    if (current) {
      if (![...select.options].some((option) => option.value === current!.id)) {
        const option = document.createElement("option"); option.value = current.id; option.textContent = `${current.title} · ${state(current.state)}`;
        select.appendChild(option);
      }
      select.value = current.id;
    }
    if (failure(v)) note(`操作未確認：${failure(v)}。請查看狀態或重試相同操作。`, true);
    if (v.outputsPersisted === false && v.released === false) discardAllowed = true;
    if (v.error?.code === "input_import_in_progress_or_unknown") discardAllowed = true;
    if (v.error?.code === "runtime_setup_in_progress_or_unknown") discardAllowed = true;
  }
  function buttons(): void {
    document.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = busy || !ready || b.dataset.unavailable === "true"; });
    select.disabled = busy || !ready;
    el("compute-choice").disabled = busy || !ready || Boolean(opening);
    el("new").textContent = opening ? "重試同次開機" : "新建並開啟";
  }
  function schedule(): void {
    if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null;
    const blocked = current?.cells.some((cell: Value) => cell.lastRun?.artifactsState === "blocked");
    if (alive && ready && !busy && (current?.activeRunId || current?.activeInputId || current?.activeSetupId) && !blocked && !document.hidden) pollTimer = setTimeout(() => { void act(refresh); }, 4000);
  }
  async function act(work: () => Promise<void>): Promise<void> {
    if (busy || !ready || !alive) return;
    busy = true; if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; buttons(); note("處理中…");
    try { await work(); if (alive && el("message").textContent === "處理中…") note("已完成"); }
    catch (e) {
      const code = e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : "request_failed_unknown";
      note(`請求未確認：${code}。重試會沿用同次操作編號，請勿另開 runtime。`, true);
    } finally { busy = false; if (alive) { render(); schedule(); } }
  }
  async function refresh(): Promise<void> {
    const v = await call("get_notebook", current ? { notebookId: current.id, view: "full" } : {}); adopt(v);
    if (!failure(v)) note(`已更新 ${new Date().toLocaleTimeString("zh-TW")}`);
  }
  const text = (parent: HTMLDivElement, value: string, tag = "pre") => { const node = document.createElement(tag) as unknown as HTMLSpanElement; node.textContent = value; parent.appendChild(node); return node; };
  // Equivalent to png.ts; this function is serialized without module imports.
  function base64PngWithinLimits(value: string): boolean {
    try {
      const bytes = Uint8Array.from(atob(value.replace(/[\r\n]/g, "").slice(0, 32)), (char) => char.charCodeAt(0));
      if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return false;
      const view = new DataView(bytes.buffer);
      if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return false;
      const width = view.getUint32(16), height = view.getUint32(20);
      return width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4_000_000;
    } catch { return false; }
  }
  function output(parent: HTMLDivElement, run: Value, version: number): void {
    text(parent, `${state(run.state)} · 來源版本 ${run.cellVersion}${run.cellVersion !== version ? "（程式碼已修改）" : ""} · ${run.actor === "user" ? "使用者" : "ChatGPT"} · run ${String(run.id).slice(0, 8)}`, "small");
    if (run.interruptRequested) text(parent, "已要求中斷，以後續 terminal 結果為準。", "small");
    if (run.artifactsState && run.artifactsState !== "legacy") text(parent, `成品保存：${run.artifactsState}${run.artifactsState === "pending" ? "（完成後才允許下一格）" : ""}`, "small");
    if (run.artifactError) text(parent, JSON.stringify(run.artifactError));
    if (failure(run)) text(parent, failure(run)!);
    if (!object(run.result) || !Array.isArray(run.result.outputs)) {
      if (run.outputsOmitted) text(parent, "此畫面輸出已達總量上限，可用 runId 單獨讀取。", "small"); return;
    }
    for (const item of run.result.outputs.slice(0, 64)) {
      if (!object(item)) continue;
      if (item.output_type === "stream") text(parent, String(item.text).slice(0, 24_000));
      else if (item.output_type === "error") text(parent, `${String(item.ename)}: ${String(item.evalue)}\n${Array.isArray(item.traceback) ? item.traceback.join("\n") : ""}`.slice(0, 24_000));
      else if (object(item.data)) {
        if (typeof item.data["text/plain"] === "string") text(parent, item.data["text/plain"].slice(0, 24_000));
        const png = item.data["image/png"];
        if (typeof png === "string" && png.length <= maxOutputBytes && /^iVBORw0KGgo[A-Za-z0-9+/=\r\n]*$/.test(png) && base64PngWithinLimits(png)) {
          const image = document.createElement("img"); image.alt = "Cell 圖片輸出"; image.src = `data:image/png;base64,${png}`; parent.appendChild(image);
        }
      }
    }
    if (run.result.truncated) text(parent, "輸出已達上限，後續內容未收錄。", "small");
  }
  function render(): void {
    const focused = document.activeElement as HTMLTextAreaElement | null;
    const focusId = focused?.dataset.cellId, cursor = focusId ? [focused!.selectionStart, focused!.selectionEnd] : null;
    const area = el("cells"); area.replaceChildren(); el("empty").hidden = Boolean(current); el("workspace").hidden = !current;
    renderCompute();
    if (!current) { buttons(); return; }
    const machine = current.runtime?.computeVerified ? current.runtime.accelerator : current.runtime?.selectedAccelerator ? `${current.runtime.selectedAccelerator}（待核對）` : "尚無已核對機型";
    el("title").textContent = current.title; el("state").textContent = `${state(current.state)} · ${machine} · 文件 v${current.version}${current.controlPending ? " · 控制請求未確認" : ""}${current.idle ? ` · 閒置 ${Math.round(current.idle.milliseconds / 60000)} 分鐘後釋放` : ""}`;
    const available = (id: string, yes: boolean) => { el(id).dataset.unavailable = String(!yes); };
    available("open", current.state === "closed"); available("interrupt", current.state === "open" && Boolean(current.activeRunId));
    available("close", !["closed", "opening"].includes(current.state)); available("discard", discardAllowed && (el("consent") as HTMLInputElement).checked);
    const shown: Value[] = current.cells.slice(0, 200);
    for (const [id, draft] of drafts) if (draft.notebookId === current.id && !shown.some((c) => c.id === id)) shown.push({ id, kind: draft.kind, source: "", version: 0 });
    shown.slice(0, 200).forEach((cell, index) => {
      const draft = drafts.get(cell.id), card = document.createElement("div"); card.className = "cell";
      text(card, `${index + 1} · ${cell.kind === "code" ? "程式碼" : "Markdown"} · v${cell.version}`, "strong");
      const input = document.createElement("textarea"); input.dataset.cellId = cell.id; input.value = draft?.source ?? cell.source;
      input.spellcheck = false; input.maxLength = 16_000; input.rows = Math.min(16, Math.max(4, input.value.split("\n").length + 1));
      input.readOnly = !draft && drafts.size >= 64;
      input.setAttribute("aria-label", `Cell ${index + 1} ${cell.kind}`);
      const actions = document.createElement("div"); actions.className = "toolbar";
      const save = document.createElement("button"); save.textContent = draft ? "儲存修改" : "已儲存";
      save.dataset.unavailable = String(!draft || ["opening", "closing"].includes(current!.state));
      save.onclick = () => { void act(async () => {
        const d = drafts.get(cell.id); if (!d) return;
        const v = await call("upsert_cell", { notebookId: current!.id, cellId: cell.id, kind: d.kind, source: d.source,
          expectedVersion: d.version, notebookVersion: current!.version });
        if (!v.error) {
          const latest = drafts.get(cell.id);
          if (latest === d) drafts.delete(cell.id);
          else if (latest && object(v.notebook) && Array.isArray(v.notebook.cells)) {
            const saved = v.notebook.cells.find((c: Value) => c.id === cell.id);
            if (saved) latest.version = saved.version;
          }
        }
        adopt(v); if (!v.error) note("已儲存，尚未執行。");
      }); };
      const reset = document.createElement("button"); reset.textContent = "放棄本機修改"; reset.className = "secondary";
      reset.dataset.unavailable = String(!draft); reset.onclick = () => { drafts.delete(cell.id); render(); };
      actions.appendChild(save); actions.appendChild(reset);
      let run: HTMLButtonElement | null = null;
      if (cell.kind === "code") {
        run = document.createElement("button"); run.textContent = retries.has(cell.id) ? "重試同次提交" : "執行已儲存版本";
        run.dataset.unavailable = String(Boolean(draft) || current!.state !== "open" || Boolean(current!.activeRunId) || cell.version === 0);
        run.onclick = () => { void act(async () => {
          const key = retries.get(cell.id) ?? crypto.randomUUID(); retries.set(cell.id, key);
          const v = await call("run_cell", { notebookId: current!.id, cellId: cell.id, cellVersion: cell.version, idempotencyKey: key });
          if (v.run || v.runId) retries.delete(cell.id); adopt(v); await refresh();
        }); }; actions.appendChild(run);
        input.onkeydown = (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); if (run && !run.disabled) run.click(); } };
      }
      input.oninput = () => {
        const before = drafts.get(cell.id); drafts.set(cell.id, { notebookId: current!.id, source: input.value, kind: cell.kind, version: before?.version ?? cell.version });
        save.textContent = "儲存修改"; save.dataset.unavailable = String(["opening", "closing"].includes(current!.state)); reset.dataset.unavailable = "false";
        if (run) run.dataset.unavailable = "true"; buttons();
      };
      card.appendChild(input); card.appendChild(actions);
      if (cell.kind === "markdown") text(card, "Markdown 使用純文字預覽，HTML 不會執行。", "small");
      if (object(cell.lastRun)) { const result = document.createElement("div"); result.className = "output"; output(result, cell.lastRun, cell.version); card.appendChild(result); }
      area.appendChild(card);
    });
    if (focusId && cursor) { const node = [...(area as HTMLDivElement).querySelectorAll<HTMLTextAreaElement>("textarea")].find((v) => v.dataset.cellId === focusId); if (node) { node.focus(); node.setSelectionRange(cursor[0], cursor[1]); } }
    buttons();
    renderArtifacts();
    renderInputs();
    renderSetup();
  }
  function renderSetup(): void {
    const area = el("setup-list") as HTMLDivElement; area.replaceChildren();
    if (!current) return;
    const available = current.state === "open" && !current.activeRunId && !current.activeInputId && !current.activeSetupId;
    el("setup-packages").dataset.unavailable = String(!available);
    el("setup-blender").dataset.unavailable = String(!available);
    const phase: Record<string, string> = { checking: "檢查中", installing_packages: "補裝缺少套件", downloading_blender: "下載官方 Blender",
      extracting_blender: "解壓縮", verifying_blender: "核對版本", ready: "已完成", error: "失敗" };
    for (const row of (Array.isArray(current.setupTasks) ? current.setupTasks.filter(object).slice(0, 8) : [])) {
      const item = document.createElement("div"); item.className = "artifact";
      text(item, `${row.kind === "blender" ? "Blender 5.2.2" : "預裝套件"} · ${row.state}${row.result?.phase ? ` · ${phase[row.result.phase] ?? row.result.phase}` : ""}`, "small");
      if (row.state === "pending") text(item, "已排定；下次進度查詢會提交一次，不佔用開機請求等待安裝。", "small");
      if (row.error) text(item, `${row.error.code}${row.error.exitCode !== undefined ? ` · exit ${row.error.exitCode}` : ""}`, "small");
      if (Array.isArray(row.result?.packages)) for (const pkg of row.result.packages.slice(0, 16)) text(item, `${pkg.name} ${pkg.version} · ${pkg.installed ? "本次補裝" : "原已存在"}`, "small");
      if (row.result?.blender?.executable) {
        text(item, row.result.blender.executable, "small");
        const example = document.createElement("button"); example.className = "secondary"; example.textContent = "新增 Blender 路徑 cell";
        example.onclick = () => {
          if (busy || !current || drafts.size >= 64 || current.cells.length + [...drafts.values()].filter((d) => d.notebookId === current!.id && d.version === 0).length >= 200) return;
          drafts.set(crypto.randomUUID(), { notebookId: current.id, kind: "code", version: 0,
            source: `import subprocess\nblender_executable = ${JSON.stringify(row.result.blender.executable)}\nsubprocess.run([blender_executable, "--background", "--factory-startup", "--version"], check=True)` }); render();
        };
        item.appendChild(example);
      }
      area.appendChild(item);
    }
    buttons();
  }
  function renderInputs(): void {
    const area = el("input-list") as HTMLDivElement; area.replaceChildren();
    if (!current) return;
    const host = (window as any).openai;
    el("input-upload").dataset.unavailable = String(current.state !== "open" || Boolean(current.activeRunId) || !host?.uploadFile || !host?.getFileDownloadUrl);
    el("input-import").dataset.unavailable = String(current.state !== "open" || Boolean(current.activeRunId));
    el("input-host-note").textContent = host?.uploadFile && host?.getFileDownloadUrl
      ? "選檔後直接下載到目前 runtime 的 inputs/；不保存到個人檔案庫。"
      : "此畫面未提供 ChatGPT 選檔 API；可在對話附檔並請 ChatGPT 匯入，再回此處查看輸入。";
    for (const row of (Array.isArray(current.inputs) ? current.inputs.filter(object).slice(0, 32) : [])) {
      const item = document.createElement("div"); item.className = "artifact";
      text(item, `${row.filename} · ${row.state}${row.currentRuntime ? "" : " · 舊 runtime（檔案不會跨開機保留）"}`, "small");
      text(item, `${row.path}\n${row.bytes ?? "未知"} bytes · SHA-256 ${row.sha256 ?? "待確認"}`, "small");
      if (row.error) text(item, `${String(row.error.code)}${row.error.httpStatus ? ` · HTTP ${row.error.httpStatus}` : ""}`, "small");
      if (row.state === "ready" && row.currentRuntime) {
        const use = document.createElement("button"); use.className = "secondary"; use.textContent = "新增輸入路徑 cell";
        use.onclick = () => {
          if (busy || !current || drafts.size >= 64 || current.cells.length + [...drafts.values()].filter((d) => d.notebookId === current!.id && d.version === 0).length >= 200) return;
          drafts.set(crypto.randomUUID(), { notebookId: current.id, kind: "code", version: 0,
            source: `from pathlib import Path\ninput_path = Path(${JSON.stringify(row.path)})\nprint(input_path.name, input_path.stat().st_size)` }); render();
        };
        item.appendChild(use);
      }
      area.appendChild(item);
    }
    if (!current.inputs?.length) text(area, "尚無已登記輸入。執行中的 cell 結束並保存後才可匯入。", "small");
    if (current.inputsTruncated) text(area, "只顯示最近 32 筆輸入；較舊 metadata 仍保存在伺服器。", "small");
    buttons();
  }
  function renderCompute(): void {
    const area = el("compute-list") as HTMLDivElement; area.replaceChildren();
    if (!compute) return;
    const format = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-TW", { maximumFractionDigits: 3 }) : "未知";
    el("compute-balance").textContent = `餘額 ${format(compute.currentBalance)} units · 目前帳戶消耗 ${format(compute.consumptionRateHourly)} units/hr · 估計可用 ${format(compute.estimatedHoursRemaining)} 小時${compute.balanceWarning ? " · 餘額不足提醒（不阻擋配置）" : ""}`;
    el("compute-observed").textContent = `帳戶合計估計，非個別 notebook 保證；${compute.observedAt ? new Date(compute.observedAt).toLocaleString("zh-TW") : "上游讀取未確認"}。本程式 ${compute.ownerRuntimeCount} 台／Colab 帳戶 ${compute.assignmentCount ?? "未知"} 台。`;
    const choice = el("compute-choice") as HTMLSelectElement, selected = choice.value || "CPU";
    choice.replaceChildren();
    const eligible = Array.isArray(compute.eligibleGpus) ? compute.eligibleGpus.filter((value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,31}$/.test(value)).slice(0, 64) : [];
    for (const value of ["CPU", ...(eligible.length ? ["AUTO", ...eligible] : []), ...(!["CPU", "AUTO", ...eligible].includes(selected) || selected === "AUTO" && !eligible.length ? [selected] : [])]) {
      const option = document.createElement("option"); option.value = value;
      option.textContent = value === "AUTO" ? "AUTO GPU（L4 優先）" : value === "CPU" ? "CPU" : `${value}${eligible.includes(value) ? "" : "（目前資格未確認）"}`;
      choice.appendChild(option);
    }
    choice.value = selected;
    for (const row of (Array.isArray(compute.notebooks) ? compute.notebooks.filter(object).slice(0, 30) : [])) {
      const line = document.createElement("div"); line.className = "compute-row";
      const machine = row.runtime?.computeVerified ? row.runtime.accelerator : `${row.runtime?.selectedAccelerator ?? row.runtime?.requestedCompute ?? "未知"}（待核對）`;
      const idle = typeof row.idleForMs === "number" ? `閒置 ${Math.floor(row.idleForMs / 60000)} 分鐘` : row.activeRunId ? "cell 尚未完成保存" : "控制／開關機中";
      text(line, `${row.title} · ${machine} · ${state(row.state)} · ${idle}`, "small");
      const view = document.createElement("button"); view.className = "secondary"; view.textContent = "開啟文件";
      view.onclick = () => { void act(async () => { opening = null; discardAllowed = false; adopt(await call("get_notebook", { notebookId: row.id, view: "full" })); }); };
      line.appendChild(view); area.appendChild(line);
    }
    if (!compute.ownerRuntimeCount) text(area, "本程式目前沒有開啟中的 notebook。", "small");
    el("compute-more").hidden = !compute.hasMore;
    if (failure(compute)) text(area, `上游狀態未確認：${failure(compute)}`, "small");
    if (compute.storageWarning) text(area, "已取得即時資料；狀態快取保存未確認。", "small");
  }
  function renderArtifacts(): void {
    const area = el("artifact-list") as HTMLDivElement; area.replaceChildren();
    if (!current || artifactNotebookId !== current.id) return;
    for (const row of artifactRows.slice(0, 64)) {
      const item = document.createElement("div"); item.className = "artifact";
      text(item, `${row.path} · ${Number(row.size).toLocaleString()} bytes · ${row.state}${row.permanent ? " · 永久保留" : row.expiresAt ? ` · ${new Date(row.expiresAt).toLocaleDateString("zh-TW")} 到期` : ""}`, "small");
      text(item, `SHA-256 ${row.sha256}`, "small");
      if (row.state === "ready") {
        const open = document.createElement("button"); open.textContent = "預覽／取得下載連結"; open.className = "secondary";
        open.onclick = () => { void act(async () => {
          const value = await call("get_artifacts", { notebookId: current!.id, artifactId: row.id }); adopt(value);
          const artifact = value.artifacts?.[0]; if (!object(artifact)) return;
          const preview = el("artifact-preview") as HTMLDivElement; preview.replaceChildren();
          if (typeof artifact.downloadUrl === "string") {
            const url = new URL(artifact.downloadUrl);
            if (url.origin === siteOrigin && url.pathname.startsWith("/api/artifacts/")) {
              const link = document.createElement("a"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
              link.textContent = `下載 ${artifact.path}（5 分鐘內，需登入本帳號）`; preview.appendChild(link);
            }
          }
          if (typeof artifact.previewDataUrl === "string" && artifact.previewDataUrl.length < 360_000 && artifact.previewDataUrl.startsWith("data:image/png;base64,")) {
            const image = document.createElement("img"); image.src = artifact.previewDataUrl; image.alt = artifact.path; preview.appendChild(image);
          } else text(preview, "預覽僅支援 256 KiB、400 萬像素內 PNG；其他格式請下載原檔。", "small");
        }); };
        const pin = document.createElement("button"); pin.textContent = row.permanent ? "取消永久保留" : "永久保留"; pin.className = "secondary";
        pin.onclick = () => { void act(async () => {
          const value = await call("pin_artifact", { artifactId: row.id, permanent: !row.permanent }); adopt(value);
          if (object(value.artifact)) artifactRows = artifactRows.map((old) => old.id === row.id ? value.artifact : old);
        }); };
        item.appendChild(open); item.appendChild(pin);
      }
      area.appendChild(item);
    }
    if (!artifactRows.length) text(area, "目前沒有已登記成品。請把檔案寫入 outputs/ 並完成 cell。", "small");
    el("artifact-more").hidden = !artifactNext;
    buttons();
  }
  async function loadArtifacts(beforeId?: string): Promise<void> {
    const value = await call("get_artifacts", { notebookId: current!.id, ...(beforeId ? { beforeId } : {}) }); adopt(value);
    if (Array.isArray(value.artifacts)) {
      artifactNotebookId = current!.id; artifactRows = value.artifacts.filter(object).slice(0, 64);
      artifactNext = value.hasMore ? value.nextBeforeId : null; (el("artifact-details") as HTMLDetailsElement).open = true;
    }
  }
  async function list(): Promise<void> { adopt(await call("get_notebook", {})); }
  async function refreshCompute(afterNotebookId?: string): Promise<void> {
    adopt(await call("get_compute_status", afterNotebookId ? { afterNotebookId } : {}));
  }
  el("new").onclick = () => { void act(async () => {
    if (!opening) opening = { notebookId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), title: (el("new-title") as HTMLInputElement).value.trim() || "新 notebook", compute: el("compute-choice").value };
    const id = opening.notebookId, v = await call("open_notebook", opening); opening = null;
    adopt(v); await list(); adopt(await call("get_notebook", { notebookId: id, view: "full" })); await refreshCompute();
  }); };
  select.onchange = () => { const id = select.value; void act(async () => { if (id) { opening = null; discardAllowed = false; adopt(await call("get_notebook", { notebookId: id, view: "full" })); } }); };
  el("open").onclick = () => { void act(async () => {
    if (!opening || opening.notebookId !== current!.id) opening = { notebookId: current!.id, idempotencyKey: crypto.randomUUID(), title: current!.title, compute: el("compute-choice").value };
    const v = await call("open_notebook", opening); opening = null; adopt(v); await refresh(); await refreshCompute();
  }); };
  el("refresh").onclick = () => { void act(async () => { await list(); await refresh(); }); };
  el("compute-refresh").onclick = () => { void act(async () => refreshCompute()); };
  el("compute-more").onclick = () => { void act(async () => { if (compute?.nextAfterNotebookId) await refreshCompute(compute.nextAfterNotebookId); }); };
  el("interrupt").onclick = () => { void act(async () => {
    const v = await call("interrupt_cell", { notebookId: current!.id }); adopt(v);
    if (!failure(v)) note("已要求中斷，請等待後續結果。"); await refresh();
  }); };
  async function close(discard: boolean): Promise<void> {
    const id = current!.id, v = await call("close_notebook", { notebookId: id, discardOutputs: discard }); adopt(v);
    if (v.released === true) { discardAllowed = false; note("已釋放，並確認 Colab 清單已無此 runtime。"); }
    await list(); adopt(await call("get_notebook", { notebookId: id, view: "full" })); await refreshCompute();
  }
  el("close").onclick = () => { void act(async () => close(false)); };
  el("artifacts").onclick = () => { void act(async () => loadArtifacts()); };
  async function importInput(file: Value): Promise<void> {
    if (!current) return;
    const name = file.file_name ?? "input.bin";
    if (!inputAttempt || inputAttempt.notebookId !== current.id || inputAttempt.fileId !== file.file_id || inputAttempt.name !== name) {
      inputAttempt = { notebookId: current.id, fileId: file.file_id, name, key: crypto.randomUUID() };
    }
    const value = await call("import_file", { notebookId: current.id, idempotencyKey: inputAttempt.key, file });
    if (object(value.input)) inputAttempt.id = value.input.id;
    adopt(value);
    if (!failure(value)) note("已送出匯入，請等待 bytes／SHA-256 確認後使用。過期失敗需取得新網址再重試。");
  }
  el("input-upload").onclick = () => { void act(async () => {
    const host = (window as any).openai, picker = el("input-file") as HTMLInputElement;
    const file = picker.files?.[0]; if (!file || !host?.uploadFile || !host?.getFileDownloadUrl) return;
    if (file.size > 128 * 1024 * 1024) { note("附件超過 128 MiB 上限。", true); return; }
    const { fileId } = await host.uploadFile(file);
    const { downloadUrl } = await host.getFileDownloadUrl({ fileId });
    picker.value = "";
    await importInput({ download_url: downloadUrl, file_id: fileId, file_name: file.name, ...(file.type ? { mime_type: file.type } : {}) });
  }); };
  el("input-import").onclick = () => { void act(async () => {
    const url = (el("input-url") as HTMLInputElement).value; el("input-url").value = "";
    const filename = (el("input-name") as HTMLInputElement).value.trim();
    await importInput({ download_url: url, file_id: (el("input-id") as HTMLInputElement).value.trim(),
      ...(filename ? { file_name: filename } : {}) });
  }); };
  for (const target of ["packages", "blender"]) el(`setup-${target}`).onclick = () => { void act(async () => {
    if (!current) return;
    let attempt = setupAttempts.get(target);
    if (!attempt || attempt.notebookId !== current.id) {
      attempt = { notebookId: current.id, key: crypto.randomUUID() }; setupAttempts.set(target, attempt);
    }
    const value = await call("prepare_runtime", { notebookId: current.id, target, idempotencyKey: attempt.key });
    if (object(value.setup)) attempt.id = value.setup.id;
    adopt(value); await refresh();
  }); };
  el("runtime-packages").oninput = () => { settingsDirty = true; };
  el("runtime-settings-save").onclick = () => { void act(async () => {
    const source = String(el("runtime-packages").value);
    const value = await call("set_runtime_settings", { expectedVersion: settingsVersion,
      packages: source.split(/[\s,]+/).filter(Boolean) });
    if (object(value.settings)) { settingsDirty = String(el("runtime-packages").value) !== source; settingsVersion = value.settings.version; }
    adopt(value); if (!failure(value)) note("套件設定已保存；現有安裝不自動變更。可明確重新準備套件。");
  }); };
  el("artifact-more").onclick = () => { void act(async () => { if (artifactNext) await loadArtifacts(artifactNext); }); };
  el("discard").onclick = () => { void act(async () => close(true)); }; el("consent").onchange = () => render();
  for (const kind of ["code", "markdown"]) el(`add-${kind}`).onclick = () => {
    if (!current || busy) return;
    if (drafts.size >= 64) { note("本機草稿已達 64 格，請先儲存或放棄部分草稿。", true); return; }
    if (current.cells.length + [...drafts.values()].filter((d) => d.notebookId === current!.id && d.version === 0).length >= 200) return;
    const id = crypto.randomUUID(); drafts.set(id, { notebookId: current.id, source: "", kind, version: 0 }); render();
    [...(el("cells") as HTMLDivElement).querySelectorAll<HTMLTextAreaElement>("textarea")].find((t) => t.dataset.cellId === id)?.focus();
  };
  el("export").onclick = () => { void act(async () => {
    const v = await call("export_ipynb", { notebookId: current!.id }); adopt(v); if (!object(v.ipynb)) return;
    const json = JSON.stringify(v.ipynb, null, 2); if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([json], { type: "application/x-ipynb+json" }));
    const a = el("download") as HTMLAnchorElement; a.href = downloadUrl; a.download = v.filename; a.hidden = false; a.textContent = `下載 ${v.filename}`;
    (el("export-json") as HTMLTextAreaElement).value = json; (el("export-details") as HTMLDetailsElement).open = true;
    note("已匯出儲存版本，本機未儲存修改不在檔案中。");
  }); };
  window.addEventListener("message", (event) => {
    if (mode !== "mcp" || event.source !== window.parent) return;
    const data = event.data; if (!object(data) || data.jsonrpc !== "2.0") return;
    if (data.method === "ui/notifications/tool-result") { if (!busy && object(data.params?.structuredContent)) { adopt(data.params.structuredContent); render(); schedule(); } return; }
    const entry = pending.get(data.id); if (!entry) return; pending.delete(data.id); clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error("bridge_error_unknown")); else entry.resolve(data.result);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } else schedule(); });
  window.addEventListener("pagehide", () => {
    alive = false; if (pollTimer !== null) clearTimeout(pollTimer); requests.forEach((r) => r.abort()); requests.clear();
    pending.forEach((r) => { clearTimeout(r.timer); r.reject(new Error("page_closed")); }); pending.clear(); if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, { once: true });
  async function start(): Promise<void> {
    if (mode === "mcp") {
      try {
        await bridge("ui/initialize", { appInfo: { name: "Colab Notebook", version: "0.2.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*"); ready = true;
      } catch { note("MCP Apps 連線未確認，請重新開啟面板。", true); return; }
    }
    await act(async () => { await list(); adopt(await call("get_runtime_settings", {})); await refreshCompute(); if (!compute || !failure(compute)) note("選取文件與機型，或新建 notebook。"); });
  }
  render(); void start();
}

export function editorHtml(mode: "site" | "mcp"): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Colab Notebook</title><style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif;color:#1e3445;background:#f5f7fa}*{box-sizing:border-box}body{margin:0;padding:20px}main{max-width:1060px;margin:auto}
h1{font-size:24px;margin:0}h2{font-size:20px;margin:0}header,.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}header{justify-content:space-between;margin-bottom:20px}.toolbar{margin:14px 0}
button,.download{border:0;border-radius:8px;background:#12645b;color:#fff;padding:9px 13px;font:inherit;cursor:pointer;text-decoration:none}button.secondary{background:#e3ebee;color:#25465b}button.danger{background:#8c3340}button:disabled{opacity:.45;cursor:default}
input,select,textarea{font:inherit;border:1px solid #cdd9e1;border-radius:7px;background:#fff;color:inherit;padding:9px;max-width:100%}select{min-width:230px}textarea{width:100%;resize:vertical;font:13px/1.6 ui-monospace,monospace;margin-top:10px}
.cell{background:#fff;border:1px solid #d9e3ea;border-radius:12px;padding:16px;margin:16px 0}.output{border-top:1px solid #d9e3ea;margin-top:14px;padding-top:12px}.output pre{max-height:360px;overflow:auto}.artifact{margin:14px 0;padding-bottom:12px;border-bottom:1px solid #d9e3ea}.artifact button{margin:8px 8px 0 0}#artifact-preview img{display:block;max-width:100%;max-height:500px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace}small{display:block;color:#607484;line-height:1.6}.output img{max-width:100%;max-height:500px}
#message{min-height:24px;color:#426574}.error{color:#a02e40!important}#state{font-size:12px;color:#526979}.muted{color:#617482;font-size:13px;line-height:1.7}.empty{padding:48px 20px;text-align:center;border:1px dashed #bccdd8;border-radius:12px}
details{margin:16px 0;padding:14px;border:1px solid #d9e3ea;border-radius:9px}summary{cursor:pointer}.rescue{font-size:12px}#export-json{max-height:240px}a{color:#12645b}#new-title{max-width:220px}.compute-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}.compute-row button{white-space:nowrap}#compute-choice{min-width:140px}
@media(max-width:600px){body{padding:12px}select{min-width:0;width:100%}.cell{padding:12px}}
@media(prefers-color-scheme:dark){:root{color:#e1eaf0;background:#14212b}.cell,input,select,textarea{background:#1b2c39;border-color:#3a5061}details,.output{border-color:#3a5061}button.secondary{background:#334e60;color:#e3edf2}small,.muted,#state{color:#adbfcc}a{color:#78cfc1}#message{color:#a1c8d0}}
</style></head><body><main><header><div><h1>Colab Notebook</h1><small>私人文件 · CPU／GPU 與常駐 Python kernel</small></div><small>每本 notebook 一台 runtime</small></header>
<p id="compute-balance" class="muted">按「更新運算狀態」查詢餘額與可用 GPU。</p><small id="compute-observed"></small><details><summary>開啟中的 notebook（每頁 30 本）</summary><div id="compute-list"></div><button id="compute-more" class="secondary" hidden>下一頁</button></details>
<div class="toolbar"><select id="notebooks" aria-label="已儲存 notebook"><option value="">選取已儲存 notebook</option></select><button id="refresh" class="secondary">更新文件</button><button id="compute-refresh" class="secondary">更新運算狀態</button></div>
<div class="toolbar"><label>開機型號 <select id="compute-choice" aria-label="開機型號"><option value="CPU">CPU</option></select></label><input id="new-title" placeholder="新 notebook 名稱" maxlength="120" aria-label="新 notebook 名稱"><button id="new">新建並開啟</button></div>
<p id="message" role="status" aria-live="polite">正在連接…</p><p class="muted">開機後會消耗 Colab 額度；AUTO 只在配置前選一次 GPU，優先 L4，不在拒絕後換型號重配。無產品台數上限，Colab 拒絕時直接回報。CPU 閒置 5 小時／GPU 2 小時後，成品保存完整才釋放；每小時雲端巡檢有額外延遲。</p><div id="empty" class="empty">先選取文件或新建 notebook。開啟面板本身不會配置 runtime。</div>
<section id="workspace" hidden><header><h2 id="title"></h2><span id="state"></span></header><div class="toolbar"><button id="open">依選取機型開啟</button><button id="interrupt" class="secondary">中斷執行</button><button id="close" class="secondary">保存並關閉</button><button id="export" class="secondary">匯出 .ipynb</button><button id="artifacts" class="secondary">保存／查看成品</button></div>
<details id="runtime-setup" open><summary>套件與 Blender</summary><p class="muted">開機後只補裝設定清單中缺少的套件；準備期間不執行 cell。Blender 使用本次核對的官方 5.2.2 獨立 Linux binary，避免 bpy 與 Colab Python 版本耦合，不自動追蹤未來版本。</p><div id="setup-list"></div><div class="toolbar"><button id="setup-packages" class="secondary">重新準備缺少套件</button><button id="setup-blender" class="secondary">按需準備 Blender 5.2.2</button></div></details>
<details id="input-details"><summary>附件與 inputs/</summary><p id="input-host-note" class="muted"></p><div class="toolbar"><input id="input-file" type="file" aria-label="選擇一個附件"><button id="input-upload" class="secondary">匯入所選附件</button></div><small>每檔最多 128 MiB；相同檔名使用不同匯入目錄，不覆寫。檔案只保留在這台 runtime，關閉後不保留。</small><div id="input-list"></div><details><summary>進階／診斷：一次性網址匯入</summary><p class="muted">只用已授權附件的公開 HTTPS 暫時網址。送出立即清除網址；不寫入 cell、歷史或伺服器 metadata。已知過期失敗後填新網址重試；狀態不明時先更新。</p><div class="toolbar"><input id="input-id" placeholder="file_id" maxlength="160" autocomplete="off" aria-label="附件 file_id"><input id="input-name" placeholder="檔名（可略）" maxlength="180" autocomplete="off" aria-label="附件檔名"><input id="input-url" type="password" placeholder="temporary download_url" maxlength="8192" autocomplete="off" aria-label="附件一次性下載網址"><button id="input-import" class="secondary">匯入一次性網址</button></div></details></details>
<div id="cells"></div><div class="toolbar"><button id="add-code" class="secondary">＋ 程式碼</button><button id="add-markdown" class="secondary">＋ Markdown</button></div><small>先儲存，再執行已儲存版本。Ctrl / ⌘ + Enter 執行；每次只送一格。錯誤與中斷結果會保留。</small>
<details id="export-details"><summary>匯出檔案與 JSON</summary><p><a id="download" class="download" hidden>下載</a></p><textarea id="export-json" rows="8" readonly aria-label="ipynb JSON"></textarea></details>
<details id="artifact-details"><summary>成品（每頁最多 64 檔）</summary><p class="muted">寫入 outputs/；每檔最多 10 GiB，每次 run 合計 40 GiB／32 檔。預設保存 30 天，可永久保留。超限或未完整保存會阻止釋放。</p><div id="artifact-list"></div><button id="artifact-more" class="secondary" hidden>下一頁</button><div id="artifact-preview"></div></details>
<details class="rescue"><summary>結果救援／明確放棄輸出</summary><p>若結果、附件或安裝尚未確認，正常關閉會保留 runtime；尚未送出的 pending 安裝可直接取消。請先更新或重試；只有接受遺失未保存內容／中止安裝時才使用下列操作。</p><label><input id="consent" type="checkbox">我接受未保存內容遺失／未完成安裝中止</label><p><button id="discard" class="danger" data-unavailable="true">放棄未保存內容並關閉</button></p></details></section>
<details><summary>套件設定與連線</summary><p id="runtime-settings-version"></p><label>預裝套件（每行一個純 PyPI 名稱，最多 16 個）<textarea id="runtime-packages" rows="6" maxlength="1040" aria-label="預裝套件清單"></textarea></label><button id="runtime-settings-save" class="secondary">儲存下次準備清單</button><p><a href="${SITE_ORIGIN}/oauth/google/start" target="_top">重新授權 Google Colab</a></p><p class="muted">只支援 CPU 與 eligible GPU，不開 TPU。成品與閒置維護由每小時私人雲端排程執行，頁面輪詢不代表排程已執行。安裝不自動重試或更換版本；Markdown 與 HTML 不執行 HTML。</p></details>
</main><script>(${editorBrowser.toString()})(${JSON.stringify(mode)},${JSON.stringify(SITE_ORIGIN)},${MAX_OUTPUT_BYTES});</script></body></html>`;
}

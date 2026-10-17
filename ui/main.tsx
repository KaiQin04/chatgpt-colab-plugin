/**
 * Notebook UI entry. The same bundle serves the private Site page (fetch) and
 * the ChatGPT MCP Apps panel (host bridge); the server injects the mode.
 */
import { createRoot } from "react-dom/client";
import { createBridgeClient, createFetchClient } from "../lib/notebook/client.ts";
import type { NotebookClient } from "../lib/notebook/client.ts";
import { NotebookApi } from "./app/api.ts";
import { App } from "./app/App.tsx";
import "./styles.css";

declare global {
  interface Window {
    __CCM_MODE__?: "site" | "mcp";
    __CCM_SITE_ORIGIN__?: string;
    openai?: { theme?: "light" | "dark"; openExternal?(args: { href: string; redirectUrl?: false }): void };
  }
}

function applyTheme(): void {
  const theme = window.openai?.theme;
  document.documentElement.dataset.theme = theme === "light" || theme === "dark" ? theme : "auto";
}

async function connect(): Promise<NotebookClient> {
  if (window.__CCM_MODE__ === "mcp") {
    return createBridgeClient({ host: window as never, appInfo: { name: "Colab Notebook", version: "0.3.0" } });
  }
  return createFetchClient();
}

function openLink(url: string): void {
  // Signed download URLs must not gain a redirectUrl parameter.
  if (window.openai?.openExternal) window.openai.openExternal({ href: url, redirectUrl: false });
  else window.open(url, "_blank", "noopener,noreferrer");
}

async function start(): Promise<void> {
  applyTheme();
  window.addEventListener("openai:set_globals", applyTheme);
  const root = createRoot(document.getElementById("root")!);
  try {
    const client = await connect();
    const siteOrigin = window.__CCM_SITE_ORIGIN__ && !window.__CCM_SITE_ORIGIN__.startsWith("__")
      ? window.__CCM_SITE_ORIGIN__ : location.origin;
    root.render(<App api={new NotebookApi(client)} siteOrigin={siteOrigin} openLink={openLink}
      onToolResult={(listener) => client.onToolResult(listener)} />);
    window.addEventListener("pagehide", () => client.dispose(), { once: true });
  } catch (error) {
    root.render(<main className="home"><h1>Colab Notebook</h1>
      <p className="note">連線未完成（{error instanceof Error ? error.message : "unknown"}）。請重新開啟面板。</p></main>);
  }
}

void start();

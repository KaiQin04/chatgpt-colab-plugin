import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "./chatgpt-auth";
import { CALLBACK_URL } from "../lib/platform/config.ts";
import { safeError } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await requireChatGPTUser("/");
  let error: Record<string, unknown> | null = null;
  try { await new Store(env).owner({ userId: user.userId, email: user.email }); }
  catch (caught) { error = safeError(caught); }
  if (error) return <main className="spike-home"><h1>Notebook 無法開啟</h1><pre>{JSON.stringify(error, null, 2)}</pre></main>;
  return <main>
    <iframe title="私人 Colab Notebook 編輯器" src="/notebook-ui-next" style={{ width: "100%", height: "calc(100vh - 60px)", minHeight: 720, border: 0 }} />
    <details style={{ margin: "0 auto", padding: "12px 24px", maxWidth: 1100 }}>
      <summary>Site Settings 與 Google OAuth callback</summary>
      <p>在 Site Settings 設定 GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、TOKEN_ENCRYPTION_KEY，並在確認 Site 僅本人可存取後設定 OWNER_PRIVATE_DEPLOYMENT_CONFIRMED=true。Google OAuth Web client 的回呼網址：</p>
      <pre>{CALLBACK_URL}</pre>
    </details>
  </main>;
}

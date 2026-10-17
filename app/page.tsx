import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "./chatgpt-auth";
import { CALLBACK_URL } from "../lib/platform/config.ts";
import { safeError } from "../lib/platform/security.ts";
import { Store } from "../lib/platform/store.ts";
import { NotebookShell } from "./NotebookShell.tsx";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await requireChatGPTUser("/");
  let error: Record<string, unknown> | null = null;
  try { await new Store(env).owner({ userId: user.userId, email: user.email }); }
  catch (caught) { error = safeError(caught); }
  return <NotebookShell error={error} callbackUrl={CALLBACK_URL} />;
}

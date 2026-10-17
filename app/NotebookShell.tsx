"use client";

/** Localized outer Site shell; the iframe owns the notebook's editor state. */
import { LanguagePicker, LocaleProvider, useI18n } from "../ui/app/Locale.tsx";

function Shell({ error, callbackUrl }: { error: Record<string, unknown> | null; callbackUrl: string }) {
  const { t } = useI18n();
  if (error) return <main className="spike-home"><LanguagePicker /><h1>{t("Notebook could not be opened")}</h1>
    <pre>{JSON.stringify(error, null, 2)}</pre></main>;
  return <main>
    <iframe title={t("Private Colab notebook editor")} src="/notebook-ui-next"
      style={{ width: "100%", height: "calc(100vh - 60px)", minHeight: 720, border: 0 }} />
    <details style={{ margin: "0 auto", padding: "12px 24px", maxWidth: 1100 }}>
      <summary>{t("Site Settings and Google OAuth callback")}</summary>
      <p>{t("Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY in Site Settings. Google OAuth Web client callback URL:")}</p>
      <pre>{callbackUrl}</pre>
    </details>
  </main>;
}

export function NotebookShell(props: { error: Record<string, unknown> | null; callbackUrl: string }) {
  return <LocaleProvider><Shell {...props} /></LocaleProvider>;
}

/** Browser-local language selection shared by the Site and embedded notebook UI. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { initialLocale, isLocale, LOCALE_KEY, rememberLocale, translate } from "./i18n.ts";
import type { Locale, Translator } from "./i18n.ts";

function storage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function preferredLocale(): Locale {
  return initialLocale(storage(), navigator.languages?.length ? navigator.languages : [navigator.language]);
}

const LocaleContext = createContext<{ locale: Locale; setLocale(locale: Locale): void; t: Translator } | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  // Match the server-rendered shell, then resolve browser preferences before paint.
  const [locale, updateLocale] = useState<Locale>("en");
  useLayoutEffect(() => { updateLocale(preferredLocale()); }, []);
  const setLocale = useCallback((value: Locale) => {
    rememberLocale(storage(), value);
    updateLocale(value);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === LOCALE_KEY || event.key === null) updateLocale(preferredLocale());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const t: Translator = useCallback((message, variables) => translate(locale, message, variables), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("LocaleProvider is required");
  return value;
}

export function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return <select className="select language-picker" aria-label={t("Language")} value={locale}
    onChange={(event) => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>
    <option value="en" lang="en">English</option>
    <option value="zh-TW" lang="zh-TW">繁體中文</option>
  </select>;
}

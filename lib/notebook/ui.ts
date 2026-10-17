/** Serving helpers for notebook UI documents (legacy editor and bundled preview). */
import { SITE_ORIGIN } from "../platform/config.ts";
import { NOTEBOOK_UI_TEMPLATE } from "./ui-bundle.generated.ts";

/** Inline-only document: no external scripts, styles, frames or forms. */
export const NOTEBOOK_UI_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function notebookUiHtml(mode: "site" | "mcp"): string {
  return NOTEBOOK_UI_TEMPLATE.replace('"__CCM_MODE__"', JSON.stringify(mode))
    .replace('"__CCM_SITE_ORIGIN__"', JSON.stringify(SITE_ORIGIN));
}

export function htmlResponse(html: string): Response {
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": NOTEBOOK_UI_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
  } });
}

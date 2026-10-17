/** Markdown rendering for cells (needs the ui/ build dependencies). */
import DOMPurify from "dompurify";
import { marked } from "marked";

/** Markdown to sanitized HTML: no scripts, handlers, frames or forms; remote images are blocked by CSP. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "iframe", "form", "input", "button", "textarea", "select", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}

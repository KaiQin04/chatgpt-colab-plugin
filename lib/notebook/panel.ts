/** MCP Apps panel: the bundled notebook UI using the host postMessage bridge. */
import { notebookUiHtml } from "./ui.ts";
import { NOTEBOOK_UI_SOURCE_HASH } from "./ui-bundle.generated.ts";
// Hosts may retain a rendered resource across deployments despite zero TTL.
// A new UI build must get a new resource URI, while unchanged builds stay stable.
export const PANEL_URI = `ui://colab-spike/panel-${NOTEBOOK_UI_SOURCE_HASH.slice(0, 16)}.html`;
export const PANEL_MIME = "text/html;profile=mcp-app";
export const PANEL_HTML = notebookUiHtml("mcp");

// Embedded SVG avoids an unauthenticated fetch to the owner-private Site.
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<g fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="5" y="3" width="16" height="18" rx="2.5"/>' +
  '<path d="M9 3v18M3 8h4M3 16h4"/></g>' +
  '<path d="m12.5 8 5.5 4-5.5 4Z" fill="#000"/>' +
  '</svg>';
export const PANEL_ICONS = [{
  src: `data:image/svg+xml;base64,${btoa(ICON_SVG)}`,
  mimeType: "image/svg+xml", sizes: ["any"],
}];

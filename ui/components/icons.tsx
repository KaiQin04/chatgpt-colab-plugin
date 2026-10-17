/** Minimal line icons; every use carries a visible label or aria-label. */
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const Icon = {
  run: () => <svg {...base}><path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" /></svg>,
  stop: () => <svg {...base}><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></svg>,
  up: () => <svg {...base}><path d="m6 14 6-6 6 6" /></svg>,
  down: () => <svg {...base}><path d="m6 10 6 6 6-6" /></svg>,
  trash: () => <svg {...base}><path d="M5 7h14M10 7V5h4v2m-6 0 1 12h6l1-12" /></svg>,
  download: () => <svg {...base}><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" /></svg>,
  more: () => <svg {...base}><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></svg>,
  panel: () => <svg {...base}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M15 5v14" /></svg>,
  type: () => <svg {...base}><path d="M5 7V5h14v2M12 5v14m-3 0h6" /></svg>,
};

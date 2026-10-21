# Public documentation website

The public introduction and dot tutorial live at
https://kaiqin04.github.io/chatgpt-colab-plugin/ . English is the default;
Traditional Chinese uses `/zh-TW/`. Each tutorial links to its translation.

## Edit and validate

- Edit bilingual content in `website/content.mjs` and styles in
  `website/assets/style.css`.
- `website/assets/tokens.css` and `cold-porcelain.css` are retained copies of
  the Cold Porcelain design-system assets. Keep palette and type defaults there;
  `style.css` contains site layout and the requested Quote/Finding adaptations.
  The document follows the system theme with `data-theme="auto"`. Google Fonts
  supplies Spectral, Noto Serif TC, LXGW WenKai TC, IBM Plex Sans, Noto Sans TC,
  and IBM Plex Mono; the token font stacks include local fallbacks.
- `scripts/build-pages.mjs` supplies the shared layout, metadata, language
  alternates, structured data, and sitemap. Change its origin/base together if
  moving the site. It validates local links and fragment targets.
- Run `node scripts/build-pages.mjs`. Only explicitly listed static files are copied to
  `dist/pages`; no backend, OAuth settings, evidence, or runtime data is included.
- Preview under `/chatgpt-colab-plugin/`, not just `/`, to check nested asset and
  language links. Check both languages and both page types at desktop and mobile
  widths, plus keyboard navigation and reduced motion.
- Update the editorial date and release baseline only when the content changes.
  Existing screenshot provenance is documented in `docs/images/README.md`.

## Publish and verify

GitHub Pages uses GitHub Actions as its build source. The `pages.yml` workflow
builds without installing app dependencies, uploads only `dist/pages`, and
publishes on relevant changes to `main` or a manual dispatch. Publishing this
static site never deploys the private notebook backend.

After publication, check the workflow's commit SHA, fetch all four public page
URLs, compare their bytes with the local build, and check CSS, images, and
`sitemap.xml`. In a browser, inspect mobile/desktop layout and language links.

The repo About URL should point at the website. Topics describe ChatGPT, Colab,
MCP, notebooks, and Python. These settings live on GitHub, outside Git.

Crawlers read robots.txt at the origin root. This project-site deployment does
not control that path; a `robots.txt` inside the project subdirectory would not
control crawling, so the build does not create one. Do not imply that allowing a crawler guarantees
indexing or AI citations. Search Console ownership/submission is a separate
account action. The English homepage includes the public Google site-verification
meta tag for the exact URL-prefix property above. Keep that tag after verification
so Google can recheck ownership; it is not an OAuth token or a client secret.
Submit `sitemap.xml` within this property and check its processing status separately
from page indexing. Keep any future verification changes scoped to the intended
Google account and this project URL.

Keep `website/`, this guide, the Pages workflow, and its build script when
synchronizing a later public release. They are public packaging maintained in
this repository, like its bilingual README; they are not private Site source.

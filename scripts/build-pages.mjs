/** Build the public documentation site from an explicit, static asset list. */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repository, dotReference, updated, labels, home, tutorial, escapeHtml } from '../website/content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist/pages');
const origin = 'https://kaiqin04.github.io';
const base = '/chatgpt-colab-plugin/';
const site = `${origin}${base}`;
const routes = [
  { path: '', locale: 'en', kind: 'home' },
  { path: 'zh-TW/', locale: 'zh-TW', kind: 'home' },
  { path: 'guides/dot-colab/', locale: 'en', kind: 'guide' },
  { path: 'zh-TW/guides/dot-colab/', locale: 'zh-TW', kind: 'guide' },
];
const document = (route) => {
  const t = labels[route.locale];
  const zh = route.locale === 'zh-TW';
  const isGuide = route.kind === 'guide';
  const englishPath = isGuide ? 'guides/dot-colab/' : '';
  const chinesePath = `zh-TW/${englishPath}`;
  const title = isGuide ? t.guideTitle : t.title;
  const description = isGuide ? t.guideDescription : t.description;
  const url = `${site}${route.path}`;
  const localHome = `${base}${zh ? 'zh-TW/' : ''}`;
  const guide = isGuide ? tutorial(route.locale) : null;
  const schema = isGuide ? {
    '@context': 'https://schema.org', '@type': 'TechArticle', headline: title,
    description, url, inLanguage: route.locale, dateModified: updated,
    author: { '@type': 'Person', name: 'KaiQin04', url: 'https://github.com/KaiQin04' },
    isPartOf: { '@type': 'WebSite', name: 'ChatGPT Colab Plugin', url: site },
  } : {
    '@context': 'https://schema.org', '@type': 'SoftwareSourceCode',
    name: 'ChatGPT Colab Plugin', description, url, inLanguage: route.locale,
    codeRepository: repository, license: 'https://opensource.org/license/mit',
    programmingLanguage: 'TypeScript', version: '0.3.0',
  };
  return `<!doctype html>
<html lang="${route.locale}" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#eff3f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101922" media="(prefers-color-scheme: dark)">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="en" href="${site}${englishPath}">
<link rel="alternate" hreflang="zh-TW" href="${site}${chinesePath}">
<link rel="alternate" hreflang="x-default" href="${site}${englishPath}">
<meta property="og:type" content="${isGuide ? 'article' : 'website'}">
<meta property="og:site_name" content="ChatGPT Colab Plugin">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${url}">
<meta property="og:locale" content="${zh ? 'zh_TW' : 'en_US'}">
<meta property="og:locale:alternate" content="${zh ? 'en_US' : 'zh_TW'}">
<meta property="og:image" content="${site}assets/notebook-${zh ? 'zh-TW' : 'en'}.jpg">
<meta property="og:image:alt" content="${zh ? '本機合成資料 Notebook 介面預覽' : 'Notebook interface preview with local synthetic data'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="${base}assets/icon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&amp;family=LXGW+WenKai+TC:wght@400;700&amp;family=Noto+Sans+TC:wght@400;500;700&amp;family=Noto+Serif+TC:wght@400;500;600;700&amp;family=Spectral:ital,wght@0,400;0,500;0,600;1,400;1,500&amp;display=swap">
<link rel="stylesheet" href="${base}assets/tokens.css">
<link rel="stylesheet" href="${base}assets/cold-porcelain.css">
<link rel="stylesheet" href="${base}assets/style.css">
<script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>
</head>
<body class="cp-type-body">
<a class="skip" href="#main">${t.skip}</a>
<header><nav class="wrap" aria-label="${zh ? '主要導覽' : 'Main navigation'}"><a class="brand cp-type-ui" href="${localHome}"><img src="${base}assets/icon.svg" alt="" width="30" height="30">ChatGPT Colab Plugin</a><div class="nav-links cp-type-label"><a href="${localHome}${isGuide ? '' : 'guides/dot-colab/'}">${isGuide ? t.home : t.guide}</a><a href="${base}${zh ? englishPath : chinesePath}" lang="${zh ? 'en' : 'zh-TW'}" hreflang="${zh ? 'en' : 'zh-TW'}">${t.language}</a><a href="${repository}">GitHub ↗</a></div></nav></header>
<main id="main">${isGuide ? `<div class="article-head"><div class="wrap"><h1 class="cp-type-title">${title}</h1><p class="lead">${guide.intro}</p><p class="meta cp-type-small">${zh ? '作者' : 'By'} <a href="https://github.com/KaiQin04">KaiQin04</a> · ${zh ? '更新日期' : 'Updated'} <time datetime="${updated}">${updated}</time> · v0.3.0</p></div></div><div class="wrap article-layout"><aside class="toc cp-type-small"><nav aria-label="${zh ? '本篇內容' : 'On this page'}"><strong>${zh ? '本篇內容' : 'On this page'}</strong><ol>${guide.toc}</ol></nav></aside><article class="article cp-prose cp-type-body">${guide.body}<section id="references"><h2 class="cp-type-heading">${zh ? '參考文件' : 'References'}</h2><ul><li><a href="${repository}/blob/main/docs/DEPLOYMENT${zh ? '' : '.en'}.md">${zh ? '專案部署指南' : 'Project deployment guide'}</a></li><li><a href="${repository}/blob/main/docs/OAUTH${zh ? '' : '.en'}.md">${zh ? 'Google OAuth 設定指南' : 'Google OAuth setup guide'}</a></li><li><a href="${dotReference}">${zh ? 'OpenAI：dot 的 Plugin 連線與權限' : 'OpenAI: dot plugin connections and permissions'}</a></li></ul><p><a href="${repository}/issues">${zh ? '回報文件或設定問題' : 'Report a documentation or setup issue'} →</a></p></section></article></div>` : home(route.locale, base)}</main>
<footer class="cp-type-small"><div class="wrap"><p>${t.footer}</p><a href="${repository}">${t.source} ↗</a></div></footer>
</body>
</html>
`;
};

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'assets'), { recursive: true });
const assets = [
  ['website/assets/tokens.css', 'assets/tokens.css'],
  ['website/assets/cold-porcelain.css', 'assets/cold-porcelain.css'],
  ['website/assets/style.css', 'assets/style.css'],
  ['website/assets/icon.svg', 'assets/icon.svg'],
  ['docs/images/notebook-en.jpg', 'assets/notebook-en.jpg'],
  ['docs/images/notebook-zh-TW.jpg', 'assets/notebook-zh-TW.jpg'],
];
for (const [source, destination] of assets) copyFileSync(join(root, source), join(output, destination));
const documents = new Map();
for (const route of routes) {
  const html = document(route);
  documents.set(`${base}${route.path}`, html);
  const path = join(output, route.path, 'index.html');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html);
}
writeFileSync(join(output, '.nojekyll'), '');
writeFileSync(join(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(({ path }) => `<url><loc>${site}${path}</loc><lastmod>${updated}</lastmod></url>`).join('')}</urlset>\n`);
writeFileSync(join(output, '404.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page not found — ChatGPT Colab Plugin</title><h1>Page not found / 找不到頁面</h1><p><a href="${base}">English</a> · <a href="${base}zh-TW/">繁體中文</a></p></html>\n`);

// Validate generated navigation, language pairs, metadata, and fragment targets.
// This also checks nested project-site URLs before an artifact can be uploaded.
for (const [path, html] of documents) {
  if ((html.match(/<h1(?:\s[^>]*)?>/g) ?? []).length !== 1) throw new Error(`Expected one h1: ${path}`);
  if (!html.includes(`rel="canonical" href="${origin}${path}"`)) throw new Error(`Invalid canonical: ${path}`);
  if (!html.includes('hreflang="en"') || !html.includes('hreflang="zh-TW"')) throw new Error(`Missing language pair: ${path}`);
  JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
  for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = new URL(target.replaceAll('&amp;', '&'), `${origin}${path}`);
    if (url.origin !== origin) continue;
    if (!url.pathname.startsWith(base)) throw new Error(`Link escapes project site: ${target}`);
    const localPath = url.pathname.slice(base.length);
    const destination = join(output, localPath, url.pathname.endsWith('/') ? 'index.html' : '');
    if (!existsSync(destination)) throw new Error(`Missing local link: ${path} -> ${target}`);
    if (url.hash && !readFileSync(destination, 'utf8').includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) {
      throw new Error(`Missing fragment: ${path} -> ${target}`);
    }
  }
}
console.log(`Built and validated ${routes.length} bilingual pages and ${assets.length} assets in dist/pages.`);

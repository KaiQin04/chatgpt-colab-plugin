# Notebook UI 建置來源

[English](BUILD-PROVENANCE.en.md)

自 v0.3.2 起，Git 只追蹤可讀 UI 原始碼、建置腳本與依賴鎖檔，不再追蹤生成的
Notebook UI 模組及中間 bundle。舊版 tag 保留原有檔案。

正式建置透過 `scripts/build-notebook-ui.mjs`，由 `ui/` 及共用 Notebook 模組
生成被忽略的 `lib/notebook/ui-bundle.generated.ts`。單一 HTML／JavaScript／CSS
文件讓 MCP Apps 面板不必向外部主機載入 script 或 stylesheet；Vite 壓縮讓部署
文件維持在大小限制內。部署封裝仍包含建置後 UI；原始碼 repo 與 source archive
則保留可讀的建置輸入。

## 重建與驗證

使用 Node.js 24 LTS：

```sh
npm ci
npm run check:ui
npm run check
npm run build
```

根目錄 `postinstall` 會以 development、optional 依賴執行 `npm ci --prefix ui`，
因此兩份 lockfile 均會安裝。若明確停用 install scripts，需先另執行
`npm ci --prefix ui --include=dev --include=optional`。

npm lifecycle 會在 `test`、`typecheck`、`dev`、`dev:ui`、`build` 前自動生成
模組，乾淨 checkout 也適用。`check:ui` 先生成，再獨立重建並逐位元比對；低階
`node scripts/build-notebook-ui.mjs --check` 只比對現有模組，缺少、過期或內容
不同都會失敗。也可用 `npm run build:ui` 明確生成。生成模組與 `.ui-build/` 不得提交。

回歸測試使用沒有生成檔的隔離來源樹，執行真正的 Vite／TypeScript 流程，改動
來源後驗證會重建。程式測試另檢查 source hash、文件自足性、大小限制、HTML
清理與存取邊界。

## 掃描器判讀

M8ven 報告列出一個壓縮／打包檔案，但未提供檔名。v0.3.2 前，此生成模組是
受追蹤 JS／TS 中唯一單行超過 20,000 字元的檔案；重建逐位元一致，支持警示
來自建置產物的判斷。因報告沒有公開檔名，仍未確認警示的精確對象。

移除目前 Git 樹中的生成產物可以改善來源審查，但不保證特定評分，也不能取代
來源與依賴安全檢查。警示是否改變，必須以新 commit 的實際重掃結果確認。

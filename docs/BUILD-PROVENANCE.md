# Notebook UI 建置來源

[English](BUILD-PROVENANCE.en.md)

`lib/notebook/ui-bundle.generated.ts` 將 Notebook 編輯器打包為單一、壓縮後的
HTML／JavaScript／CSS 字串。`scripts/build-notebook-ui.mjs` 透過 Vite 建置
可讀的 `ui/` 原始碼，再嵌入 TypeScript 模組；`ui/vite.config.ts` 明確設定
`minify: true`。原始程式與建置腳本均保留在 repo。

單一文件讓 MCP Apps 面板不必向外部主機載入 script 或 stylesheet，壓縮則
減少傳輸大小。掃描器可能將超長字串標記為混淆碼或不可讀程式；這個分類本身
不能證明程式有惡意行為。

## 重建與驗證

使用 Node.js 24 LTS，依兩份鎖檔安裝後檢查：

```sh
npm run install:ci
npm ci --prefix ui
npm run check:ui
```

`check:ui` 在被忽略的 `.ui-build/` 重新建置，將完整生成模組與已提交檔案逐位元
比較。即使有人保留 `NOTEBOOK_UI_SOURCE_HASH` 卻改動 bundle，也會失敗。檢查
不會覆寫已提交模組；`npm run check` 已納入這一步。

有意更新時執行 `npm run build:ui`，審查來源、依賴與生成差異，再重跑檢查。

## 2026-10-25 調查

M8ven 對 `0ca092ac77e813ec6b8252c1bb695585f99c73ce` 的公開報告列出一個
不可讀／壓縮檔案，但未提供檔名。本模組是受追蹤 JS／TS 中唯一單行超過
20,000 字元的檔案。更新前使用當時已安裝依賴重建，結果逐位元一致；SHA-256 為
`a3dcf182cec7431c93cdd76eb610cf43319d332844bc036d8d54f09d127c65c8`。

這確認了模組可由現有來源重建，並支持警示來自壓縮建置產物的判斷。M8ven
未公開檔名，因此仍未確認該警示的精確對象；本次沒有提交申訴或寄送認領信件。
可重現建置也不能取代來源與依賴的安全檢查。

# 驗證紀錄

[English](VALIDATION.en.md) | [繁體中文](VALIDATION.md)

## v0.1.1（2026-10-17）

- 105 個應用測試與 2 個設定測試通過，沒有 skipped tests；型別檢查、UI bundle 重建及 production build 通過。
- MCP 面板資源 URI 包含 UI 來源雜湊，避免更新部署後仍重用舊編輯器。新增回歸測試，並檢查 golden 中僅預期 URI 改變。
- 維護者既有私人 Site：瀏覽器實際以 Shift＋Enter 執行 `print(1 + 2)`，輸出 `3`，顯示「由你執行」，後端紀錄 `actor: user`。
- 新版嵌入 MCP 面板的執行按鈕也記錄 `actor: user`，但該筆 Colab WebSocket handshake 逾時，未取得結果；不列為嵌入按鈕完整執行通過。
- 英文 README、部署／OAuth／驗證說明與繁體中文文件互相連結。

既有維護者部署的驗證不等同全新第三方帳號部署驗收。未驗證項目仍包括新帳號建立 Site、OAuth 與私人 plugin 的端到端流程。

## v0.1.0

2026-10-17，在乾淨匯出的公開專案與獨立依賴環境完成：

- npm root／UI lockfile 安裝成功。
- Node.js 22.14.0、Python 3.12.11、專案 `.venv` 及鎖定 flake8 依賴。
- 104 個 Node 測試與 2 個部署設定測試通過，無 skipped tests；包括實際 Python wrapper harness、OAuth／owner 邊界、Notebook／artifact 狀態機及 golden snapshots。
- TypeScript typecheck、UI bundle 來源雜湊、Vinext production build 通過。
- 人工操作與助理操作的 MCP dispatch／資料庫來源記錄已做回歸測試。UI bridge 對手動儲存與執行選用 app-only aliases；兩者都保留 owner 檢查與參數驗證。
- 未確認私人部署時不允許 owner enrollment 或 maintenance；configure 拒絕不合法 origin、憑證型 URL，以及覆寫不同 Site。
- 私人開發來源同步 helper 以目前候選版本預覽為零差異；公共設定與個別部署識別分離。

以上是本機合成／契約與建置驗證。**尚未使用全新第三方帳號完成 Site 建立、Google OAuth、私人 Plugin 安裝與真實 Colab 運算的完整驗收**。沒有為此版本開啟 runtime，也沒有改動既有私人 Site 的線上部署。

商店上架、Google production verification、任意 Cloudflare／VPS hosting 不在已驗證範圍。範例來源的歷史私人驗收不算本公開版本對所有帳號的成功證明。

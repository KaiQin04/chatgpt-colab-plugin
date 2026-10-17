# v0.1.0 驗證紀錄

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

# Agent instructions

## 專案角色與發布邊界

- 這是公開穩定版本 repo；維護者的私人 repo 是主要開發來源。
- 一般功能與修正先在私人開發來源完成，再依 docs/RELEASING.md 清理、同步及標記版本。不可假設公開 main 要跟隨每次實驗性修改。
- 外部貢獻可以提交 PR。維護者納入私人開發來源驗證後再發布，避免下一次同步覆蓋修正。
- 不得把來源私人 repo 設為 public、搬移其 Git 歷史，或上傳 Site 專案 ID、私人網址、憑證、使用者資料、驗收輸出。
- 更新公開 repo 不等於部署私人 Site。不得自動改動維護者或使用者已有的 Site、Google Cloud 專案或存取權限。

## 部署

- 閱讀 docs/DEPLOYMENT.md、docs/OAUTH.md、skills/setup/SKILL.md；使用當前安裝的 Sites skill。
- 使用新的私人 Site 與使用者自己的 OAuth client。已存在的部署要保留其 project_id、origin、資料及 secrets。
- .openai/hosting.json 的公開版本必須沒有 project_id；lib/platform/deployment.ts 保持 https://unconfigured.invalid。
- OWNER_PRIVATE_DEPLOYMENT_CONFIRMED 預設不設定；只有查證 Site 僅本人可存取後才能設 true。這是設定確認，不是身份驗證本身。
- 不支援把 Sites 身分 headers 當作一般網際網路請求的可信憑證。
- 不將 token、OAuth client secret、加密金鑰、Site source credential 放進對話、命令參數或 Git。

## 修改與驗證

- 說明文件使用繁體中文；程式碼與識別字使用英文。先找既有 scripts，不猜 target。
- npm ci、npm ci --prefix ui；Python 使用本 repo .venv 或明確的 NOTEBOOK_TEST_PYTHON，不用全域 Python 環境。
- 修改 ui/、lib/notebook/client.ts 或 contract.ts 後，執行 npm run build:ui。生成檔需一起提交。
- 執行 npm run check 與 npm run build；對外發布另執行 npm run audit:public。Golden 只能針對預期變更更新並檢查差異；不得藉更新 golden 掩蓋未知回歸。
- 合成測試不能冒充 Google OAuth、真實 Colab 或新帳戶部署驗證。不得為包裝／文件工作自行開啟 runtime 或花費額度。
- MCP UI-only aliases 僅記錄操作來源，不是授權邊界；所有路徑仍需相同 owner 驗證。
- Commit 使用 feat/fix/docs/refactor/test/chore 等分類。發布前閱讀 docs/RELEASING.md。

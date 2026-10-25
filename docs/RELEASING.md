# 開發、穩定版本與升級

## 維護者流程

1. **私人 repo 開發**：功能與 bug fix 在私人開發來源完成；Site 原始碼在獨立的 Sites source checkout。測試與私人 Site 部署分開記錄。
2. **明確選擇穩定版本**：對外發布時，將受追蹤的程式匯出至公開 checkout，不帶私人 Git 歷史。私人專案的發布指南及匯出 helper 定義確切來源與清理規則。
3. **審查公開差異**：只同步 app、lib、ui、schema、測試及必要的 build 支援。公共部署文件、設定腳本與安全預設需要保留；私人 evidence、來源庫憑證、Google client JSON、runtime 產物不得匯出。
4. **驗證**：執行 `npm run install:ci`、`npm run check`、`npm run build`。依兩份 lockfile 安裝依賴；測試及建置會從可讀來源自動生成 ignored UI bundle。另以不含生成檔的乾淨來源驗證建置。檢查 golden 差異；確認 Python tests 沒跳過、預設 origin 為 unconfigured、hosting manifest 沒有 project_id。
5. **檢查秘密與私人識別**：先 `git add` 已審查的發布內容，確認沒有未 stage 的修改或未追蹤檔，再執行 `npm run audit:public`。檢查直接讀取 index 中的 blobs，成功時記錄 Git tree ID；生成 UI 與其他 ignored build 產物不得加入 index。修改後必須重新 stage 並重跑。最後人工檢查完整 staged diff 與部署封裝，確認沒有個人路徑、真實 Site URL／ID、token／key、私人帳號與使用者資料；合成 fixtures 必須清楚標示。掃描器不能取代人工差異審查。
6. **發布**：使用 conventional commit，推送公開 repo，讀回 GitHub visibility 與 remote SHA，再標記版本並建立正式 GitHub Release、設為 Latest。私人 repo 與私人 Site 維持原有存取範圍。公開 repo 推送不觸發私人 Site 部署。

不設定每次 private commit 自動發布；原始碼開源授權與 Google／OpenAI 平台使用授權是不同事項。

## 使用者升級

不要在 production checkout 直接覆蓋所有檔案。先匯出 notebook／必要成品，確認沒有正在執行的 cell、匯入或環境準備，並記錄原部署版本。

1. 取得選定公開 tag，閱讀版本說明與 migration 差異。
2. 使用 Sites 既有 Site 工作流打開自己的 source checkout，確認同一 project ID 與 owner-private audience。
3. 由 agent 比對並套用新版程式；保留自己的 `.openai/hosting.json`、`lib/platform/deployment.ts` 及 Site Settings secrets，不把公共的未設定值覆蓋到現有部署。
4. 新版只新增需要的 schema migrations，不重跑破壞性初始化、不刪除 DB／R2。遇到不相容 migration 先提出具體方案。
5. 執行本機檢查並發布到原 Site，讀回部署結果，再做不消耗運算的檢查。

這版提供人工／agent 引導升級，沒有自動更新器。若要回復舊版，必須確認資料庫 schema 相容，不可只回退程式後宣稱 rollback 完成。

# 部署到自己的私人 Site

[English](DEPLOYMENT.en.md) | [繁體中文](DEPLOYMENT.md)

## 前置條件

- 可建立私人 ChatGPT Site 的帳號，已安裝 Sites Plugin；不同帳號的可用功能可能不同。
- 自己的 Google Cloud 專案、OAuth Web client，以及可使用 Colab 的 Google 帳號。
- Node.js 22.13+、npm；本機完整驗證另需 uv／Python 3.12。

這份模板依賴 Sites 驗證使用者並覆寫身分 headers。不要直接 `wrangler deploy` 到開放的 Worker；那樣不能保證 owner 驗證有效。

## 1. 取得版本

Clone 本 repo，選擇維護者標記的版本，例如 `git switch --detach v0.2.0`。公共模板不得包含任何現有 Site ID、OAuth secret 或私人資料。

安裝依賴並驗證：

```sh
npm run install:ci
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
npm run check
```

`npm run install:ci` 會明確安裝兩份鎖檔；測試與建置會由可讀來源生成 ignored UI bundle，不需複製或提交生成檔。

## 2. 建立新的私人 Site

讓具有 Sites 工具的 agent 讀取當前 Sites skill，以本 repo 作為 **retained template** 建立新 Site。在新的空部署目錄執行 Sites 提供的 `project-setup.mjs --template-source <absolute-sanitized-source-directory>`。模板來源只能有受版本控制的程式；不要把本機 node_modules、.git、.env、.venv、dist、.wrangler、.sites-runtime 當模板搬過去。

使用 native `create_site`，保留回傳的 project ID 與 Site URL。建立後預設私人，但仍要用 `get_site` 查核：owner 是自己、沒有其他允許的使用者／群組，也不是公開 Site。不確定或帳號不支援時停止部署，不以開放權限繞過。

Sites source credential 僅交給官方 source helper 的隱藏 stdin；不可貼到對話、命令列、Git 或文件。

## 3. 設定自己的部署識別

在部署 checkout 執行，使用上一步實際回傳的值：

```sh
npm run configure -- --site-url https://YOUR-SITE.chatgpt.site --project-id appgprj_YOUR_PROJECT_ID
```

這會設定 `lib/platform/deployment.ts` 與 `.openai/hosting.json`，並顯示 Google redirect URI。腳本不接收或儲存任何 secret，也不會允許覆寫不同的既有 Site。遇到錯誤請查核 ID／網址，不要刪掉檢查來強制部署。

`d1: "DB"`、`r2: "BUCKET"` 與 `capabilities: ["mcp"]` 必須保留。`drizzle/*.sql` 是全新資料庫及後續版本的 schema migrations；透過 Sites 工作流套用，不手動刪除已建立的表。

## 4. Google OAuth 與 secrets

先完成 [OAuth 指南](OAUTH.md)。在自己的 Site Settings／原生秘密設定介面設定：

| 名稱 | 內容 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 自己的 Google Web client ID |
| `GOOGLE_CLIENT_SECRET` | 同一 client 的 secret |
| `TOKEN_ENCRYPTION_KEY` | 32 個隨機 bytes 的 Base64 字串 |
| `OWNER_PRIVATE_DEPLOYMENT_CONFIRMED` | 確認該 Site 僅本人可存取後，填入字串 `true` |

可以在自己的本機 terminal 執行 `openssl rand -base64 32` 產生金鑰，直接填入秘密設定介面，不貼到 agent 對話。請安全保存此金鑰；直接更換會讓既有加密 refresh token 無法解密，必須重新授權。`.env.example` 僅記錄欄位名稱，不會自動把本機環境同步到 Sites。

未設定 private confirmation 時，owner enrollment 與受保護操作會拒絕執行。此開關只是你已查核部署的確認，不會把公開 Site 自動變私人。

## 5. 建置與私人發布

依當前 Sites skill 使用 source helper 同步到 **新 Site 自己的來源庫**、執行尚未通過的檢查、build-site helper、打包。使用確認為 owner-private 的發布工具 `save_version_and_deploy_private`，或 skill 指定的對應流程。不要把此新 Site 的 source credential 用在其他 Site。

完成後記錄新 Site 的部署版本與 URL。平台若要求 D1 migration，依當前 Sites storage workflow 套用受追蹤的 migrations。保持相同 project ID，既有部署升級時不重建資料庫或覆寫 secrets。

## 6. 授權並連接自己的私人 Plugin

1. 用自己的帳號開啟新 Site。點編輯器內的 Google 授權連結，在 Google 頁面確認授權給自己的 OAuth client。
2. 發布帶有 `mcp` capability 的 Site 時，Sites 會為 owner 建立私人 App／Plugin。這是每人自己的連接，不使用 repo 作者的後端。
3. 若工具沒有出現，讓 agent 用 `get_site(include_mcp_connection: true)` 取得新 Site 的 plugin ID，再以 Plugin Management 顯示安裝／連接介面。也可在 Plugins → Personal → Created by you 找到；介面名稱依版本可能改變。
4. 不需要另建公共商店 Plugin，也不要手寫含 token 的 MCP headers。若帳號缺少這些能力，保留來源並回報限制。

## 7. 驗收與清理

先開啟 panel／讀取 runtime settings，確認沒有建立 Colab runtime。Google 授權完成後，可讀取餘額與可用機型；這不代表所有機型均可配置。

介面支援 English／繁體中文。首次依瀏覽器偏好順序選擇支援語言，無符合項目時使用英文；可從首頁或編輯器工具列切換。已儲存的選擇優先，瀏覽器禁止儲存時仍可在當次面板使用選定語言。

只有在本人同意使用額度後才做真實測試：開啟一台 CPU、執行 `print(1 + 2)`、下載 `.ipynb`、確認成品可讀，再關閉 runtime 並查核已釋放。Shift＋Enter 的新執行應顯示「由你執行／Run by you」，助理發起的執行應顯示「由 ChatGPT 執行／Run by ChatGPT」。舊紀錄不會被重寫。

背景閒置清理需要另設 Sites 的 recurring update，不能只靠關閉網頁。請按目前 skill 建立至少每小時一次的私人 service-access POST `/api/maintenance`，JSON body 為 `{}`；憑證不能寫進排程文字。未設定排程時，明確保留手動關閉責任；即使有排程也不是精確到期保證。

解除安裝 Plugin、撤銷 OAuth 或刪除 Site 前，先釋放這個部署的 runtime，再備份需要的 notebook／成品。不要停止其他任務的 runtime。

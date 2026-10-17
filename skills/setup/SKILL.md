---
name: setup-chatgpt-colab
description: Guide an owner through deploying this template to their own private ChatGPT Site, configuring their own Google OAuth, and connecting the Site-created private plugin.
---

# 自有 Colab Plugin 設定

先讀 repo 根目錄 AGENTS.md、docs/DEPLOYMENT.md、docs/OAUTH.md，再讀本環境提供的 Sites skill。這個 skill 是 repo 內的設定指南，不表示已在公開 Plugin 商店上架。

1. 確認是新建部署還是明確指定的既有 Site 升級。新建使用新的私人 Site、獨立部署 checkout；升級保留原 project ID、origin、資料與 secrets。
2. 以公開 tag 的乾淨 tracked files 作 retained template；不要複製 .git、.env、node_modules、.venv、.wrangler 或舊 Site 識別。依當前 Sites skill 建立並持久化新 project ID。
3. 用 get_site 查核 Site 僅 owner 可存取。設定 configure 腳本回傳的 callback URL，不猜 slug 或使用 repo 作者的部署。
4. 引導使用者在自己的 Google Console 建立 OAuth Web client，僅要求文件列出的 scopes。Google 登入／同意由本人在瀏覽器完成。
5. 憑證透過 Site Settings 或原生 secrets UI 設定，不能要求貼進對話。確認權限後設定 OWNER_PRIVATE_DEPLOYMENT_CONFIRMED=true。
6. 完成檢查與 build，依 Sites workflow 發布至剛確認的私人 Site。不得為設定方便而改成 public。
7. 重用 Sites 建立的私人 Plugin；讀取 include_mcp_connection，必要時透過 Plugin Management 顯示安裝介面。不建立共用作者後端或額外公共 MCP 入口。
8. 先以 panel／settings 完成不配置 runtime 的檢查。只有獲得使用額度的授權後才啟動真實運算；完成後保存產物、停止本次 runtime 並查核釋放。

工具／平台能力不可用時保留來源，明確說明未完成的步驟。不要把 OAuth 成功宣稱成 Google 對第三方公開整合的批准，也不要把合成測試說成真實帳號驗收。

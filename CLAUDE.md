# Claude agent instructions

先閱讀並遵守 [AGENTS.md](AGENTS.md)。

公開首頁以英文說明「Run Colab notebooks in ChatGPT using your own Colab compute credits.」，保留 README.zh-TW.md 與中英部署／OAuth 指南。不要把英文首頁覆蓋成僅中文。

Notebook 介面也提供 English／繁體中文；元件文案使用 ui/app/i18n.ts 與 LocaleProvider，保留瀏覽器語言預設及使用者選擇。維護流程與限制細節放專用文件，不加回使用者已移除的 README 區段。

此 repo 是公開穩定版本，主要開發在維護者的私人 repo。請依 [發布流程](docs/RELEASING.md) 同步已驗證的版本，不把私人 Git 歷史、Site 設定、憑證或驗收資料帶進來。

公開 repo 更新、私人 Site 部署與使用者升級是獨立動作；不得因修改公開程式就自動部署既有 Site。部署與 OAuth 請讀取 docs/DEPLOYMENT.md、docs/OAUTH.md 及 skills/setup/SKILL.md。

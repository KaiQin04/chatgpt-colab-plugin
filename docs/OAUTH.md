# 自己的 Google OAuth

OAuth 用瀏覽器登入取得 token；使用者不需手動貼 token。每位部署者仍需建立自己的 **OAuth client ID／client secret**，它們用來識別應用程式，與使用者授權後取得的 access／refresh token 不同。

## 設定步驟

1. 在自己的 Google Cloud Console 建立獨立專案，進入 Google Auth Platform。
2. Branding 填寫能識別自己部署的名稱、支援信箱及開發者聯絡方式。不要冒充 Google 或 OpenAI 官方服務。
3. 個人測試可使用 External／Testing，在 Audience 的 test users 加入自己將用於 Colab 的 Google 帳號。組織帳號可能另受管理員政策限制。
4. Data Access 加入以下三個 scopes；其他額外 scope 不在此實作支援範圍：

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/colaboratory
```

5. Clients 建立 **Web application**，Authorized redirect URIs 填入 configure 腳本印出的完整地址：

```text
https://YOUR-SITE.chatgpt.site/oauth/google/callback
```

6. 將 client ID 與 secret 填入自己的 Site Settings。OAuth 是伺服器端 flow，不需把 client secret 放進 JavaScript，也不要下載憑證 JSON 到 Git。
7. 私人 Site 發布後，透過 Site 的授權連結登入 Google。核對 app 名稱、帳號與 scopes；若出現不符預期的要求，停止並查核設定。

Google Cloud 專案與 Colab 個人帳號額度是不同事物。不要把 Colab Enterprise／Vertex AI 計費設定誤當成本模板的必要步驟，也不要為了通過設定而自行開啟付費服務。

## Testing 與過期

External 且為 Testing 的專案，授權不僅限於基本登入 scopes 時，refresh token 通常在七天後過期；本專案要求 `colaboratory`，不能假設享有基本登入的例外。過期後從自己的 Site 重新授權。撤銷授權、帳號政策或其他 Google 條件也可能使 token 提早失效。[Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

## 限制與審核

每人使用自己的 client，代表各自管理 OAuth 設定；不代表一律免審或取得 Colab 第三方整合許可。需要哪些 branding、scope 驗證及可能的安全審查，取決於當前 Google Console 分類、使用人數、發布狀態與使用情境。不要把某次 scope 被列為 non-sensitive 外推為永久保證。

要提供給其他人使用或改為 production，先依 Google 的規範處理品牌、隱私政策、網域所有權與 scope 審核。共用的 `chatgpt.site` 網域可能涉及無法自行驗證網域的限制；不要宣稱所有人都能無障礙通過 production verification。[Google OAuth production policy](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)

本整合使用 Colab 未版本化 `/tun/m/*` 等端點，沒有可依賴的公開第三方 API 穩定性承諾。Google 官方擴充套件的 [API v2 說明](https://github.com/googlecolab/colab-vscode/blob/main/src/colab/client/v2/README.md) 也應在版本更新時重新查核。

Colab 條款包含對未經授權存取、提供第三方直接或間接存取等限制；**程式可運作或 OAuth 授權成功，不等於此整合已獲 Google 核准**。此 repo 不提供合規認證，也不鼓勵共用帳號或繞過存取限制。部署前自行確認使用情境符合 [Colab 條款](https://research.google.com/colaboratory/tos_v6.html) 與 [FAQ](https://research.google.com/colaboratory/faq.html)。

## 常見問題

| 現象 | 查核方向 |
| --- | --- |
| `redirect_uri_mismatch` | client 類型、完整 HTTPS origin、callback 路徑與部署設定必須一致 |
| `access_denied` | test users 是否包含登入帳號、Google Workspace 管理員限制 |
| `invalid_grant` | 測試模式 token 過期、已撤銷授權、client 不匹配；重新授權前先查核 |
| `private_deployment_not_confirmed` | 先查核 Site audience，再設 private confirmation；不能以此取代真正的存取限制 |
| 加密 token 無法解密 | 是否更換 TOKEN_ENCRYPTION_KEY；保留資料並重新授權，不把 token 印出來除錯 |

請勿在 issue、log、截圖或 agent 對話中提供 authorization code、access token、refresh token、client secret 或加密金鑰。

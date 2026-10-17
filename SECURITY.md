# 安全與資料處理

這是單 owner 私人部署。Sites 控制存取，後端另外把資料綁定到該 Site 的 owner。開放給多個人或公開網際網路不是此版本支援的部署方式。

資料流與保存位置：

- Google client secret 與加密金鑰：自己的 Site secrets。
- Google refresh token：以 AES-GCM 加密後放入自己的 D1；access token 由後端交換，不交給 notebook 或 UI。
- Notebook 程式、執行紀錄、輸出與操作來源：自己的 D1。成品依保存政策放自己的 R2。
- 程式與匯入的檔案：送到自己的 Colab runtime。ChatGPT／Codex 透過工具取得的輸出也會進入對話上下文。

「不共用作者後端」不代表資料不經過 Google 或 OpenAI。含個資、機密或無權上傳的資料，請先去識別、縮小範圍並確認授權。不要把 `.env`、私鑰或 OAuth 憑證當資料傳到 runtime。

UI 的 `user`／`assistant` 是操作路徑標記，不是不可偽造的稽核證明，也不是權限判斷。所有操作仍必須通過相同 owner 限制。舊版本錯標的歷史紀錄不會自動改寫。

回報一般問題可使用 GitHub Issues，只提供已清理的重現步驟。涉及秘密或可利用漏洞時，優先使用 GitHub 的私人 vulnerability reporting（若 repo 已啟用）；沒有私人通道時先請維護者提供通道，不公開憑證或未修補的利用細節。

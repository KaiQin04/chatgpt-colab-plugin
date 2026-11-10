# 配置等待期限

配置 GET／POST 原本各有 8 秒限制，現在共用 7,200,000 ms（兩小時）總預算；POST 使用 GET 後剩餘時間，不累加成四小時。Open service 預留額外 60 秒給 OAuth、驗證、kernel 與 ledger；Site／MCP Apps client 再預留 30 秒。其他操作仍有原本的短期限。

這是持續連線的等待，不是背景配置佇列。外部 MCP host、反向代理、Google、使用者取消或網路中斷仍可能更早結束請求，不能保證平台維持兩小時連線。唯讀 provider queries、DB 與 cleanup 保留獨立短期限。明確拒絕（例如 412）立即回報，不以等待掩蓋。

長時間等待後，後續 verification／cleanup 會使用既有 refresh grant 更新逾 30 分鐘的 access token；不改 scope、授權或密鑰，不因 401 重送 allocation。

若配置 POST 在取得 runtime endpoint 前回傳 HTTP 503，該 Notebook 的開機嘗試會結束，狀態回到 closed。如需重新開機，請使用新的 idempotencyKey；若使用相同 key，則會讀回原本的結果。這類失敗紀錄會與已開機及未確認的 runtime 分開計數，並保留診斷資料。結束開機嘗試不代表 Google 已確認釋放 runtime。

其他回應結果不明時，可用 get_notebook 或 get_compute_status 查看原 notebook。以相同的 notebookId、compute 與 idempotencyKey 重試，會讀回既有配置；改用新的 notebookId 與 idempotencyKey，則會獨立配置另一本 notebook，即使原配置狀態為 unknown 也不受影響。原紀錄會持續反映已觀察到的狀態，不會因開啟新機或等待兩小時而自動標記為已釋放。既有的讀取與 maintenance 作業本身不會提交新的配置 POST。

測試使用虛擬計時驗證兩小時邊界、取消、不重送與長等待後 token 更新；不是兩小時實際 HTTP 或實體 G4/H100 配置證明。

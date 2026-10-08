直播推送「逐部裝置發送明細」官網 endpoint（2026-10-08）
=======================================================

【做咗咩】
官網加咗條新 endpoint：POST /api/wms/live-push/deliveries {secret, id}
→ 回嗰場推送「逐部裝置」嘅發送明細：會員名＋裝置型號＋成功/失敗＋失敗原因＋時間。
WMS 官網中心嘅「成功 X／失敗 Y」撳落去就係靠佢。

【安全】
照舊鐵律：endpoint／keys 永遠唔回唔落 log；淨係經 subscriptionId 對位回裝置資料。

【檔案清單】（Desktop 應該見到 2 個檔案改動）
- api/wmsLivePush.ts（加 wmsLivePushDeliveries handler）
- api/boot.ts（註冊條新 route）

【部署次序】
⚠️ 官網要先部署好呢包，WMS 個彈窗先攞到數據；
WMS 早過官網部署嘅話，彈窗會暫時顯示「載入失敗」——唔影響其他功能，官網部署完就正常。

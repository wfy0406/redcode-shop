RedCode 網店 v2.2.26 更新說明
==============================

今次改咗咩？
------------
【直播黑屏根治：首頁＋直播頁一入嚟即播】

老闆實測回報：
- Android：首頁直播按唔到，無反應
- iPhone：一撳就黑屏，得「放大睇」全屏先睇到

根因（查咗 Meta 官方文件＋社羣實測）：
- FB 官方寫明：嵌入式播放器嘅 autoplay「唔適用於流動裝置」
- 手機瀏覽器（Chrome/Safari）政策：有聲嘅影片唔准自動播，
  一定要「靜音」先准自動播
- 我哋之前條 embed URL 得 autoplay=1 冇靜音 → FB 播放器喺手機
  卡入黑屏狀態（個掣顯示暫停，但畫面黑）
- 「放大睇」正常，係因為撳掣嗰下係用戶手勢，瀏覽器先放行

修復：
1. 直播 embed URL 加埋 muted=1（video.php 認呢個參數）
   → 首頁／直播頁一入嚟，直播畫面靜音自動播，唔再黑屏
2. 客人想聽聲：撳播放器入面嘅喇叭制開聲
   （播放器底下加咗提示：「靜音自動播放中——撳播放器個喇叭制開聲 🔊」）
3. 「放大睇」全屏播放器照舊有聲版（撳掣手勢，FB 准有聲播）
4. 直播重溫（回顧）無郁過：照舊撳 ▶ 先載入，一播有聲

點樣驗證（部署後）？
--------------------
1. 開直播期間，Android 電話入 redcode.red 首頁
   → 直播區應該自動出畫面（靜音），唔使撳，唔再黑
2. iPhone  Safari 入首頁 → 同樣自動播
3. 撳播放器喇叭制 → 有聲
4. 撳「放大睇」→ 全屏照舊睇到（有聲）
5. 直播頁（/live）頂部直播區 → 一樣自動播
6. 直播重溫撳 ▶ → 照舊即播有聲

備註：iPhone 慳電模式（Low Power Mode）下 Safari 會全面停 autoplay，
嗰種情況會顯示 FB 播放器嘅播放掣，撳一下就播——呢個係 Apple 限制，
所有網站都一樣。

技術備註
--------
- 改動檔案：
  api/fbVideo.ts（embedForId 加 muted 選項）
  api/pushRouter.ts（currentLive 加回 embedUrlMuted 欄位）
  src/components/push/LiveNowSection.tsx（原位播放器用靜音版＋開聲提示）
- 無資料庫 migration
- 部署方法一樣：成個 repo 上 Render，Docker build

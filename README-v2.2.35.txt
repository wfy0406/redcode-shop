RedCode Shop v2.2.35（2026-10-02）
==================================
承接 v2.2.34（真 alpha 影片版），今版修四樣老闆實測睇到嘅嘢：

1.「直播回顧我圈住果到有暗影」
   → 嗰浸暗影係我哋舊設計嘅「右邊緣淡出」（一條 56px 深色漸變，
     原意提示仲有下一張）。老闆話似污糟嘢——已整塊拆走，
     依家最尾嗰張卡自然裁邊，乾乾淨淨。
   改：src/components/push/LiveHistorySection.tsx（刪淡出 div＋更新註解）

2.「一直跳一直有個白影」＋「張相有4個白邊」
   → 白影真身：AI 原片入面，Glo Glo 跳嗰陣頭側會飄出一舊白色
     「蝴蝶結」嘢（企定嗰陣冇，一跳就有，重會變形），加埋頭髮邊
     嘅白色碎邊。佢唔係背景——背景一直係深紫，係原片自帶嘅瑕疵。
   → 修法令逐幀執過 210 帧：
     a. 大舊白：色彩特徵鎖定（中性白、近頭髮、大組件）→ 靠頭髮嘅
        用附近髮色無縫補返，伸出嚟嘅直接透明
     b. 中碎屑＋浮游微尘：alpha 歸零＋羽化
     c. 頭髮邊白色碎邊：defringe——淨淡出嗰啲像素，唔掂衫唔掂面
        （試過一版會誤傷衛衣，已經推倒重嚟，最終版衛衣原色完好）
   → 三個檔全部重出：
     public/home/glo-heart-alpha.webm  313KB（24fps，alpha 平面已驗）
     public/home/glo-heart-anim.webp   303KB（iOS 動畫版）
     public/home/glo-heart-poster.webp  24KB（兜底 poster）

3.「左邊隻手圈住中間有團白影」＋「中間團煙霧係應該變翻真正透明底」
   → 白影真身：摳圖引擎（RVM）喺 Glo Glo 叉腰嗰個罅隙位生成咗團
     灰色「煙霧」RGB 垃圾，重實心填死咗——其實嗰個三角形罅隙
     （手臂同腰之間）本來就係背景，應該透到底。
   → 修法令 303 帧逐幀執：
     a. desmoke：煙霧位用返原片真實顏色蓋返
     b. 罅隙偵測：揾出「俾人像包住、色同背景一樣、夠大夠實」嘅區域
        （裙褶紋雖然深色但太幼太長，全部成功避開）→ alpha 歸零＋羽化
   → 依家嗰個罅隙係真・透明——後面咩底色就透出咩色。
   → 三個檔全部重出：
     public/home/glo-poke-alpha.webm  275KB（24fps，alpha 平面已驗）
     public/home/glo-poke-anim.webp   359KB（iOS 動畫版）
     public/home/glo-poke-poster.webp 6KB（兜底 poster）

4.「左邊個人仔上面飄浮既 logo 應該低翻 d／郁動跟手指、頻率一樣」
   ＋「個 logo 整靚 d 生動 d」（主頁關於 Glo Glo 區嗰個）
   → 三樣全做：
     a. 低翻 d：logo 由 -top-[6%] 落去 top-[2%]，貼近指尖
     b. 頻率一樣：實測手指篤嘅週期 ≈19 幀@30fps ≈ 0.63s，
        logo 彈跳動畫由 2.8s 改 0.63s，動作改成「俾篤中」：
        快陷落 → 回彈 → 定返（齋 transform，GPU，唔會 lag）
     c. 靚 d 生動 d：白字靜態 logo 換走，改用霓虹動態 logo
        （真 alpha 影片，Safari 自動落動畫 WebP，再兜底透明 poster）
        ——舊嘅 /home/redcode-logo.webp 已刪
   改：src/pages/Home.tsx、src/index.css、src/components/GloCutout.tsx
      （加 posterW/posterH 兩個 optional props，舊用法唔受影響）

5.「小 glo glo 精靈飛左飛右跟住跳舞轉圈圈，但唔好遮到 RedCode logo」
   ＋「記得係循環影片，背景要透明係好重要」
   → OpenArt PixVerse V6（112cr x 2 次）圖生影片：
     第一次精靈成日飛埋嚟冚住 logo → 第二次加首尾同幀（循環用）
     ＋空間約束，但 AI 始終有幾秒會飛過 logo 前面。
   → 最終保證靠本地合成管線（确定性）：
     a. RVM 逐幀摳精靈（193 幀）
     b. 霓虹 logo 用乾淨幀中位數做「永遠喺最頂」嘅底板
        （底板齋 logo——精靈殘影已硬切走，靜態灰塊 artifact 清零）
     c. 合成順序：精靈喺後、logo 喺前 → 佢點飛都物理上遮唔到字，
        飛過 logo 位嗰陣就好似飛去招牌後面咁，自然又合格
     d. 循環：OpenArt 首尾同幀约束，實測尾幀 vs 首幀 MSE 11.3，
        loop 接駁位近乎無縫
   → 三個檔（About 區專用；頂欄 logo 維持原裝）：
     public/logo-fairy-alpha.webm  334KB（24fps，512x256，alpha 已驗）
     public/logo-fairy-anim.webp   516KB（iOS 動畫版，8fps）
     public/logo-fairy-poster.webp 22KB（兜底 poster）

驗證（老闆規矩：有檢查先交付）：
- tsc --noEmit 通過；npm run build 通過
- 新 webm 強制解碼：alpha 平面存在（74% 透明像素）
- 最終 webm 解碼 168 帧抽 8 帧跳躍位：頭側乾淨，無白影無白邊
- Playwright 實頁 390 手機：關於區 8 連拍，右 cutout 跳跳下全部乾淨；
  canvas probe 讀回 12,700+ 真透明像素
- 左 cutout 腋下罅隙 canvas probe：11,481 個真透明像素（真・透底）
- poke 新 webm 強制解碼＋品紅底合成：罅隙透出品紅＝真透明
- 霓虹 logo：0.63s 動畫已上（getComputedStyle 實測），影片播放中，
  位置貼近指尖
- 直播回顧 mock 數據實頁截圖：右邊緣無暗影，卡片自然裁邊
- 最新 build 嘅 Live-*.js bundle：舊暗影漸變字串 0 次出現
- 精靈 logo：品紅底＋頁底色雙合成檢查（logo 全幀清晰、精靈喺後面）、
  解碼 193 幀 alpha 齊、循環接駁 MSE 11.3、Playwright 實頁 10 連拍
  精靈唔同位/轉圈、canvas probe 85,029 真透明像素（65%）
- 無 404、無新增請求失敗
- 唔准郁清單全部原封：BillPage、sw.js、api/livePush.ts、pushClient.ts、
  live-go*.html、package.json、LivePushEntry 三態、BillPage 免責聲明
- render.yaml 維持對返 live（DB basic-256mb、disk 10GB）

v2.2.34 既有內容全部保留（四項真 alpha 修正、白線修正、三張動態卡、
boba 片、render.yaml 對配），詳情見上一版 README。
OpenArt 餘額 3251 credits（今輪用咗 224cr：PixVerse V6 圖生影片 x2；
其餘修正全本地逐幀執，冇用 credits）。

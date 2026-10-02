====================================================
redcode-shop v2.2.39 —— 放大播放器按鈕修復 ＋ 縮圖新繞道
====================================================

【今次修兩樣】

一、放大睇片「粒制跑咗位」（底部按鈕壓扁、字逐隻直排）
  原因：嗰行按鈕用 absolute＋left-1/2 置中，呢款寫法瀏覽器淨係俾佢
  半個屏幕闊——「重新載入」＋「去 Facebook 睇」兩粒掣加埋超過半屏，
  就俾壓到逐隻字換行。已修復：拎返真身闊度，兩粒掣唔會再被壓。
  （檔：src/components/push/FbPlayerOverlay.tsx）

二、直播縮圖新繞道——全程唔掂 Facebook，佢封唔到
  舊五條摷圖路線全部直連 FB，FB 一封我哋 server IP 就全軍覆沒。
  而家加咗第六條路線，排第一：
    摷圖地址：經 microlink（第三方代摷，佢哋 server 問 FB 攞）
    落圖 bytes：直落唔到就經 weserv（第三方圖片 proxy 代載）
  成條鏈我哋 server 可以完全唔掂 facebook.com／fbcdn.net，
  FB 點封都照有圖。我實測過：今日（10.02）同舊場都摷到真縮圖。
  配合 v2.2.38 嘅 persistent disk——摷到一次就永久有。
  （檔：api/fbVideo.ts、api/boot.ts）

【今次郁咗邊啲檔】（三個，其他一個字冇郁）
  api/boot.ts                        （含 v2.2.38 disk 保存 ＋ v2.2.39 weserv 代載）
  api/fbVideo.ts                     （加 microlink 第一路線）
  src/components/push/FbPlayerOverlay.tsx  （底部掣行修復）
冇 DB 改動，冇新環境變數。未上 v2.2.38 都唔緊要——呢份 boot.ts 已包埋。

【部署方法（同平時一樣，你自己 push）】
  1. 解壓，三個檔照路徑冚過 repo
  2. git add / commit / push 去 master
  3. Render 自己 build 同 deploy

【部署後點驗收】
  1. 撳任何一場回顧嘅 ▶ 放大睇：底部「重新載入」「去 Facebook 睇」
     應該兩粒橫排、字唔再直排
  2. 去「直播回顧」：縮圖應該陸續出返——每張第一次載入要等幾秒
     （server 即場代摷），出過一次之後就永久有，再 deploy 都唔會無
  3. 如果個別場仲係 poster：嗰條片 FB 冇對外公開縮圖（或者已刪片），
     唔係 bug；等 FB 對我哋 server 解封嗰陣，舊路線會自動補摷一次補返

====================================================

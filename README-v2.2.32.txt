RedCode 官網 v2.2.32 更新內容（2026-10-01）
==========================================

今次四件事：6 條動態片全部齊、兩張動態相對調、iPhone 直播改用 live-go 跳板、
開播通知 modal 排版修復。


【1】動態影片 6/6 全部就位
--------------------------
用 OpenArt Kling 3.0（image-to-video，張相本身係第一格，人樣保證一樣）。
最後 2 條（花裙、眼鏡揮手）由老闆喺 OpenArt 網頁親自出（pro 畫質），
我收到之後做齊三道手續：靜音（老闆嗰版唔小心有聲）、「來回播放」無縫循環
（片尾＝片頭＝原相，重播唔會跳格）、壓縮落手機友善 size。
6 條而家全部喺倉入面：
  /boss-glo.mp4      810 KB（兩個人齊揮手，720 闊）
  /about/host-1.mp4  393 KB（眼鏡揮手——見【2】對調）
  /about/host-2.mp4  374 KB（珍珠奶茶揮手）
  /about/host-3.mp4  220 KB（工作枱指mon再揮手）
  /home/card-hug.mp4 368 KB（抱抱＋揮手）
  /home/card-dress.mp4 468 KB（花裙轉圈——見【2】對調）
全部 h264、24fps、10 秒來回循環、無聲、faststart（一開即播）。


【2】兩張動態相對調（老闆指令）
--------------------------------
  · 關於我們主播專區嘅「花裙轉圈」→ 搬去首頁左下「live ♡」浮卡
    （新檔 /home/card-dress.jpg+.mp4，432×576 遷就浮卡位）
  · 首頁左下嘅「眼鏡揮手」→ 搬去關於我們主播專區第一格
    （照用 /about/host-1.jpg+.mp4，528×704 同隔籬兩張齊）
首頁右下「tonight's pick」（抱住今晚嘅衫）唔郁。
舊檔 /home/card-wave.* 已刪，冇地方再引用。


【3】iPhone 直播：唔站內播，live-go 跳板去 Facebook（老闆指令）
----------------------------------------------------------------
直播進行中嗰區，iPhone／iPad 一撳海報而家直接行 /live-go-v6.html 跳板
（同推播通知同一條成功路線）：
  · 4 秒自動去 Facebook 網頁版嗰條直播（保證落到條片，唔會落 FB 首頁）
  · 想用 Facebook App 自己撳金色掣「用 Facebook App 睇直播」
  · 海報底部提示字都改咗：「一撳去 Facebook 睇直播」
淨係直播咁改；直播重溫維持官網內全屏播放器（老闆之前拍板），完全冇郁。
Samsung 行為照舊（本來已經係跳 FB）；桌面／Android Chrome 照舊站內播。


【4】開播通知 modal 排版修復（老闆實測「按左入去個位跑晒」）
------------------------------------------------------------
問題：首頁「接收直播開播通知」個 modal 掛咗喺 hero 入場動畫嘅 div 入面，
嗰個 div 行緊 transform 動畫——瀏覽器規矩：有 transform 嘅祖先會令
position:fixed 唔再以熒幕做定位基準，成個 modal 縮埋做一條窄柱
（Samsung 見到跑晒位、iPhone 要放大先睇到）。
修復：modal 改用 createPortal 直掛 <body>（PushPermissionGuide.tsx），
無論喺邊度開都一定全屏黑底置中。純排版修正——訂閱流程、三態邏輯、
sw.js、pushClient 全部冇郁。


部署方法同之前一樣：成個 zip 上 Render 全倉部署。
今次無郁：BillPage、sw.js、api/livePush.ts、src/lib/pushClient.ts、
live-go*.html、package.json、LivePushEntry 三態邏輯。

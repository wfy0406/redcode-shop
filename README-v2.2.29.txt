RedCode 網店 v2.2.29 更新說明
==============================

包含 v2.2.28 全部內容（GPS 雷達 icon＋會員中心站點摘要修正＋直播 poster 縮圖兜底），再加：

【直播／回顧縮圖摷圖路線大擴充】
--------------------------------
老闆回報：「直播回顧又無晒縮圖，本身之前都有的」
根因：縮圖係伺服器即場向 Facebook 摷嘅，FB 對 data center IP 時好時壞；
每次部署重開 memory cache 清晒要重新摷，啱啱撞正 FB 封緊就全部摷唔到。
修正（api/fbVideo.ts）：
- 摷圖路線由 3 條擴到 5 條，逐條試，一條中即用：
  ① FB 官方 oEmbed（原有）
  ② noembed 第三方 oEmbed 代摷（新加，免 key，FB 封 IP 時多條生路）
  ③ video.php 播放器 HTML og:image（原有）
  ④ m.facebook 行動版 watch 頁——改用電話 UA（原本用桌面 UA，
     FB 對桌面 UA 嘅 server IP 封得特別盡，扮 iPhone 先肯回真頁）
  ⑤ www.facebook.com 桌面 watch 頁（新加兜底）
- 邊條路線摷中會喺後台預覽診斷度見到（ok_oembed／ok_noembed／ok_html／ok_mwatch／ok_watch）

【縮圖 URL 過期自愈】
---------------------
FB 嘅 scontent 圖 URL 有時效，cache 咗嘅 URL 可能已過期 → 代載 bytes 404。
而家代載失敗會即場丟 cache 重摷一次再試（api/boot.ts），
唔使等 6 個鐘 TTL 先自動恢復。

【老闆要做嘅嘢】
----------------
- 照舊成個 zip 上 Render 部署就得。
- 部署後頭 15 分鐘內如果仲有個別場次冇縮圖，係 FB 未解封，
  之後會自動好返；後台「直播推送」逐場預覽可以睇到而家摷唔摷到。
- 長遠最穩陣：後台直播推送度手動上載縮圖（之前整咗嘅功能），
  手動上載過嘅場次永遠唔受 FB 封 IP 影響。

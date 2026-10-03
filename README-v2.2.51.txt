RedCode Shop v2.2.51 — 主畫面 App 圖示重新設計
================================================================

你話「加入咗主畫面個 app logo 走晒樣」——原因係 iPhone 一直攞
/logo.png（1242×698 橫幅白底 logo）硬塞做正方形圖示，所以又細又白、
完全唔襯你個 brand。

今次用你真正嘅霓虹 RedCode 草寫 logo（logo-crisp.webp 原檔，冇用 AI 重畫，
保證隻字 100% 正）本地精修合成：

- 深紫黑奢華底（由 #0A0614 到紫心漸變，同網站主色一致）
- 粉紅霓虹光暈雙層（外圈柔光＋貼身熱光），logo 放到 78% 大
- 六粒四芒星閃閃（金＋粉，低調）
- 全部實色底（iOS 唔再自己亂墊白）

■ 檔案（7 + README）
index.html                          apple-touch-icon 改指 /apple-touch-icon.png
public/apple-touch-icon.png         新（180×180，iPhone 主畫面專用）
public/pwa-icon-192.png             重製（Android「any」）
public/pwa-icon-512.png             重製（Android「any」）
public/pwa-icon-maskable-192.png    重製（maskable，logo 縮到安全區）
public/pwa-icon-maskable-512.png    重製（maskable）
public/push-icon.png                重製（推送圖示跟返新設計）

manifest.webmanifest 唔使郁（路徑冇變）。favicon 照舊用 logo.png。

■ 緊要：點先睇到新圖示
iPhone 會 cache 舊圖示——要「刪除主畫面嗰個 RedCode app」，
再用 Safari 開 redcode.red → 分享 →「加至主畫面」先會見到新 icon。
Android 一樣：移除後重新安裝/加入。

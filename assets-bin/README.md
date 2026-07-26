# assets-bin — 二進制素材（直接經 GitHub 網頁上傳）

呢個資料夾放二進制檔案（影片、大型圖片），build 時 `scripts/decode-assets.mjs` 會直接 copy 去 `public/`。

## 應有嘅檔案

| 檔名 | 內容 |
|---|---|
| promo-1.mp4 | 公司宣傳影片 · 品牌篇（橫，H.264） |
| promo-2.mp4 | 公司宣傳影片 · 台灣掃貨團（直，H.264） |
| promo-1-poster.jpg | 品牌篇封面 |
| promo-2-poster.jpg | 台灣篇封面 |

## 上傳方法

GitHub repo 頁面 → 撳入 `assets-bin` 資料夾 → 右上 **Add file → Upload files** → 將 4 個檔案拖入去 → **Commit changes**。
（注意：呢度唔好放超過 25MB 嘅檔案，大檔要轉用 assets-b64 或壓縮）

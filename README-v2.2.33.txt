RedCode 官網 v2.2.33 更新內容（2026-10-02）

一、Glo Glo 樣貌終於似晒（新出片流程）
- 老闆指示新流程：先用 AI 圖片批量生成（5 張真人參考相鎖樣，身份提示詞
  唔准美化/瘦面/西化），確認樣貌 100% 似先至用 OpenArt（Kling 3.0）做圖轉片。
- 三張主頁「會郁嘅相」全部換新樣：攝影棚閃光燈（閃燈逐下爆）、張開手想攬、
  珍珠奶茶（關於頁）；樣貌同真人一致。

二、全網左上角動態 logo（官網左上，手機電腦都上線）
- 小 Gloria 店主（小精靈）推 logo → 推唔郁 → 雙手開心一齊揮手 → 循環播。
- 哈利波特式「會郁嘅相」：logo 飄揚擺動＋霓虹微光＋掃光＋星閃＋金粉，
  華麗得嚟 logo 本尊唔變形（AI 只郁小 Gloria，logo 原圖疊加，唔會再「一團野」）。
- 老闆指令跟足：logo 透底、「FASHION DESIGN」用返白字（之前變咗深色版，
  已修正——連主頁關於區嗰個 logo 都一併換咗白字透底版）。
- 頂欄可以郁嘅範圍得 logo 位，其餘導航、按鈕全部無郁。

三、主頁「關於 Glo Glo 同 RedCode」大改（老闆話之前醜，重新構思）
- 左右兩個透底 Glo Glo 真人企位：左邊伸手指篤住 RedCode logo（logo 喺指尖位輕彈）、
  右邊比心單腳跳——而家係真・會郁：兩條都係 Kling 生成嘅循環影片
  （佢會輕輕搖、會開心跳，頭髮裙擺都郁），再加 CSS 微動畫（齋 transform/opacity）。
- 白邊清除：兩個 cutout 重做去背（色彩去污＋邊緣收緊），深色底上再無白暈。
- 版面靚化：後景巨型花體「Glo Glo」水印做層次、故事文字置中、
  三張即影即有（攝影棚／攬攬／珍珠奶茶）以唔同角度散貼，hover 會執平浮起。
- 技術備註：cutout 影片用「假透底」——出片時已將畫面 blend 落頁面底色
  （--space-1 #0A0614）＋淡粉／淡紫光晕，任何瀏覽器（包括舊 WebView）都
  唔會出黑磚，仲慳 GPU。底色日後如果改要重焗影片（見 GloCutout.tsx 註解）。

四、新檔案／改動檔案
- public/logo-live.mp4（270KB）＋ logo-live.webp（32KB）：頂欄動態 logo（白字版）
- public/home/glo-poke-loop.mp4（197KB）＋ glo-poke-poster.webp（27KB）
- public/home/glo-heart-loop.mp4（245KB）＋ glo-heart-poster.webp（27KB）
- public/home/redcode-logo.webp（57KB，白字 FASHION DESIGN 透底版）
- public/home/card-studio.mp4/.jpg、card-openarms.mp4/.jpg、about/host-boba.mp4/.jpg（新樣）
- src/components/AnimatedLogo.tsx（新）：頂欄動態 logo 組件
- src/components/GloCutout.tsx（新）：會郁透底 cutout 組件（影片 404／reduced-motion
  自動退回靜態 webp；入 viewport 先載影片，慳數據）
- src/components/Navbar.tsx：左邊 logo 位換 AnimatedLogo，右邊按鈕全部無郁
- src/pages/Home.tsx：關於區新版面；src/index.css：glo-sway / glo-hop /
  spark-twinkle 動畫（齋 transform/opacity，reduced-motion 自動停）
- 刪除：舊 glo-poke.webp、glo-heart.webp（已由 poster＋影片取代）、
  未引用嘅 about-texture.jpg

五、唔准郁清單（跟足鐵律，全部無郁）
BillPage（永遠 public、免責聲明一字無改）、sw.js、api/livePush.ts、
src/lib/pushClient.ts、live-go*.html、package.json、LivePushEntry 三態邏輯、
價錢邏輯（整數港元，無乘除 100）、中文無 italic、動畫齋 transform/opacity。

六、AI 生成成本（OpenArt）
- 用呢輪：2 條 Kling 圖轉片 × 175 = 350 credits（老闆充值後餘額 3650）。
- 圖片批量生成（image_generation）7 張全部通過樣貌檢查，無額外收費。

七、驗證（全部通過先交付）
- tsc 無錯、build 成功。
- 三個寬度（1440／390／360）Playwright 檢查：兩條 cutout 影片＋頂欄 logo 影片
  全部播放中、無水平溢出、無 404、cutout 無白邊無黑磚（逐像素檢查）、
  logo「FASHION DESIGN」白字。

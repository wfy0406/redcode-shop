RedCode Shop v2.2.34（2026-10-02，第二次打包：白線修正版）
==================================
老闆指令逐條覆：
0.「點解 logo 會出現一條白線？」→ 病根：舊 logo 摳圖用亮度 alpha 反預乘
   （fg = rgb ÷ alpha），霓虹光暈邊緣 alpha 得 0.001–0.1 嘅微塵像素會被放大
   幾百至一千倍，微弱反光＋噪點變成「FASHION DESIGN」下面一條淡白線。
   修正：放大上限封頂 1÷0.35 ≈ 2.86 倍（微光保持微光，忠於原片）、
   alpha < 8/255 全部歸零、透明區 RGB 清零（防編碼器漏色）。
   三個 logo 檔全部重出（alpha 平面重新逐幀驗證），頁面 live 截圖放大 4 倍：
   標語以下 0 個近白像素，白線已絕跡。
1.「點解個 logo 係深色背景？」→ 你電話（Android／FB WebView）唔支持 mix-blend-screen
   疊影片，黑底現形。今版頂欄 logo 改真 alpha 影片，唔再靠 blend。
2.「右邊跳緊果個有白邊」→ 白邊係 AI 影片帧本身殘留。今版用 RVM（Robust Video
   Matting）逐幀重新摳人，邊緣收緊 1px＋羽化，白邊清走（已喺 magenta 底上驗證）。
3.「兩個一跳起身就成塊背景出咗嚟、無透明背景。係咪有技術係透明背景影片？」
   → 有，你睇嘅係真嘅。今版係真・透明背景影片：
   - Chrome／Firefox／Edge／Android（包括你部機）：VP9 alpha WebM
   - Safari（任何版本都唔解 VP9 alpha，會當不透明播 → 黑盒）：頁面內置
     canvas probe（src/lib/alphaVideo.ts），影片一播即抽帧驗 alpha，
     驗到冇就自動轉真 alpha 動畫 WebP（<img> 直出，iOS 14+ 得）
   - 再兜底：透明 webp 靜態 poster
   三層都係真透底——咩底色、點樣郁、水印透出嚟，都唔會再甩。
   （點解 iOS 唔係 HEVC alpha：HEVC alpha 只有 macOS VideoToolbox 先焗到，
     x265 開源版唔支持 alpha；我哋做嘢嘅環境係 Linux，所以 iOS 用動畫 WebP，
     一樣真透底＋會郁。）
4.「主頁手機版中間果 3 張卡張相都唔識郁」→ 關於區三張即影即有全部改用
   MovingPhoto 播循環片：flash!＝card-studio.mp4、big hug＝card-openarms.mp4、
   boba break＝新出嘅 host-boba.mp4（Kling 3.0 圖轉片：飲啖珍珠奶茶再微笑，
   正放倒放無縫循環）。靜態 jpg 照舊做 poster 兜底，reduced-motion 自動停。

技術流程備註：
- cutout alpha：由已交付焗底影片抽帧 → RVM mobilenetv3（onnxruntime）逐幀出
  alpha＋去污染前景色 → 內部強制實心（fill_holes，衫裙皮膚唔准半透明變鬼影）
  → 邊緣收緊羽化 → VP9 yuva420p（crf48、fps24，alpha 平面已逐檔驗證存在）
- logo alpha：RVM 管小 Gloria 身體，霓虹光暈用亮度 alpha 混合（加色發光特性），
  黑底反預乘還原顏色；poster 係透明帧 70（小 Gloria 揮手位）
- iOS 動畫 WebP 係迷你無縫循環（39 帧正倒放），Safari-only 兼 lazy，
  Android／桌面完全唔會載到

新檔案：
  public/logo-live-alpha.webm   164KB（頂欄動態 logo，真 alpha，白線修正版）
  public/logo-live-anim.webp    580KB（iOS 動畫版，240w/10fps，同上修正）
  public/logo-live-poster.webp   32KB（透明靜態 logo＋小 Gloria，同上修正）
  public/home/glo-poke-alpha.webm   284KB（左 cutout 真 alpha）
  public/home/glo-poke-anim.webp    358KB（iOS 動畫版）
  public/home/glo-heart-alpha.webm  318KB（右 cutout 真 alpha）
  public/home/glo-heart-anim.webp   313KB（iOS 動畫版）
  public/about/host-boba.mp4        189KB（boba break 卡循環片）
  src/lib/alphaVideo.ts（新）       canvas alpha probe
刪除：public/logo-live.mp4、public/logo-live.webp、public/home/glo-poke-loop.mp4、
      public/home/glo-heart-loop.mp4、README-v2.2.33.txt
改：GloCutout.tsx（三層真透底）、AnimatedLogo.tsx（同上）、Home.tsx（關於區三卡
   改 MovingPhoto＋cutout 換真 alpha 源）、render.yaml（對返 live 實際：
   disk 10GB、DB basic-256mb——Render 唔俾 blueprint 降配，寫細過 live 會
   sync 失敗 cannot downgrade / cannot decrease）

唔准郁清單全部原封：BillPage、sw.js、api/livePush.ts、src/lib/pushClient.ts、
live-go*.html、package.json、LivePushEntry 三態邏輯、BillPage 免責聲明。
動畫齋 transform/opacity，reduced-motion 自動停。金額邏輯冇掂。

OpenArt：今輪用 175 credits（boba Kling 3.0 一條），餘額 3475。

驗證（老闆規矩：有檢查先交付）：
- tsc --noEmit 通過；npm run build 通過；bundle 含全部新檔名
- 每條 WebM 強制 libvpx 解碼驗證 yuva420p alpha 平面存在（75-80% 透明像素）
- Playwright 桌面 1440＋手機 390：頂欄＋兩 cutout 影片播放中，
  頁內 canvas 讀回每條都有 4000+ 真半透明像素（唔係黑磚），
  poster 播放後收埋，三張卡影片播放中，無水平溢出，無 404
- 白邊檢查：v2 摳圖喺 magenta 底上無白圈無黑邊（截圖存證）
- 白線覆查：新舊 webm 解碼逐幀對比（舊版標語下有淡白拖尾，新版乾淨）；
  vite preview 實頁 1440＋390 截圖放大 4 倍，標語以下 0 個近白像素；
  頁內 canvas probe 讀回 7200+ 真透明像素，alpha 運作正常

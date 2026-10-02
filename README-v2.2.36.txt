RedCode 官網（redcode-shop）v2.2.36
主頁 About 區：清晰 logo ＋ 獨立飛舞小精靈（老闆指令）
=================================================

今次解決咗咩
-------------------------------------------------
問題：About 區個 RedCode logo 一團野（溶溶地），但左上角個 logo 係清嘅。
原因：上一手用 AI 重新畫過個霓虹 logo 再合成落條片度——AI 畫嘅字
      縮到 80–180px 顯示就會溶。

點整好
-------------------------------------------------
拆開兩層，各用各嘅正版素材：
1. logo 層：換返原裝清晰 logo（logo-crisp.webp，由 public/logo.png 出），
   繼續跟主播手指篤住郁（logo-poke 動畫照舊，無郁過）。
2. 小精靈層：由舊合成片用影像處理逐幀摳返出嚟（唔係 AI 重畫），
   精靈＋翼＋閃爍星星全部保留，獨立透明層自己飛舞——
   唔會再跟住 logo-poke 一齊彈（老闆話精靈唔應該跟篤郁）。
3. 精靈放喺 logo 前面飛（老闆話可以），身形放大咗 5%
   （再大翼尖會俾畫框裁到，5% 係唔穿崩嘅上限）。

檔案清單（照路徑擺落 repo）
-------------------------------------------------
public/logo-crisp.webp         正版清晰 logo 靜態層（25 KB）
public/fairy-fly-alpha.webm    精靈獨立透明層 VP9 alpha，24fps（747 KB）
public/fairy-fly-anim.webp     iOS 動畫版（Safari 用，611 KB）
public/fairy-fly-poster.webp   兜底 poster（11 KB）
src/pages/Home.tsx             About 區兩層分離（淨係改咗嗰段，其他無郁）

技術細節（唔使理都得）
-------------------------------------------------
- 透明片照舊三層fallback：VP9 alpha WebM（Chrome/Android）
  → animated WebP（Safari）→ 透明 poster；GloCutout 組件無改過。
- 精靈摳取：時間中位數起底板 → 逐幀增益補償（霓虹呼吸）
  → 大連通體攞精靈核心 → ROI 低門檻救返半透明翼仔 → 保留閃爍星星。
- 循環接駁 MSE 72（相鄰幀平均 672），跳格睇唔出。
- reduced-motion 照舊淨顯示 poster，唔會郁。

點樣上
-------------------------------------------------
1. 將 zip 入面嘅檔案照路徑擺落 redcode-shop repo
2. （可選）舊合成片已經冇嘢引用，可以刪慳 1.5MB：
   git rm public/logo-fairy-alpha.webm public/logo-fairy-anim.webp public/logo-fairy-poster.webp
3. git add -A
4. git commit -m "v2.2.36 About區logo換返清晰正版＋小精靈獨立層唔跟篤"
5. git push → Render 自動 build＋deploy

驗收步驟
-------------------------------------------------
1. 主頁落去 About 區：個 RedCode logo 應該同左上角個一樣清。
2. 主播隻手指篤住 logo 嗰下：logo 會跟住彈，小精靈唔跟——
   精靈自己飛黎飛去、跳舞轉圈，會飛到 logo 前面。
3. 手機 Safari 開一次（用 animated WebP），Chrome 開一次（用 VP9 alpha），
   兩個都應該見到透明底精靈，冇白邊冇黑盒。
4. 精靈比舊版大咗少少，翼同星星齊全，冇粉紅煙霧殘留。

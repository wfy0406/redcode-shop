Red Code 官網 v2.5.4 部署包（2026-10-10）
==========================================
呢個 zip 淨係改動咗嘅檔案，請保持 zip 入面嘅路徑結構，
逐個覆蓋落 repo 對應位置，然後 commit + push 去 master。

檔案清單（共 14 個）
--------------------
api/
  ordersRouter.ts   ← 我的訂單黑屏修復（漏 await）＋訪客單 payload 守衛
  wmsShipment.ts    ← WMS 出貨回調：件級部分取消（remainQty／cancelledQty）
  email.ts          ← 待審批訂單唔再寄去 leader@ows.redcode.red
  boot-migrate.ts   ← 開機自動補 orderItems.cancelledQty 欄
db/
  schema.ts         ← orderItems 加 cancelledQty 欄（NOT NULL DEFAULT 0）
src/
  pages/MyOrders.tsx        ← 黑屏修復＋結果卡防炸保護罩
  pages/Receipt.tsx         ← 收據頁部分取消顯示
  pages/WalletTopup.tsx     ← 充值頁配套
  components/orders/ShipmentInfo.tsx   ← 已寄出單「部分取消 X 件」chip
  components/shop/GuestOrderCard.tsx   ← 訪客單卡部分取消顯示
public/wallet/
  glo-piggy-alpha.webm  glo-piggy-anim.webp
  glo-wallet-alpha.webm glo-wallet-anim.webp   ← 公仔動畫（重影檢查過，乾淨）

逐項驗收
--------
【msg72 我的訂單黑屏（最重要）】
1. 官網「我的訂單」→ 輸入訂單編號＋電話 → 正常出返張單，唔再黑屏。
   （根因：後端漏咗個 await，前端收到空殼資料一 render 就炸；
     而家後端修咗，前端仲加咗雙重保險——空殼當查唔到、
     結果卡炸都會變返張提示卡連 WhatsApp，唔會成頁黑。）

【msg75 件級部分取消】
2. WMS 訂單管理刪貨：
   ‑ 張單得 1 件，刪咗 → 官網轉「已取消」；
   ‑ 張單 2 件或以上，刪 1 件 → 官網轉「部分取消」（寫明取消咗幾多件）；
   ‑ 全部刪晒 → 「已取消」。
3. 客人喺官網「我的訂單」會見到「部分取消 X 件」同埋取消原因；
   庫存淨係加返取消嗰啲件數。

【msg74 待審批電郵】
4. 訂單待審批唔會再寄通知去 leader@ows.redcode.red。

【msg73 公仔重影（查實冇事）】
5. 購物金頁嘅公仔動畫檔已逐格驗證——冇重影冇疊影；
   之前見到嘅重影係舊版快取，部署後強制重新整理（Ctrl+Shift+R）即正常。

部署步驟
--------
1. 解壓 zip，照路徑覆蓋 repo 檔案。
2. git add -A && git commit && push 去 master（唔係 main）。
3. Render 自動部署；開機時會自動補 cancelledQty 欄，唔使人手郁資料庫。
4. 唔使郁 .env。

有問題即管話我知，唔好自己硬改。

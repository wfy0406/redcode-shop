red-code-shop v2.2.55 — 刪中獎單 fix ＋ 獎品件數 ＋ 獎品名單場次分組（2026-10-03）

老闆三單嘢，兩隻 review agent 複查完先交付：

一、「全部訂單到刪除唔到張中獎單」— 搵到根因：
  中獎紀錄表 luckyDraws 有條外鍊指住 orders，舊碼刪單冇處理佢，
  資料庫擋住（你見到嗰句 Failed query 就係佢）。
  而家訂單管理刪單會照你指令「中獎紀錄都要刪除」— 同一個交易入面
  先刪中獎紀錄、再刪截圖/同步紀錄/明細、最後刪單，一氣呵成；
  審計紀錄會寫「中獎紀錄一併刪咗 N 筆」。刪咗紀錄件獎品自然返返入池抽得。
  ★ 注意：官網呢邊刪咗之後，WMS 嗰邊嘅審批單照舊要人手拒絕/刪除
    （兩邊係分開嘅系統，WMS 自己管自己嘅單）。
  ★ 會員管理「連訂單刪會員」同病同藥，順手醫埋，兼包埋落交易
    （唔會再出現「單刪咗但會員刪唔到」嘅半桶水狀態）。

二、「獎品要可以揀有幾件，同一款 4 件就抽 4 次」：
  - 獎品管理加咗「件數」欄（預設 1，舊獎品全部自動當 1 件，唔使郁）
  - 同款 N 件 → 可以抽 N 次，每次一個中獎人；抽晒先離開輪盤
  - 卡片顯示：共N件 / 已抽 X/Y 件仲剩 Z 件 / 已抽晒 X/X 件→最近中獎邊個
  - 剩餘計數全部改計「件」（主區同管理區一致）
  - 防超抽：資料庫層面 advisory lock 鎖住件獎品先數件，
    兩個人同時撳最後一件都唔會穿（舊嘅一獎一單 unique index 已按需要 drop，
    migration 開機自動跑，唔使人手落 SQL）
  - 客人「唔要」/取消中獎/刪紀錄 → 件貨照舊返池（邏輯冇變）

三、「獎品名單要分歷史場次同未抽場次」：
  場次下拉（主抽獎區＋獎品管理兩個都係）分兩組：
  上面係未抽場次；「歷史場次（已抽晒）」墊底標住（已抽晒），
  場次再多都唔會亂。全場 active 獎品抽晒先算歷史；新開空場次當未抽。

安裝：解壓按路徑冚 6 個檔，commit＋push，Render 自動 build；
開機 migration 自動加 quantity 欄＋drop 舊 index。
冇郁禁令檔（sw.js、pushClient.ts、package.json 等）。

檔案：
  db/schema.ts                            ← luckyPrizes 加 quantity 欄
  api/boot-migrate.ts                     ← 自動 migration（加欄＋drop 舊 index）
  api/luckyDrawRouter.ts                  ← 件數制抽獎/防超抽/列表回 takenCount
  api/ordersRouter.ts                     ← 刪單連中獎紀錄（你報嘅 bug 本尊）
  api/membersRouter.ts                    ← 刪會員同病同藥＋交易化
  src/components/admin/LuckyDrawPanel.tsx ← 件數欄/卡片顯示/場次分組/計數

質檢：兩隻獨立 review agent 逐行複查過（後端＋前端），捉出 4 個問題
（刪會員半刪狀態、過時註解、卡片邊框舊邏輯、已抽晒 X/Y 超界顯示），
全部已修；6 個檔 esbuild 語法全綠；冇 secret/endpoint 落 log。

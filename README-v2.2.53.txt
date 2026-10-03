RedCode Shop v2.2.53 — 重抽無反應修復 + 場次持久化
================================================================

1. 「重抽無反應」（你 7:00 截圖嗰單）
   - 原因：抽完最後一件獎之後，「可抽獎品池」係空（中咗嗰件 takenBy 咗），
     前端舊碼 guard 咗「池空就靜靜雞 return」——所以撳重抽完全冇反應。
   - 修：重抽唔再需要池有獎（server 按 drawId 用返舊 draw 嗰件獎）；
     新抽先檢查，冇獎會 toast 講明「呢場冇可抽嘅獎品——去下面加返先」。
   - 補充：你嗰份名單得「tset1」一個名，重抽時池踢走舊中獎人後係空，
     server 會答「冇人抽得（名單空或嗰日全部中過）；舊中獎保留」——
     依家會正常彈呢句出嚟（之前係靜靜雞）。

2. 場次持久化（你話「開咗場次未上傳獎品都要留住，第2個同事可以加嘢入去」）
   - 新表 luckyDrawSessions（名 unique）；開機自動 migrate＋backfill
     舊獎品用緊嘅場次名，唔使人手落 SQL。
   - 「＋ 新場次」撳完即時落庫——就算一件獎品都未上傳，場次都喺下拉度；
     同事開第二個瀏覽器都見到同一批場次，可以接力加獎品入去。
   - 之後加/改獎品時有填場次都會自動補入表；刪晒嗰場獎品場次都唔會消失。
   - 同名唔會炸（onConflictDoNothing），兩個同事前後開同名安全。

■ 檔案（4 + README）
api/luckyDrawRouter.ts                 重抽 guard 無關（前端修）；場次兩個新 endpoint＋upsertPrize 補入表
db/schema.ts                           luckyDrawSessions 新表
api/boot-migrate.ts                    CREATE TABLE + backfill（開機自動跑）
src/components/admin/LuckyDrawPanel.tsx 重抽 guard 修復＋toast 回饋；場次下拉改用持久化表＋即開即存

■ 注意
- 套用順序：…→ 50 → 51 → 52 → 53。
- DB 遷移開機自動跑，唔使人手。

# Red Code 官方購物網站

呢個目錄係 **官網完整原始碼**，包括公開購物網、會員及訪客訂單流程、管理後台、抽獎活動、Excel 匯入、Hono／tRPC API、PostgreSQL schema、PWA 及部署文件；唔係舊版七檔 overlay。

## 主要功能

- 公開商品、會員、訪客付款及查單、WMS 回調同步。
- 手機、平板及桌面介面；保留有意義動態效果，只喺背景分頁、頁面隱藏或 off-screen 時減少無謂工作。
- 名單抽獎及抽獎劵活動：兩種限中規則、重抽、確認中獎、通知、起單及紀錄管理。
- Excel 範本、預覽及提交：限制檔案大小與行數，逐行錯誤全批顯示，有錯唔寫入。
- 權限由後端執行；中獎確認、起單、通知認領及刪除綁單使用交易或原子更新保護。

## 本機開發

```bash
npm ci
npm run dev
```

正式建置及啟動：

```bash
npm run build
npm start
```

環境變數以 `.env.example` 嘅鍵名為準；真 key、connection string、密碼同 `.env` 唔可以落入 Git、ZIP 或報告。

## 檢查

```bash
npm test
npm run check
npm run build
```

測試只應使用 mock 或隔離資料庫，唔准連 production database。

## Migration 與部署

1. 部署前備份現行源碼及資料庫，先喺 staging 核對 schema 同 migration。
2. 確認 `db/migrations/0000_perf_indexes.sql` 已被 Git 收錄；唔好用破壞性 `db:push --force`。
3. 由管理員自行 merge、push、部署及 migration。
4. Production boot 會執行 `ensureDatabase()`，但個別 SQL 失敗可能只落 log；部署後必須檢查 `[boot-migrate] tables ok`，唔可以見到網頁開到就當 migration 成功。
5. 每日 Excel 導出如使用自訂營運範本，管理員要上傳 override；總包冇假稱內建 `api/assets/ops-template.xlsx`。

完整變更、驗收證據、rollback 及未驗證限制，以總包根目錄嘅廣東話報告為準。

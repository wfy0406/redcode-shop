/**
 * WMS → 官網刪單回調（v2.5.5 第7版，2026-10-11 老闆指示）：
 * `POST /api/wms/delete-order`
 *
 * 背景：WMS 官網中心「刪除訂單」以前只回調 item_cancelled（官網轉「已取消」留底），
 * 但老闆要求 WMS 刪咗官網就要真刪——唔可以 WMS 冇咗、官網仲見到張單。
 * WMS 嗰邊會先回調 item_cancelled（取消＋補庫存＋原因留底），成功後再調用呢度硬刪。
 *
 * body: { secret, orderNo, reason?, deletedBy? }（secret 兩邊共用 WMS_CALLBACK_SECRET）
 *
 * 刪除邏輯共用 api/orderDelete.ts 嘅 hardDeleteOrder（同官網後台「永久刪除」同一條路徑，
 * 連截圖／同步紀錄／出貨批次／中獎紀錄／明細一齊刪；庫存規則一致）。
 * 冪等：張單唔存在（已刪過／根本冇）→ 回 { ok:true, already:true }，WMS retry 唔會爆。
 * 每次刪除都寫審計日誌（action: order.delete，detail 記低單號＋件數＋金額＋原因＋邊個刪）。
 */
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders } from "@db/schema";
import { logAudit } from "./audit";
import { hardDeleteOrder } from "./orderDelete";

export async function wmsDeleteOrderCallback(c: Context) {
  const secret = process.env.WMS_CALLBACK_SECRET;
  if (!secret) {
    return c.json({ ok: false, error: "官網未設定 WMS_CALLBACK_SECRET" }, 503);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "body 要係 JSON" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.secret !== secret) {
    return c.json({ ok: false, error: "secret 唔啱" }, 401);
  }
  const orderNo = typeof b.orderNo === "string" ? b.orderNo.trim() : "";
  if (!orderNo) {
    return c.json({ ok: false, error: "需要 orderNo" }, 400);
  }
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  const deletedBy = typeof b.deletedBy === "string" ? b.deletedBy.trim() : "";

  const db = getDb();
  const found = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    columns: { id: true },
  });
  // 冪等：已刪過／根本冇呢張單 → 當成功，WMS 唔使再 retry
  if (!found) {
    console.log(`[wms] delete-order ${orderNo} → already gone`);
    return c.json({ ok: true, already: true });
  }

  const r = await hardDeleteOrder(found.id);
  if (!r) {
    // 理論上唔會（頭先先搵到），真係撞啱同時被刪就當成功
    return c.json({ ok: true, already: true });
  }
  const { order, restoreStock, drawsDeleted } = r;
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: deletedBy ? `WMS（${deletedBy}）` : "WMS",
    action: "order.delete",
    targetType: "order",
    targetId: order.orderNo,
    detail: `WMS 官網中心刪單，官網連帶完整刪除 ${order.orderNo}（${order.items.length} 件貨，合計 HK$${order.total}，狀態 ${order.status}）${restoreStock ? "，庫存已加返" : "，庫存不變"}${drawsDeleted > 0 ? `，中獎紀錄一併刪咗 ${drawsDeleted} 筆` : ""}${deletedBy ? `，刪除人：${deletedBy}` : ""}${reason ? `，原因：${reason}` : ""}`,
  });
  console.log(`[wms] delete-order ${orderNo} → deleted${deletedBy ? ` by ${deletedBy}` : ""}`);
  return c.json({ ok: true });
}

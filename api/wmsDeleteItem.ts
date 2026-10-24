/**
 * WMS → 官網刪單件貨回調（v2.5.5 第11版，2026-10-11 老闆指示）：
 * `POST /api/wms/delete-item`
 *
 * 背景：WMS 官網中心「訂單詳細資料」單項商品刪除，以前只回調 item_cancelled
 * （官網標「已取消」留底），但老闆要求單件刪除都要同整單刪除一樣——
 * WMS 刪咗，官網張單入面嗰件貨就要真刪走，唔可以仲留喺客人嘅訂單明細度。
 *
 * 流程（同整單刪除一個 patterns）：WMS 會先回調 item_cancelled
 * （取消＋補庫存＋原因留底落審計），成功後先調用呢度硬刪件貨。
 * 所以呢度**淨係刪已取消嘅貨**（shipStatus='cancelled'）——未取消就拒絕（409），
 * 唔會靜默跳過；庫存唔郁（取消嗰刻已經補咗，唔好補兩次）。
 *
 * body: { secret, orderNo, orderItemId? | sku?, reason?, deletedBy? }
 * （secret 兩邊共用 WMS_CALLBACK_SECRET；orderItemId 優先，舊單冇就用 sku 對）
 *
 * 冪等：張單唔存在／件貨唔存在（已刪過）→ 回 { ok:true, already:true }，WMS retry 唔會爆。
 * 每次刪除都寫審計日誌（action: order.itemDeleted，記低單號＋貨號＋件數＋金額＋原因＋邊個刪）。
 * orderItems 冇其他表嘅硬 FK 指住（orderShipments.itemIds 係 JSON 快照，唔係 FK），
 * shipmentId 喺取消嗰刻已清 NULL——所以硬刪一行係安全嘅。
 * 訂單總額（orders.total）唔郁：同「取消」行為一致（客實付金額唔變，退款行退款流程）。
 */
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, orderItems } from "@db/schema";
import { logAudit } from "./audit";
import { secretEquals } from "./wmsSecret";

export async function wmsDeleteItemCallback(c: Context) {
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
  if (!secretEquals(b.secret, secret)) {
    return c.json({ ok: false, error: "secret 唔啱" }, 401);
  }
  const orderNo = typeof b.orderNo === "string" ? b.orderNo.trim() : "";
  if (!orderNo) {
    return c.json({ ok: false, error: "需要 orderNo" }, 400);
  }
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 200) : "";
  const deletedBy = typeof b.deletedBy === "string" ? b.deletedBy.trim().slice(0, 64) : "";

  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: { items: true },
  });
  // 冪等：張單已刪過／根本冇 → 當成功，WMS 唔使再 retry
  if (!order) {
    console.log(`[wms] delete-item ${orderNo} → order already gone`);
    return c.json({ ok: true, already: true });
  }

  // 逐件對：orderItemId（正整數）直接用（核實係呢張單嘅貨）；冇就用 sku 對（同 wmsShipment 一個對法：
  // 貨號可以係純 sku 或者 sku-size 全寫）；多件命中優先揀已取消嗰件（呢個 endpoint 本來就係刪已取消貨）
  const n = Number(b.orderItemId);
  let item: (typeof order.items)[number] | undefined;
  if (Number.isInteger(n) && n > 0) {
    item = order.items.find((x) => x.id === n);
    if (!item) {
      // id 唔屬於呢張單 — 可能已刪過（冪等），亦可能 WMS 傳錯；呢度當已刪過處理會掩蓋錯誤，
      // 所以分開：張單仲有貨但冇呢個 id → 明確報錯等 WMS 落【官網回調失敗】提示人手核對
      return c.json({ ok: false, error: `orderItemId ${n} 唔屬於訂單 ${orderNo}（或者已經刪咗）` }, 404);
    }
  } else {
    const sku = typeof b.sku === "string" ? b.sku.trim() : "";
    if (!sku) {
      return c.json({ ok: false, error: "需要 orderItemId 或 sku（最少一樣）" }, 400);
    }
    const cand = order.items.filter((x) => x.sku === sku || (x.size ? `${x.sku}-${x.size}` : x.sku) === sku);
    item = cand.find((x) => x.shipStatus === "cancelled") ?? cand[0];
    if (!item) {
      // 件貨唔喺度 → 已刪過（冪等當成功）
      console.log(`[wms] delete-item ${orderNo} sku:${sku} → item already gone`);
      return c.json({ ok: true, already: true });
    }
  }

  // 安全閘：淨係刪「已取消」嘅貨（WMS 流程係先 item_cancelled 再 delete-item）。
  // 未取消就硬刪會走甩庫存回補同取消原因留底 — 明確拒絕，WMS 會落【官網回調失敗】提水。
  if (item.shipStatus !== "cancelled") {
    return c.json(
      { ok: false, error: `件貨（#${item.id} ${item.sku}）未取消（狀態 ${item.shipStatus}），唔准直接刪——請先取消` },
      409,
    );
  }

  await db.delete(orderItems).where(and(eq(orderItems.id, item.id), eq(orderItems.shipStatus, "cancelled")));

  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: deletedBy ? `WMS（${deletedBy}）` : "WMS",
    action: "order.itemDeleted",
    targetType: "order",
    targetId: order.orderNo,
    detail:
      `WMS 官網中心刪單件貨，官網連帶刪除訂單 ${order.orderNo} 嘅貨品` +
      `「${item.productName}」（${item.sku}${item.size ? `-${item.size}` : ""}，×${item.quantity}，HK$${item.price}）` +
      `${deletedBy ? `，刪除人：${deletedBy}` : ""}${reason ? `，原因：${reason}` : ""}`,
  });
  console.log(`[wms] delete-item ${orderNo} item#${item.id} ${item.sku} → deleted${deletedBy ? ` by ${deletedBy}` : ""}`);
  return c.json({ ok: true, deletedItemId: item.id });
}

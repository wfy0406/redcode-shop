/**
 * WMS → 官網出貨回調（2026-10-09 Wave 2 出貨雙向同步）：`POST /api/wms/shipment-callback`
 * 模式照足 api/wmsRefund.ts（shared secret WMS_CALLBACK_SECRET ＋ JSON ＋ 冪等 ＋ audit）。
 *
 * body: { secret, orderNo, action, items[], shipMethod?, sfNo?, shippedAt?, actorName? }
 *
 * action 總表（契約 v1.2）：
 *   shipped         出貨：shipMethod 'sf'（必填 sfNo）｜'face'｜'pickup'｜'storage'；
 *                   items[].orderItemId 必填。建 orderShipments 批次＋逐件 shipStatus pending→shipped；
 *                   全單未取消貨品寄齊 → 訂單轉 'shipped'＋orders.shippedAt（訂單正常終態）。
 *                   出貨信**唔即寄**——orderSweeper debounce 10 分鐘合併寄一封。
 *   unshipped       取消出貨：逐件 shipped→pending＋清 shipmentId；批次標 reversedAt；
 *                   訂單 shipped→approved＋清 shippedAt。**已寄咗出貨信先寄致歉信**，未寄就靜默反轉。
 *   item_cancelled  WMS 刪貨品：items[].cancelReason 必填（客人睇到）→ 件貨轉 cancelled＋回補庫存；
 *                   全單件數都取消 → 訂單轉 cancelled；寄貨品取消信（退款另案，唔自動退）。
 *   item_updated    WMS 改貨品資料：items[].changes（sku/productName/size/price 擇一或以上）＋
 *                   changeNote 必填（客人睇到）→ 更新快照＋staffChanged* 欄；寄員工更改信。
 *                   v2.3.16（老闆指示）：price＝整數港元，改價錢會重計訂單 total；
 *                   日期／場次官網冇欄，WMS 寫入 changeNote；淨說明更新（冇欄位改）都收得。
 *   sf_updated      WMS 批准改順豐單號：body.sfNo（新）＋oldSfNo?（舊），唔使 items →
 *                   更新最新一個生效中嘅順豐批次（shipMethod='sf' 且 reversedAt IS NULL）嘅 sfNo；
 *                   唔寄 email（WMS 已推播員工），淨落 audit（order.sfUpdated，原→新單號＋經手人）。
 *                   搵唔到生效批次 → 404 明確報錯，WMS 會留痕【官網回調失敗】。
 *
 * 冪等：每件貨都係 conditional update（pending→shipped、shipped→pending、pending→cancelled），
 *   重複推送郁 0 行 → skip 唔會郁兩次；回應入面列明 skipped 畀 WMS 對數。
 * 每次回調都寫審計日誌（actorRole=system，detail 帶 WMS 同事名）；寄信失敗淨係 log 唔 throw。
 *
 * v2.5.4（老闆指示 2026-10-10）：舊單（2026-10-09 前匯入）WMS 嗰邊冇 orderItemId ——
 *   items[] 而家接受 sku（貨號）對照：orderItems.sku 完全相同、或者 "sku-size" 完整寫法都中；
 *   多件命中優先揀符合動作來源狀態嗰件（shipped/item_cancelled 要 pending、unshipped 要 shipped）。
 *   對唔到 → 400 明確報錯（WMS 會留痕【官網回調失敗】），唔再靜默跳過。
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "./queries/connection";
import { orders, orderItems, orderShipments, products } from "@db/schema";
import { logAudit } from "./audit";
import {
  sendOrderShippedEmail,
  sendShipmentRevertedEmail,
  sendOrderItemCancelledEmail,
  sendOrderItemChangedEmail,
  type OrderEmailItem,
} from "./email";

const SHIP_METHODS = new Set(["sf", "face", "pickup", "storage"]);

/** 收信人：會員單用會員 email；訪客單用 guestEmail（冇 email 就唔寄，audit 記低） */
function recipientOf(order: {
  user?: { email: string | null; name: string } | null;
  guestEmail?: string | null;
  guestName?: string | null;
}): { to: string | null; name: string } {
  return {
    to: order.user?.email ?? order.guestEmail ?? null,
    name: order.user?.name ?? order.guestName ?? "顧客",
  };
}

function toEmailItem(it: { productName: string; size: string | null; price: number; quantity: number; originalPrice?: number | null }): OrderEmailItem {
  return { productName: it.productName, size: it.size, price: it.price, originalPrice: it.originalPrice ?? null, quantity: it.quantity };
}

/** 全單未取消貨品係咪全部寄出（shipped）；係 → 回 true */
function allShipped(items: { shipStatus: string }[]): boolean {
  const live = items.filter((i) => i.shipStatus !== "cancelled");
  return live.length > 0 && live.every((i) => i.shipStatus === "shipped");
}

export async function wmsShipmentCallback(c: Context) {
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
  const action = typeof b.action === "string" ? b.action : "";
  const actorName = typeof b.actorName === "string" ? b.actorName.slice(0, 64) : "";
  if (
    !orderNo ||
    !["shipped", "unshipped", "item_cancelled", "item_updated", "sf_updated"].includes(action)
  ) {
    return c.json(
      { ok: false, error: "需要 orderNo + action（shipped|unshipped|item_cancelled|item_updated|sf_updated）" },
      400,
    );
  }

  // ─── action=sf_updated：WMS 批准改順豐單號 → 官網最新一個生效中嘅順豐批次跟改 ─────
  // 唔使 items（成張單嘅順豐單號層面，舊單冇 orderItemId 都搞得）；唔寄 email（WMS 會推播員工），淨落 audit。
  // 搵唔到生效中嘅順豐批次 → 404 明確報錯（WMS 會寫【官網回調失敗】＋推播主管，唔靜默）
  if (action === "sf_updated") {
    const newSfNo = typeof b.sfNo === "string" ? b.sfNo.trim().slice(0, 64) : "";
    const oldSfNo = typeof b.oldSfNo === "string" ? b.oldSfNo.trim().slice(0, 64) : "";
    if (!newSfNo) return c.json({ ok: false, error: "sf_updated 需要 sfNo（新單號）" }, 400);
    const db = getDb();
    const order = await db.query.orders.findFirst({ where: eq(orders.orderNo, orderNo) });
    if (!order) return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
    const batches = await db
      .select()
      .from(orderShipments)
      .where(
        and(
          eq(orderShipments.orderId, order.id),
          eq(orderShipments.shipMethod, "sf"),
          isNull(orderShipments.reversedAt),
        ),
      )
      .orderBy(desc(orderShipments.id))
      .limit(1);
    const batch = batches[0];
    if (!batch) {
      return c.json({ ok: false, error: `訂單 ${orderNo} 冇生效中嘅順豐批次，官網未更新（請人手核對）` }, 404);
    }
    await db.update(orderShipments).set({ sfNo: newSfNo }).where(eq(orderShipments.id, batch.id));
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.sfUpdated",
      targetType: "order",
      targetId: order.orderNo,
      detail:
        `WMS 改順豐單號（訂單 ${order.orderNo}，批次 #${batch.id}）：` +
        `原單號 ${oldSfNo || batch.sfNo || "（冇）"} → 新單號 ${newSfNo}` +
        `${actorName ? `；經手：${actorName}` : ""}`,
    });
    console.log(`[wms] sf_updated ${orderNo} batch#${batch.id} ${oldSfNo || batch.sfNo || "-"}→${newSfNo}`);
    return c.json({ ok: true, batchId: batch.id });
  }
  const rawItems = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  if (rawItems.length === 0) {
    return c.json({ ok: false, error: "items 唔可以係空（最少一件 orderItemId 或 sku）" }, 400);
  }

  const db = getDb();
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderNo, orderNo),
    with: {
      items: true,
      user: { columns: { name: true, email: true, phone: true } },
    },
  });
  if (!order) {
    return c.json({ ok: false, error: `搵唔到訂單 ${orderNo}` }, 404);
  }

  // v2.5.4：逐件解析 — orderItemId（正整數）直接用；冇就用 sku 對 orderItems（舊單冇貨品ID嘅補救）
  const owned = new Map(order.items.map((it) => [it.id, it]));
  const resolved: { id: number; raw: Record<string, unknown>; via: "id" | "sku" }[] = [];
  const unresolved: string[] = [];
  for (const it of rawItems) {
    const n = Number(it.orderItemId);
    if (Number.isInteger(n) && n > 0) {
      resolved.push({ id: n, raw: it, via: "id" });
      continue;
    }
    const sku = typeof it.sku === "string" ? it.sku.trim() : "";
    if (!sku) {
      unresolved.push("（冇 orderItemId 亦冇 sku）");
      continue;
    }
    const cand = order.items.filter((x) => x.sku === sku || (x.size ? `${x.sku}-${x.size}` : x.sku) === sku);
    // 多件命中：優先揀動作期望嘅來源狀態（shipped/item_cancelled 由 pending 郁；unshipped 由 shipped 郁）
    const want = action === "unshipped" ? "shipped" : action === "item_updated" ? null : "pending";
    const hit = (want ? cand.find((x) => x.shipStatus === want) : undefined) ?? cand[0];
    if (hit) resolved.push({ id: hit.id, raw: it, via: "sku" });
    else unresolved.push(`sku:${sku}`);
  }
  if (unresolved.length > 0) {
    return c.json({ ok: false, error: `items 對唔到訂單 ${orderNo} 嘅貨品：${unresolved.join("、")}` }, 400);
  }
  const itemIds = resolved.map((r) => r.id);

  // 核實啲 item 真係屬於呢張單（防 WMS 傳錯 id 郁咗其他單嘅貨）
  const unknown = itemIds.filter((id) => !owned.has(id));
  if (unknown.length > 0) {
    return c.json({ ok: false, error: `orderItemId ${unknown.join(",")} 唔屬於訂單 ${orderNo}` }, 400);
  }

  // ─── action=shipped：出貨（分批）────────────────────────────────────────
  if (action === "shipped") {
    const shipMethod = typeof b.shipMethod === "string" ? b.shipMethod : "";
    if (!SHIP_METHODS.has(shipMethod)) {
      return c.json({ ok: false, error: "shipMethod 要係 sf|face|pickup|storage" }, 400);
    }
    const sfNo = typeof b.sfNo === "string" ? b.sfNo.trim().slice(0, 64) : "";
    if (shipMethod === "sf" && !sfNo) {
      return c.json({ ok: false, error: "順豐出貨必填 sfNo（順豐單號）" }, 400);
    }
    if (!["approved", "shipped"].includes(order.status)) {
      return c.json(
        { ok: false, error: `訂單狀態係 ${order.status}，唔可以出貨（要 approved 先出得）` },
        409,
      );
    }
    const shippedAt =
      typeof b.shippedAt === "string" && !Number.isNaN(Date.parse(b.shippedAt))
        ? new Date(b.shippedAt)
        : new Date();

    const result = await db.transaction(async (tx) => {
      const [batch] = await tx
        .insert(orderShipments)
        .values({
          orderId: order.id,
          shipMethod,
          sfNo: shipMethod === "sf" ? sfNo : null,
          itemIds: JSON.stringify(itemIds),
          shippedAt,
          actorName: actorName || null,
        })
        .returning({ id: orderShipments.id });
      const shippedIds: number[] = [];
      const skipped: { id: number; reason: string }[] = [];
      for (const id of itemIds) {
        // 冪等＋防禦：淨係 pending 先郁得（已 shipped／cancelled 直接 skip 列明）
        const [u] = await tx
          .update(orderItems)
          .set({ shipStatus: "shipped", shipmentId: batch.id })
          .where(and(eq(orderItems.id, id), eq(orderItems.shipStatus, "pending")))
          .returning({ id: orderItems.id });
        if (u) shippedIds.push(id);
        else skipped.push({ id, reason: owned.get(id)!.shipStatus });
      }
      // 全單未取消都寄齊 → 訂單轉 shipped（正常終態）＋寫 shippedAt
      const freshItems = await tx.query.orderItems.findMany({
        where: eq(orderItems.orderId, order.id),
        columns: { shipStatus: true },
      });
      let orderShippedAll = false;
      if (allShipped(freshItems)) {
        orderShippedAll = true;
        if (order.status === "approved") {
          await tx
            .update(orders)
            .set({ status: "shipped", shippedAt, updatedAt: new Date() })
            .where(and(eq(orders.id, order.id), eq(orders.status, "approved")));
        } else {
          await tx
            .update(orders)
            .set({ shippedAt, updatedAt: new Date() })
            .where(eq(orders.id, order.id));
        }
      }
      return { batchId: batch.id, shippedIds, skipped, orderShippedAll };
    });

    // 冇郁到任何一件（全部重複推送）→ 已處理過，唔好再插批次？批次已插但冇貨——
    // 標 reversed 留底，回 already 畀 WMS 知唔使 retry
    if (result.shippedIds.length === 0) {
      await db
        .update(orderShipments)
        .set({ reversedAt: new Date() })
        .where(eq(orderShipments.id, result.batchId));
      return c.json({ ok: true, already: true, skipped: result.skipped });
    }

    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.shipped",
      targetType: "order",
      targetId: order.orderNo,
      detail:
        `WMS 出貨（訂單 ${order.orderNo}，批次 #${result.batchId}，方式 ${shipMethod}` +
        `${shipMethod === "sf" ? `，順豐單號 ${sfNo}` : ""}，件數 ${result.shippedIds.length}` +
        `${result.orderShippedAll ? "，全單寄齊轉「已寄出」" : ""}）` +
        `${actorName ? `，經手：${actorName}` : ""}` +
        `${result.skipped.length ? `，跳過（${result.skipped.map((s) => `#${s.id}:${s.reason}`).join("、")}）` : ""}`,
    });
    console.log(
      `[wms] shipment ${orderNo} batch#${result.batchId} ${shipMethod} items=${result.shippedIds.length} all=${result.orderShippedAll}`,
    );
    // 出貨信唔喺度寄——orderSweeper 10 分鐘 debounce 合併寄（storage 批次唔觸發信）
    return c.json({
      ok: true,
      batchId: result.batchId,
      shippedItemIds: result.shippedIds,
      skipped: result.skipped,
      orderStatus: result.orderShippedAll ? "shipped" : order.status,
    });
  }

  // ─── action=unshipped：取消出貨 ─────────────────────────────────────────
  if (action === "unshipped") {
    const reverted: number[] = [];
    const skipped: { id: number; reason: string }[] = [];
    const emailedBatchIds = new Set<number>();
    await db.transaction(async (tx) => {
      for (const id of itemIds) {
        const [u] = await tx
          .update(orderItems)
          .set({ shipStatus: "pending", shipmentId: null })
          .where(and(eq(orderItems.id, id), eq(orderItems.shipStatus, "shipped")))
          .returning({ id: orderItems.id, shipmentId: orderItems.shipmentId });
        if (!u) {
          skipped.push({ id, reason: owned.get(id)!.shipStatus });
          continue;
        }
        reverted.push(id);
        if (u.shipmentId != null) {
          // 批次標 reversed；**已寄出貨信嘅批次**要記低，交易後寄致歉信
          const [batch] = await tx
            .update(orderShipments)
            .set({ reversedAt: new Date() })
            .where(and(eq(orderShipments.id, u.shipmentId), isNull(orderShipments.reversedAt)))
            .returning({ id: orderShipments.id, emailedAt: orderShipments.emailedAt });
          if (batch?.emailedAt) emailedBatchIds.add(batch.id);
        }
      }
      if (reverted.length > 0 && order.status === "shipped") {
        await tx
          .update(orders)
          .set({ status: "approved", shippedAt: null, updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "shipped")));
      }
    });
    if (reverted.length === 0) {
      return c.json({ ok: true, already: true, skipped });
    }
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.unshipped",
      targetType: "order",
      targetId: order.orderNo,
      detail:
        `WMS 取消出貨（訂單 ${order.orderNo}，回復 ${reverted.length} 件「已確認」` +
        `${emailedBatchIds.size > 0 ? "，出貨信已寄→寄致歉信" : "，出貨信未寄→靜默反轉"}）` +
        `${actorName ? `，經手：${actorName}` : ""}`,
    });
    // 致歉信：淨係相關批次**已經寄咗出貨信**先寄（未寄就靜默，唔好嚇親客人）
    let emailNote = "";
    if (emailedBatchIds.size > 0) {
      const { to, name } = recipientOf(order);
      if (to) {
        const items = order.items.filter((it) => reverted.includes(it.id)).map(toEmailItem);
        const r = await sendShipmentRevertedEmail({ to, name, orderNo: order.orderNo, items });
        emailNote = r.ok ? "" : `（致歉信寄失敗：${r.error ?? "未知"}）`;
        if (emailNote) console.error(`[wms] unship apology email failed for ${orderNo}:`, r.error);
      } else {
        emailNote = "（訂單冇 email，致歉信未寄）";
      }
    }
    return c.json({ ok: true, revertedItemIds: reverted, skipped, apologyEmailSent: emailedBatchIds.size > 0 && !emailNote, note: emailNote || undefined });
  }

  // ─── action=item_cancelled：WMS 刪貨品（原因必填，客人睇到）────────────────
  // v2.5.4（老闆指示）：同款多件要分「部分取消／已取消」— WMS 帶 remainQty（件貨喺 WMS 仲剩幾多件，
  // 絕對值，retry 唔會重複扣）。remainQty > 0 → 部分取消（cancelledQty 留痕，shipStatus 維持 pending）；
  // remainQty = 0／冇帶 → 全取消（舊行為）。張單全部貨品都取消晒先轉 cancelled。
  if (action === "item_cancelled") {
    const cancelMap = new Map<number, string>();
    const remainQtyMap = new Map<number, number | null>();
    for (const { id, raw: it } of resolved) {
      const reason = typeof it.cancelReason === "string" ? it.cancelReason.trim() : "";
      if (!reason) {
        return c.json(
          { ok: false, error: `取消原因必填（客人會睇到）——orderItemId ${id} 冇 cancelReason` },
          400,
        );
      }
      cancelMap.set(id, reason);
      const rq = it.remainQty;
      remainQtyMap.set(id, typeof rq === "number" && Number.isInteger(rq) && rq >= 0 ? rq : null);
    }
    const cancelledIds: number[] = [];
    const partialIds: { id: number; cancelledQty: number; delta: number }[] = [];
    const skipped: { id: number; reason: string }[] = [];
    let allCancelledNow = false;
    await db.transaction(async (tx) => {
      for (const [id, reason] of cancelMap) {
        const item = owned.get(id)!;
        const rq = remainQtyMap.get(id) ?? null;
        // 目標已取消件數（絕對值）：冇 remainQty（舊 WMS）= 全取消
        const targetCancelled = rq === null ? item.quantity : Math.min(Math.max(item.quantity - rq, 0), item.quantity);
        // v2.5.5 第3版（msg85）：已出貨嘅貨品都准「全數取消」——WMS 整單取消（已出貨後客訴／退款）
        // 官網要照跟，否則 WMS 已轉「已取消」而官網永遠停喺「已寄出＋取消咗 N 件」，兩邊唔夾。
        // 已出貨嘅「部分取消」仲係唔准（出貨包裹已計數，抽唔到件返嚟）。
        const shippedFullCancel = item.shipStatus === "shipped" && targetCancelled >= item.quantity;
        if (item.shipStatus !== "pending" && !shippedFullCancel) {
          skipped.push({ id, reason: item.shipStatus });
          continue;
        }
        const delta = targetCancelled - (item.cancelledQty ?? 0);
        if (delta <= 0) {
          skipped.push({ id, reason: "冇新增取消件數" });
          continue;
        }
        if (targetCancelled >= item.quantity) {
          // 全取消：冪等 conditional update（pending／shipped 郁得；cancelled 唔會再中）
          const [u] = await tx
            .update(orderItems)
            .set({ shipStatus: "cancelled", cancelReason: reason, cancelledAt: new Date(), cancelledQty: item.quantity, shipmentId: null })
            .where(and(eq(orderItems.id, id), inArray(orderItems.shipStatus, ["pending", "shipped"])))
            .returning({ id: orderItems.id });
          if (!u) {
            skipped.push({ id, reason: "狀態已變" });
            continue;
          }
          cancelledIds.push(id);
        } else {
          // 部分取消：狀態留 pending，cancelledQty 記低取消咗幾多件（冪等：目標大過現值先郁）
          const [u] = await tx
            .update(orderItems)
            .set({ cancelledQty: targetCancelled, cancelReason: reason })
            .where(and(eq(orderItems.id, id), eq(orderItems.shipStatus, "pending"), sql`${orderItems.cancelledQty} < ${targetCancelled}`))
            .returning({ id: orderItems.id });
          if (!u) {
            skipped.push({ id, reason: "冇新增取消件數" });
            continue;
          }
          partialIds.push({ id, cancelledQty: targetCancelled, delta });
        }
        // 庫存回補（淨係補今次新增取消嘅 delta 件，部分取消唔會重複回補；
        // 已出貨嘅全數取消唔回補——貨已離倉，唔會返架上）
        if (!shippedFullCancel) {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} + ${delta}` })
            .where(eq(products.id, item.productId));
        }
      }
      if (cancelledIds.length > 0) {
        const fresh = await tx.query.orderItems.findMany({
          where: eq(orderItems.orderId, order.id),
          columns: { shipStatus: true },
        });
        // 全單件貨都取消晒 → 訂單轉 cancelled（淨係 approved/shipped 先郁；其他狀態唔郁）
        if (fresh.every((i) => i.shipStatus === "cancelled")) {
          allCancelledNow = true;
          await tx
            .update(orders)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(and(eq(orders.id, order.id), inArray(orders.status, ["approved", "shipped"])));
        }
      }
    });
    if (cancelledIds.length === 0 && partialIds.length === 0) {
      return c.json({ ok: true, already: true, skipped });
    }
    void logAudit({
      actorId: null,
      actorRole: "system",
      actorNameFallback: "WMS",
      action: "order.itemCancelled",
      targetType: "order",
      targetId: order.orderNo,
      detail:
        `WMS 刪貨品（訂單 ${order.orderNo}` +
        `${cancelledIds.length ? `，全取消 ${cancelledIds.length} 項` : ""}` +
        `${partialIds.length ? `，部分取消 ${partialIds.map((p) => `#${p.id}×${p.delta}`).join("、")}` : ""}` +
        `${allCancelledNow ? "，全單取消" : "，部分取消"}` +
        `）原因：${[...cancelMap.entries()].map(([id, r]) => `#${id}「${r}」`).join("、")}` +
        `${actorName ? `，經手：${actorName}` : ""}` +
        `${skipped.length ? `，跳過（${skipped.map((s) => `#${s.id}:${s.reason}`).join("、")}）` : ""}`,
    });
    // 取消信（原因白紙黑字；退款安排一句帶過——退款行現有 WMS 退款流程，唔自動退）
    const { to, name } = recipientOf(order);
    let emailNote = "";
    if (to) {
      const items = [
        ...order.items
          .filter((it) => cancelledIds.includes(it.id))
          .map((it) => ({ ...toEmailItem(it), cancelReason: cancelMap.get(it.id)! })),
        ...partialIds.map((p) => {
          const it = owned.get(p.id)!;
          return { ...toEmailItem(it), cancelReason: cancelMap.get(p.id)!, partialQty: p.delta };
        }),
      ];
      const r = await sendOrderItemCancelledEmail({
        to,
        name,
        orderNo: order.orderNo,
        items,
        allCancelled: allCancelledNow,
      });
      emailNote = r.ok ? "" : `（貨品取消信寄失敗：${r.error ?? "未知"}）`;
      if (emailNote) console.error(`[wms] item-cancelled email failed for ${orderNo}:`, r.error);
    } else {
      emailNote = "（訂單冇 email，取消信未寄）";
    }
    return c.json({ ok: true, cancelledItemIds: cancelledIds, partialCancelled: partialIds, skipped, allCancelled: allCancelledNow, note: emailNote || undefined });
  }

  // ─── action=item_updated：WMS 改貨品資料（changeNote 必填，客人睇到）────────
  // v2.3.16（老闆指示）：changes 加 price（整數港元）——改價錢會更新 orderItems.price ＋ 重計訂單 total；
  // 日期／場次官網冇對應欄，WMS 會寫入 changeNote。淨說明更新（冇欄位改）都收得，changeNote 必填唔變。
  const changeList: {
    id: number;
    changes: { sku?: string; productName?: string; size?: string | null; price?: number };
    changeNote: string;
  }[] = [];
  for (const { id, raw: it } of resolved) {
    const ch = (it.changes ?? {}) as Record<string, unknown>;
    const changes: { sku?: string; productName?: string; size?: string | null; price?: number } = {};
    if (typeof ch.sku === "string" && ch.sku.trim()) changes.sku = ch.sku.trim().slice(0, 64);
    if (typeof ch.productName === "string" && ch.productName.trim()) changes.productName = ch.productName.trim().slice(0, 255);
    if (typeof ch.size === "string") changes.size = ch.size.trim().slice(0, 64) || null;
    if (typeof ch.price === "number" && Number.isFinite(ch.price)) {
      const p = Math.round(ch.price);
      if (p >= 0) changes.price = p;
    }
    const changeNote = typeof it.changeNote === "string" ? it.changeNote.trim() : "";
    if (!changeNote) {
      return c.json({ ok: false, error: `更改說明必填（客人會睇到）——orderItemId ${id} 冇 changeNote` }, 400);
    }
    changeList.push({ id, changes, changeNote });
  }
  const updatedIds: number[] = [];
  const priceChangeDescs: string[] = [];
  const emailItems: {
    before: { productName: string; sku: string; size: string | null; price?: number };
    after: { productName: string; sku: string; size: string | null; price?: number };
    quantity: number;
    changeNote: string;
  }[] = [];
  // transaction 回傳 total 變更（有改價錢兼金額真係變咗先至有值）
  const totalChanged = await db.transaction(async (tx): Promise<{ from: number; to: number } | null> => {
    for (const entry of changeList) {
      const before = owned.get(entry.id)!;
      const priceChanged = entry.changes.price !== undefined && entry.changes.price !== before.price;
      const after = {
        productName: entry.changes.productName ?? before.productName,
        sku: entry.changes.sku ?? before.sku,
        size: entry.changes.size !== undefined ? entry.changes.size : before.size,
        price: entry.changes.price !== undefined ? entry.changes.price : before.price,
      };
      await tx
        .update(orderItems)
        .set({
          ...after,
          staffChangedAt: new Date(),
          staffChangeNote: entry.changeNote,
          staffChangedBy: actorName || "WMS",
        })
        .where(eq(orderItems.id, entry.id));
      updatedIds.push(entry.id);
      if (priceChanged) {
        priceChangeDescs.push(`#${entry.id} 單價 HK$${before.price} → HK$${after.price}`);
      }
      emailItems.push({
        before: { productName: before.productName, sku: before.sku, size: before.size, price: before.price },
        after,
        quantity: before.quantity,
        changeNote: entry.changeNote,
      });
    }
    // v2.3.16：有改價錢 → 重計訂單 total = Σ 未取消件（price×qty）− discountAmount，唔准負數
    if (priceChangeDescs.length > 0) {
      const fresh = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      const sum = fresh
        .filter((i) => i.shipStatus !== "cancelled")
        .reduce((s, i) => s + i.price * i.quantity, 0);
      const newTotal = Math.max(0, sum - (order.discountAmount ?? 0));
      if (newTotal !== order.total) {
        await tx.update(orders).set({ total: newTotal }).where(eq(orders.id, order.id));
        return { from: order.total, to: newTotal };
      }
    }
    return null;
  });
  void logAudit({
    actorId: null,
    actorRole: "system",
    actorNameFallback: "WMS",
    action: "order.itemUpdated",
    targetType: "order",
    targetId: order.orderNo,
    detail:
      `WMS 改貨品資料（訂單 ${order.orderNo}，${updatedIds.length} 件）` +
      `${actorName ? `，經手：${actorName}` : ""}；` +
      (priceChangeDescs.length > 0 ? `${priceChangeDescs.join("、")}；` : "") +
      (totalChanged ? `訂單總額 HK$${totalChanged.from} → HK$${totalChanged.to}；` : "") +
      changeList.map((e) => `#${e.id}「${e.changeNote}」`).join("、"),
  });
  const { to, name } = recipientOf(order);
  let emailNote = "";
  if (to) {
    const r = await sendOrderItemChangedEmail({
      to,
      name,
      orderNo: order.orderNo,
      items: emailItems,
      changedBy: actorName || "WMS 同事",
    });
    emailNote = r.ok ? "" : `（員工更改信寄失敗：${r.error ?? "未知"}）`;
    if (emailNote) console.error(`[wms] item-changed email failed for ${orderNo}:`, r.error);
  } else {
    emailNote = "（訂單冇 email，更改信未寄）";
  }
  return c.json({ ok: true, updatedItemIds: updatedIds, note: emailNote || undefined });
}

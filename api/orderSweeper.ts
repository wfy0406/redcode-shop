import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, orderShipments, products, users, walletTopups } from "@db/schema";
import { logAudit } from "./audit";
import {
  sendOrderCancelledEmail,
  sendGuestOrderCancelledEmail,
  sendOrderShippedEmail,
  sendWalletTopupCancelledEmail,
  orderVipEmailInfo,
  type ShipmentEmailBatch,
} from "./email";
import { returnWalletForOrder } from "./wallet";

/**
 * 待付款訂單自動取消（2026-07-30 Glo 規則；2026-08-04 起收緊做 2 天）
 * 客人落單後 2 天（48 小時）都未上傳付款截圖（status 仲係 pending_payment），
 * 系統自動將張單轉做「已取消」＋逐行加返庫存（同後台人手取消同一套做法）
 * ＋寄訂單取消信畀會員（有綁 email 先寄；2026-08-06 Glo 要求），
 * 審計日誌留底（actor＝系統）。
 * 已上傳截圖嘅單唔受影響：佢哋 status 一早轉咗 payment_review。
 * 開機時即刻掃一次，之後每 30 分鐘掃一次；任何失敗淨係 log，唔會冧 server。
 */

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
// 2026-10-09 訪客購買：訪客單付款保留 30 分鐘（expiresAt），掃描間隔加密到 5 分鐘——
// 舊 30 分鐘間隔對 30 分鐘 TTL 太粗（最差 60 分鐘先釋放庫存）。會員 48h 規則不變。
const GUEST_TTL_GRACE_MS = 0; // expiresAt 一到即合資格取消（唔加 grace，契約講死 30 分鐘）
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** 訪客單（userId IS NULL）過期取消：同會員同一套 transaction＋回庫存，信行 guest 版 */
async function sweepExpiredGuestOrders(now = new Date()): Promise<number> {
  const db = getDb();
  const expired = await db.query.orders.findMany({
    where: and(
      isNull(orders.userId),
      eq(orders.status, "pending_payment"),
      lt(orders.expiresAt, new Date(now.getTime() - GUEST_TTL_GRACE_MS)),
    ),
    with: { items: true },
  });

  let cancelled = 0;
  for (const order of expired) {
    try {
      await db.transaction(async (tx) => {
        // 雙重檢查：同一秒客人啱啱俾咗錢（webhook 轉咗態）就唔好郁
        const [updated] = await tx
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")))
          .returning({ id: orders.id });
        if (!updated) return;
        for (const item of order.items) {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} + ${item.quantity}` })
            .where(eq(products.id, item.productId));
        }
      });
      cancelled += 1;
      // 訪客取消信（簡短版）：guestEmail 必填所以一定有得寄；失敗唔靜默，寫入 audit detail
      let emailNote = "";
      if (order.guestEmail) {
        const result = await sendGuestOrderCancelledEmail({
          to: order.guestEmail,
          name: order.guestName ?? "客人",
          orderNo: order.orderNo,
          total: order.total,
        });
        emailNote = result.ok
          ? `，取消信已寄出至 ${order.guestEmail}`
          : `，取消信寄出失敗（${result.error ?? "未知原因"}）`;
      } else {
        emailNote = "，訪客單冇 Email，冇寄取消信";
      }
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "order.autoCancelGuest",
        targetType: "order",
        targetId: order.orderNo,
        detail: `訪客訂單 ${order.orderNo} 30 分鐘付款保留期已過（expiresAt ${order.expiresAt?.toISOString()}），系統自動取消（庫存已加返）${emailNote}`,
      });
    } catch (e) {
      console.error(`[sweeper] 取消訪客訂單 ${order.orderNo} 失敗:`, e);
    }
  }
  return cancelled;
}

/** 掃描＋取消逾期待付款訂單，回傳取消咗幾多張 */
export async function sweepExpiredPendingOrders(now = new Date()): Promise<number> {
  const db = getDb();
  const cutoff = new Date(now.getTime() - TWO_DAYS_MS);
  const expired = await db.query.orders.findMany({
    // 訪客單（userId IS NULL）由 30 分鐘掃描（sweepExpiredGuestOrders）處理，呢度淨係掃會員單
    where: and(eq(orders.status, "pending_payment"), lt(orders.createdAt, cutoff), isNotNull(orders.userId)),
    with: { items: true },
  });

  let cancelled = 0;
  for (const order of expired) {
    try {
      let walletReturned = 0;
      await db.transaction(async (tx) => {
        // 雙重檢查：如果同一秒有客人啱啱傳咗截圖／員工改咗狀態，就唔好郁
        const [updated] = await tx
          .update(orders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending_payment")))
          .returning({ id: orders.id });
        if (!updated) return;
        // 取消訂單＝貨唔會出，落單時扣咗嘅庫存要加返（同 updateStatus 取消同一套）
        for (const item of order.items) {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} + ${item.quantity}` })
            .where(eq(products.id, item.productId));
        }
        // v2.5.0（購物金）：48h 逾時取消 → 用咗嘅購物金自動返還（冪等鎖 walletReturnedAt）
        walletReturned = await returnWalletForOrder(tx, order, "訂單逾時取消返還（48 小時未付款）");
      });
      cancelled += 1;
      // 訂單取消信（2026-08-06 Glo 要求）：會員有綁 email 先寄；寄信結果寫入日誌 detail，方便後台排查
      let emailNote = "";
      // where 已隔咗訪客單，但類型上 userId 仲係 nullable——呢度窄化返（防線）
      const member = order.userId == null
        ? null
        : await db.query.users.findFirst({
            where: eq(users.id, order.userId),
            columns: { name: true, email: true },
          });
      if (member?.email) {
        const result = await sendOrderCancelledEmail({
          to: member.email,
          name: member.name,
          orderNo: order.orderNo,
          total: order.total,
          discountAmount: order.discountAmount,
          createdAt: order.createdAt,
          // v2.1.1（Wave 2）：取消信一樣顯示 VIP 級別＋折扣（全網單據統一）
          vip: orderVipEmailInfo(order),
          // v2.5.0（購物金）：取消信列明購物金返還
          walletRefund: walletReturned > 0 ? walletReturned : undefined,
          items: order.items.map((it) => ({
            productName: it.productName,
            size: it.size,
            price: it.price,
            quantity: it.quantity,
          })),
        });
        emailNote = result.ok
          ? `，取消信已寄出至 ${member.email}`
          : `，取消信寄出失敗（${result.error ?? "未知原因"}）`;
      } else {
        emailNote = "，會員冇綁 Email，冇寄取消信";
      }
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "order.autoCancel",
        targetType: "order",
        targetId: order.orderNo,
        detail: `訂單 ${order.orderNo} 落單滿 2 天（48 小時）未上傳付款截圖，系統自動取消（庫存已加返）${walletReturned > 0 ? `，購物金 HK$${walletReturned} 已自動返還` : ""}${emailNote}`,
      });
    } catch (e) {
      console.error(`[sweeper] 取消訂單 ${order.orderNo} 失敗:`, e);
    }
  }
  return cancelled;
}

/**
 * v2.5.1（購物金，老闆 2026-10-09 指令）：充值單 30 分鐘未付款自動取消（即時付款同上傳截圖都係）。
 * 淨郁 pending_payment（未俾錢嘅）；payment_review（已付款待批核）唔郁——
 * 錢收咗就唔會自動取消，等同事批。取消信寄畀會員（有 email 先寄）。
 */
async function sweepExpiredWalletTopups(now = new Date()): Promise<number> {
  const db = getDb();
  const expired = await db.query.walletTopups.findMany({
    where: and(
      eq(walletTopups.status, "pending_payment"),
      lt(walletTopups.expiresAt, now),
    ),
  });
  let cancelled = 0;
  for (const topup of expired) {
    try {
      const [updated] = await db
        .update(walletTopups)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(and(eq(walletTopups.id, topup.id), eq(walletTopups.status, "pending_payment")))
        .returning({ id: walletTopups.id });
      if (!updated) continue;
      cancelled += 1;
      // 取消信（有 email 先寄；失敗唔靜默，寫入 audit detail）
      let emailNote = "";
      const member = await db.query.users.findFirst({
        where: eq(users.id, topup.userId),
        columns: { name: true, email: true },
      });
      if (member?.email) {
        const r = await sendWalletTopupCancelledEmail({
          to: member.email,
          name: member.name,
          topupNo: topup.topupNo,
          label: topup.label,
          price: topup.price,
        });
        emailNote = r.ok
          ? `，取消信已寄出至 ${member.email}`
          : `，取消信寄出失敗（${r.error ?? "未知原因"}）`;
      } else {
        emailNote = "，會員冇綁 Email，冇寄取消信";
      }
      void logAudit({
        actorId: null,
        actorRole: "system",
        action: "wallet.topupAutoCancel",
        targetType: "walletTopup",
        targetId: topup.topupNo,
        detail: `充值單 ${topup.topupNo} 滿 30 分鐘未付款，系統自動取消${emailNote}`,
      });
    } catch (e) {
      console.error(`[sweeper] 取消充值單 ${topup.topupNo} 失敗:`, e);
    }
  }
  return cancelled;
}

/**
 * v2.4.0（Wave 2 出貨同步）：出貨信 debounce 10 分鐘。
 * 每張有未寄批次（orderShipments.emailedAt IS NULL、未 reversed）嘅單：
 *   - 該單**非儲貨**批次最新一次未夠 10 分鐘 → skip 等下輪（debounce 重新計時）
 *   - 夠 10 分鐘 → 一次過寄**一封**合併信（順豐單號＋追蹤連結＋2–10h 提示／面交／自取字句），
 *     寄成功先寫 emailedAt（失敗留返下輪 retry，唔會靜默）
 *   - 淨係儲貨（storage）批次 → 唔寄信，直接標 emailedAt（貨未離倉，唔好嚇客人）
 *   - 訂單已取消 → 唔寄，照標 emailedAt 留底
 * 收信人：會員單用會員 email；訪客單用 guestEmail；冇 email → 標 emailedAt＋audit 記低。
 */
async function sendDueShipmentEmails(now = new Date()): Promise<number> {
  const db = getDb();
  const pending = await db.query.orderShipments.findMany({
    where: and(isNull(orderShipments.emailedAt), isNull(orderShipments.reversedAt)),
  });
  if (pending.length === 0) return 0;
  const byOrder = new Map<number, typeof pending>();
  for (const row of pending) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push(row);
    byOrder.set(row.orderId, list);
  }
  const DEBOUNCE_MS = 10 * 60 * 1000;
  let sent = 0;
  for (const [orderId, batches] of byOrder) {
    try {
      const nonStorage = batches.filter((b) => b.shipMethod !== "storage");
      const markAll = async () => {
        await db
          .update(orderShipments)
          .set({ emailedAt: now })
          .where(inArray(orderShipments.id, batches.map((b) => b.id)));
      };
      // 儲貨批次唔觸發信：冇非儲貨批次 → 靜默標埋佢
      if (nonStorage.length === 0) {
        await markAll();
        continue;
      }
      // debounce：最新一次非儲貨出貨未夠 10 分鐘 → 等下輪
      const latest = Math.max(...nonStorage.map((b) => b.createdAt.getTime()));
      if (now.getTime() - latest < DEBOUNCE_MS) continue;

      const order = await db.query.orders.findFirst({
        where: eq(orders.id, orderId),
        with: {
          items: true,
          user: { columns: { name: true, email: true } },
        },
      });
      // 訂單唔存在／已取消 → 唔寄，照標留底
      if (!order || order.status === "cancelled") {
        await markAll();
        continue;
      }
      const to = order.user?.email ?? order.guestEmail ?? null;
      const name = order.user?.name ?? order.guestName ?? "顧客";
      if (!to) {
        await markAll();
        void logAudit({
          actorId: null,
          actorRole: "system",
          action: "order.shippedEmailSkipped",
          targetType: "order",
          targetId: order.orderNo,
          detail: `訂單 ${order.orderNo} 出貨信未寄：冇收信 email（會員未綁／訪客缺）`,
        });
        continue;
      }
      // 逐批砌貨品表：以「而家仲掛住呢個批次」嘅 item 為準（unship 後再出貨會轉批次）
      const emailBatches: ShipmentEmailBatch[] = [];
      for (const b of nonStorage.sort((a, b2) => a.shippedAt.getTime() - b2.shippedAt.getTime())) {
        const ids = order.items.filter((it) => it.shipmentId === b.id);
        if (ids.length === 0) continue;
        emailBatches.push({
          shipMethod: b.shipMethod,
          sfNo: b.sfNo,
          shippedAt: b.shippedAt,
          items: ids.map((it) => ({
            productName: it.productName,
            size: it.size,
            price: it.price,
            quantity: it.quantity,
          })),
        });
      }
      if (emailBatches.length === 0) {
        await markAll();
        continue;
      }
      const live = order.items.filter((it) => it.shipStatus !== "cancelled");
      const shippedItems = live.filter((it) => it.shipStatus === "shipped").length;
      // v2.5.5（老闆指示）：同款多件部分取消嘅件數都要話畀封信知（「已寄出晒（已取消商品除外）」）
      const cancelledUnits = order.items.reduce((s, it) => s + (it.cancelledQty ?? 0), 0);
      const r = await sendOrderShippedEmail({
        to,
        name,
        orderNo: order.orderNo,
        batches: emailBatches,
        totalItems: live.length,
        shippedItems,
        cancelledItems: cancelledUnits,
      });
      if (r.ok) {
        await markAll();
        sent += 1;
        void logAudit({
          actorId: null,
          actorRole: "system",
          action: "order.shippedEmail",
          targetType: "order",
          targetId: order.orderNo,
          detail: `出貨信已寄出至 ${to}（訂單 ${order.orderNo}，${emailBatches.length} 個批次，已寄 ${shippedItems}/${live.length} 件）`,
        });
      } else {
        // 失敗唔標 emailedAt——下輪自動 retry；log 大聲出嚟唔靜默
        console.error(`[sweeper] 出貨信寄失敗（訂單 ${order.orderNo} → ${to}）:`, r.error);
      }
    } catch (e) {
      console.error(`[sweeper] 出貨信處理訂單 #${orderId} 失敗:`, e);
    }
  }
  return sent;
}

/** 開機啟動：即刻掃一次，之後每 5 分鐘掃一次（會員 48h＋訪客 30min＋充值單 48h＋出貨信 debounce 同一輪掃） */
export function startOrderSweeper(): void {
  const run = (label: string) =>
    Promise.all([sweepExpiredPendingOrders(), sweepExpiredGuestOrders(), sweepExpiredWalletTopups(), sendDueShipmentEmails()])
      .then(([n, g, w, s]) => {
        if (n > 0) console.log(`[sweeper] ${label}：自動取消咗 ${n} 張逾期待付款訂單`);
        if (g > 0) console.log(`[sweeper] ${label}：自動取消咗 ${g} 張訪客逾時訂單（30 分鐘未付款）`);
        if (w > 0) console.log(`[sweeper] ${label}：自動取消咗 ${w} 張購物金充值單（30 分鐘未付款）`);
        if (s > 0) console.log(`[sweeper] ${label}：寄出咗 ${s} 封出貨通知（10 分鐘 debounce 合併）`);
      })
      .catch((e) => console.error(`[sweeper] ${label}失敗:`, e));

  void run("首次掃描");
  setInterval(() => void run("定時掃描"), SWEEP_INTERVAL_MS);
}

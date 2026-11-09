/**
 * 網站設計服務 Airwallex 收款確認（v2026.11.09）：
 * Lead 會喺 boot 嘅 webhook／return 分流 WD 前綴單落嚟呢度。
 *
 * 收款核對（code review 2026-11-09，唔准淨核 orderNo）——webhook／return-verify 兩條路
 * 都經 verifyWebDesignPaymentIntent（api/webDesignCore.ts 純函數）：
 *   merchant_order_id＝orderNo、stored intentId（如有）一致、intent.amount === order.total、currency === HKD；
 *   任何一項唔符 → 唔准轉 paid，loud console.error＋audit，等人手對數。
 *
 * - handleWebDesignWebhookPaid：webhook 專用入口（傳成個 data.object 入嚟）。
 * - handleWebDesignPaidOnline：統一入口（meta 必帶 amount/currency；未能核實 → 唔轉 paid）。
 *   冪等核心：conditional update 淨郁 paymentStatus='pending' 嘅單，郁到（第一次）
 *   先審計＋背景轉 WMS；Airwallex retry／兩路撞單郁 0 行 → 收檔。
 * - verifyWebDesignReturn：客人俾完錢跳返 /api/airwallex/return-web-design 嗰刻，
 *   webhook 可能遲到／漏咗——用 retrievePaymentIntent 主動查一次補狀態（never-throw）。
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { webDesignOrders } from "@db/schema";
import { logAudit } from "./audit";
import { getAirwallexConfig, retrievePaymentIntent } from "./airwallex";
import { forwardWebDesignOrderToWms } from "./webDesignWms";
import {
  canMarkWebDesignPaid,
  verifyWebDesignPaymentIntent,
  type WebDesignPaidIntentInfo,
} from "./webDesignCore";

export type WebDesignPaidSource = "webhook" | "return-verify";

/** webhook data.object 嘅 raw 形狀（未知欄當未能核實，唔會放行） */
export interface WebDesignWebhookIntent {
  id?: unknown;
  merchant_order_id?: unknown;
  amount?: unknown;
  currency?: unknown;
}

function toIntentInfo(raw: WebDesignWebhookIntent): WebDesignPaidIntentInfo {
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    merchantOrderId: typeof raw.merchant_order_id === "string" ? raw.merchant_order_id : null,
    amount: typeof raw.amount === "number" && Number.isFinite(raw.amount) ? raw.amount : null,
    currency: typeof raw.currency === "string" ? raw.currency : null,
  };
}

/** 核對＋冪等轉 paid（核心，兩條路共用）。回傳 true＝今次第一次確認（做咗嘢）。 */
async function markPaidIfVerified(
  orderNo: string,
  intent: WebDesignPaidIntentInfo,
  source: WebDesignPaidSource,
): Promise<boolean> {
  const db = getDb();
  const order = await db.query.webDesignOrders.findFirst({
    where: eq(webDesignOrders.orderNo, orderNo),
  });
  if (!order) return false;
  // 冪等＋來源狀態閘（canMarkWebDesignPaid）：淨 pending｜review 郁得——
  // review＝客人傳咗截圖但同一個網上 intent 確實成功，核對通過應轉 paid（唔准卡 review）；
  // rejected／paid／cancelled 唔郁（已處理／終態；retry 撞單郁 0 行收檔）。
  const fromStatus = order.paymentStatus;
  if (!canMarkWebDesignPaid(fromStatus, order.status)) return false;

  const check = verifyWebDesignPaymentIntent({
    orderNo: order.orderNo,
    orderTotal: order.total,
    storedIntentId: order.airwallexIntentId,
    intent,
  });
  if (!check.ok) {
    // 唔准轉 paid：大聲記錄＋audit，等人手對數（可能係少付／對錯單／假 webhook 過咗簽名都頂唔順呢關）
    console.error(
      `[airwallex] ⚠️ 網站設計單 ${order.orderNo} 收款核對失敗，唔會轉 paid：${check.reason}（來源：${source}）`,
    );
    void logAudit({
      actorRole: "system",
      action: "webDesign.paidRejected",
      targetType: "webDesignOrder",
      targetId: order.orderNo,
      detail: `Airwallex 收款核對失敗（${check.reason}，來源：${source}），訂單維持待付款，要人手對數`,
    });
    return false;
  }

  const paidAt = new Date();
  const updated = await db
    .update(webDesignOrders)
    .set({
      paymentStatus: "paid",
      paymentChannel: "airwallex",
      ...(intent.id ? { airwallexIntentId: intent.id } : {}),
      paidAt,
      updatedAt: paidAt,
    })
    .where(
      and(
        eq(webDesignOrders.orderNo, orderNo),
        inArray(webDesignOrders.paymentStatus, ["pending", "review"]),
        ne(webDesignOrders.status, "cancelled"),
      ),
    )
    .returning({ id: webDesignOrders.id, orderNo: webDesignOrders.orderNo });
  const paid = updated[0];
  if (!paid) return false;
  void logAudit({
    actorRole: "system",
    action: "webDesign.paidOnline",
    targetType: "webDesignOrder",
    targetId: paid.orderNo,
    detail: `Airwallex 網上付款成功（網站設計單 ${paid.orderNo}${intent.id ? `，intent ${intent.id}` : ""}，金額 HK$${order.total} 已核對，來源：${source === "webhook" ? "webhook" : "return 主動查證"}${fromStatus === "review" ? "，原狀態 review（截圖待核實）→ 網上收款確認覆核轉 paid" : ""}），已排程轉 WMS 官網中心`,
  });
  // 背景轉單去 WMS（唔阻回應；失敗 forward 自己會 loud 記錄＋落 wmsError，後台可 retry）
  void forwardWebDesignOrderToWms(paid.id)
    .then((r) =>
      console.log(
        `[airwallex] 網站設計單 ${paid.orderNo} 轉 WMS：${r.status}${r.error ? `，${r.error}` : ""}`,
      ),
    )
    .catch((e) => console.error(`[airwallex] 網站設計單 ${paid.orderNo} 轉 WMS 出錯:`, e));
  return true;
}

/**
 * webhook 專用入口（payment_intent.succeeded）：傳成個 data.object 入嚟，
 * 呢度抽 id／merchant_order_id／amount／currency 做齊四項核對先准轉 paid。
 */
export async function handleWebDesignWebhookPaid(intent: WebDesignWebhookIntent): Promise<boolean> {
  const info = toIntentInfo(intent);
  if (!info.merchantOrderId) return false;
  return markPaidIfVerified(info.merchantOrderId, info, "webhook");
}

/**
 * 統一入口（return-verify 等）：meta 必帶 amount／currency（retrievePaymentIntent 有返）；
 * 傳 null＝未能核實 → 核對失敗唔轉 paid（寧願人手對數，唔准未核實金額落 paid）。
 */
export async function handleWebDesignPaidOnline(
  orderNo: string,
  intentId: string | null,
  source: WebDesignPaidSource,
  meta: { amount: number | null; currency: string | null; merchantOrderId?: string | null },
): Promise<boolean> {
  return markPaidIfVerified(
    orderNo,
    {
      id: intentId,
      merchantOrderId: meta.merchantOrderId ?? orderNo,
      amount: meta.amount,
      currency: meta.currency,
    },
    source,
  );
}

/**
 * return 回跳主動查證：/api/airwallex/return-web-design?orderNo=WD...（Lead 喺 boot 註冊）。
 * 淨係 paymentStatus='pending' 先查；SUCCEEDED 且過埋金額／幣種／intent 核對先補狀態。
 * never-throw：任何失敗淨係 console.error，webhook 照舊兜底。
 */
export async function verifyWebDesignReturn(orderNo: string): Promise<void> {
  try {
    const cfg = await getAirwallexConfig();
    if (!cfg) return;
    const db = getDb();
    const order = await db.query.webDesignOrders.findFirst({
      where: eq(webDesignOrders.orderNo, orderNo),
    });
    if (!order || !canMarkWebDesignPaid(order.paymentStatus, order.status)) return;
    if (!order.airwallexIntentId) {
      console.log(`[airwallex] return-web-design 查證：訂單 ${order.orderNo} 未記 intent id，等 webhook 處理`);
      return;
    }
    const intent = await retrievePaymentIntent(cfg, order.airwallexIntentId);
    console.log(
      `[airwallex] return-web-design 查證：訂單 ${order.orderNo}，intent ${order.airwallexIntentId} 狀態 ${intent.status}`,
    );
    if (intent.status !== "SUCCEEDED") return;
    const handled = await handleWebDesignPaidOnline(order.orderNo, intent.id, "return-verify", {
      amount: intent.amount,
      currency: intent.currency,
      merchantOrderId: intent.merchantOrderId,
    });
    if (handled) {
      console.log(`[airwallex] return-web-design 查證確認收款：訂單 ${order.orderNo}（webhook 未到，主動補咗）`);
    }
  } catch (e) {
    console.error("[airwallex] return-web-design 主動查證出錯:", e);
  }
}

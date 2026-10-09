/**
 * v2.5.0（會員購物金 wallet，2026-10-09 老闆指令）：純函數＋共用 DB 助手。
 *
 * 規則（老闆原話落實）：
 * - 後台上架套票（面額 ≠ 售價，例如面額 $1000 賣 $970）；
 * - 充值同平時消費一樣：Airwallex 即時付款／上傳截圖，48 小時內要付款，
 *   但要官網後台／WMS 批核先入帳（未批唔會加餘額）；
 * - 購物落單可用購物金抵銷；唔夠俾晒 → 尾數即時付款／上傳截圖；
 * - 訂單 48 小時未付被取消 → 購物金自動返還（walletReturnedAt 做冪等鎖）；
 * - 購物金不設退款；只限官網所銷售之商品（直播商品唔用得）。
 *
 * 金額全部整數港元（同 orders.total 一個單位，全鏈唔乘除 100）。
 */
import { randomInt } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { orders, users, walletLedger } from "@db/schema";

/** 充值單號前綴：Airwallex webhook／return 靠佢分流（唔會撞 RC 訂單號） */
export const TOPUP_NO_PREFIX = "WT";

/** 充值單付款保留期（同會員購物單 48 小時規則） */
export const TOPUP_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function isTopupNo(merchantOrderId: string): boolean {
  return merchantOrderId.startsWith(TOPUP_NO_PREFIX);
}

/** 充值單號：WT + YYYYMMDD + 隨機 4 位（同 generateOrderNo 同一款） */
export function generateTopupNo(): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  return `${TOPUP_NO_PREFIX}${ymd}${String(randomInt(0, 10000)).padStart(4, "0")}`;
}

/** 充值單狀態中文 label（後台／會員中心共用） */
export const TOPUP_STATUS_LABEL: Record<string, string> = {
  pending_payment: "待付款",
  payment_review: "待批核",
  approved: "已入帳",
  rejected: "已拒絕",
  cancelled: "已取消",
};

/** 充值付款渠道 label（「用咩充」：airwallex 定手動截圖） */
export const TOPUP_CHANNEL_LABEL: Record<string, string> = {
  airwallex: "網上即時付款（Airwallex）",
  manual: "手動上傳截圖",
};

/** 流水賬類型 label */
export const LEDGER_TYPE_LABEL: Record<string, string> = {
  topup: "充值入帳",
  spend: "購物扣減",
  refund: "取消返還",
};

/**
 * 落單購物金抵銷計算（純函數，單測用）：
 * 用盡餘額但唔超過單額；唔用就全部現金。
 */
export function computeWalletSplit(
  total: number,
  storeCredit: number,
  useWallet: boolean,
): { walletApplied: number; cashDue: number } {
  if (!useWallet || storeCredit <= 0 || total <= 0) {
    return { walletApplied: 0, cashDue: Math.max(0, total) };
  }
  const walletApplied = Math.min(storeCredit, total);
  return { walletApplied, cashDue: total - walletApplied };
}

/**
 * 退款拆賬（純函數）：退嘅錢先冚「實收現金」部分，超出現金部分嘅先落入購物金返還，
 * 上限係張單用咗嘅購物金。例：total 500、購物金使咗 200（現金收 300）——
 *   退 300 → 現金退 300、購物金 0；退 500 → 現金 300＋購物金返 200。
 */
export function splitRefundChannels(
  total: number,
  walletUsed: number,
  refundAmount: number,
): { cashRefund: number; walletReturn: number } {
  const cashPaid = Math.max(0, total - walletUsed);
  const cashRefund = Math.min(Math.max(0, refundAmount), cashPaid);
  const walletReturn = Math.min(Math.max(0, walletUsed), Math.max(0, refundAmount) - cashRefund);
  return { cashRefund, walletReturn };
}

// ─────────────────────────── DB 共用助手（多個取消路徑複用） ───────────────────────────

type Tx = Parameters<Parameters<ReturnType<typeof import("./queries/connection").getDb>["transaction"]>[0]>[0];

/**
 * 訂單取消／退款時返還購物金（要喺 caller 嘅 transaction 入面 call）。
 * 冪等鎖：orders.walletReturnedAt——conditional update 郁到先返，第二次 call 郁 0 行 → 唔會返兩次。
 * 返咗幾多就回幾多（0＝冇得返／已返過）。walletUsed=0 嘅單即刻回 0 唔郁 DB。
 */
export async function returnWalletForOrder(
  tx: Tx,
  order: { id: number; orderNo: string; userId: number | null; walletUsed: number },
  note: string,
): Promise<number> {
  if (order.walletUsed <= 0 || order.userId == null) return 0;
  const [locked] = await tx
    .update(orders)
    .set({ walletReturnedAt: new Date() })
    .where(and(eq(orders.id, order.id), isNull(orders.walletReturnedAt)))
    .returning({ walletUsed: orders.walletUsed });
  if (!locked || locked.walletUsed <= 0) return 0;
  const amount = locked.walletUsed;
  const [u] = await tx
    .update(users)
    .set({ storeCredit: sql`${users.storeCredit} + ${amount}` })
    .where(eq(users.id, order.userId))
    .returning({ storeCredit: users.storeCredit });
  if (!u) {
    throw new Error(`返還購物金失敗：搵唔到會員 #${order.userId}`);
  }
  await tx.insert(walletLedger).values({
    userId: order.userId,
    type: "refund",
    amount,
    balanceAfter: u.storeCredit,
    refType: "order",
    refId: order.orderNo,
    note,
  });
  return amount;
}

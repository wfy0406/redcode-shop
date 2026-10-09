/**
 * 訪客購買（Guest Checkout，2026-10-09）共用純函數／工具——
 * 抽出嚟唔曳 DB，等 vitest 可以直踩核心規則（電話 normalize／token 比對／rate limit／免運判定）。
 * 業務規則口徑同 api/vip.ts 檔頭一致：訪客單 region 固定 HK、冇 VIP、唔收優惠碼；
 * 免運得「滿額＋自取點」一條路（送貨上門永遠到付）。
 */
import { timingSafeEqual } from "node:crypto";
import type { DeliveryMethod, ShippingRules } from "./vip";
import { toContractMethod } from "./vip";

/** 訪客單付款保留期：落單起 30 分鐘（過期 orderSweeper 自動取消＋回庫存） */
export const GUEST_ORDER_TTL_MS = 30 * 60 * 1000;

/** 訪客查單／付款嘅統一錯誤訊息（唔好分開話邊樣錯，防單號枚舉偷睇） */
export const GUEST_LOOKUP_FAIL_MESSAGE = "搵唔到呢張訂單，請核對訂單編號同電話號碼";

/**
 * 香港電話 normalize：接受 8 位數字，可帶 +852／852 前綴同空格／dash。
 * 回傳純 8 位數字字串；格式唔啱回 null（caller 轉 BAD_REQUEST）。
 */
export function normalizeGuestPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("852") ? digits.slice(3) : digits;
  if (!/^\d{8}$/.test(local)) return null;
  return local;
}

/**
 * 會員單查單嘅電話比對（2026-10-09 查單擴展）：
 * 會員註冊時電話 normalize 做 8 位本地號，但舊數據可能存咗 852 前綴版（authRouter phoneLookupVariants 同款規則）。
 * 輸入先 normalize；係 8 位就兩個變體都接受，否則齋比 trimmed 原文。
 */
export function memberPhoneMatches(storedPhone: string | null | undefined, rawInput: string): boolean {
  const stored = storedPhone?.trim();
  if (!stored) return false;
  const digits = rawInput.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("852") ? digits.slice(3) : digits;
  if (/^\d{8}$/.test(local)) {
    return stored === local || stored === `852${local}`;
  }
  return stored === rawInput.trim();
}

/**
 * guestToken 比對（constant-time）：uuid 長度固定，長度唔同即刻 fail；
 * 唔准用 ===（時序旁路會泄露前綴命中）。
 */
export function guestTokenEquals(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * 簡單 in-memory sliding window rate limiter（server 重啟清零可接受，契約 v1.0 §1）：
 * 同一 key 喺 windowMs 內第 max+1 次起回 false。
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 回傳 true＝放行（兼記低今次）；false＝超限 */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(key, arr);
    // 防記憶體無限增長：間中掃走過期 key（bucket 細，O(n) 冇所謂）
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        const fresh = v.filter((x) => x > cutoff);
        if (fresh.length === 0) this.hits.delete(k);
        else this.hits.set(k, fresh);
      }
    }
    return true;
  }
}

/** 取客戶端 IP（rate limit key 用）：proxy 後嘅 x-forwarded-for 第一個，fallback x-real-ip */
export function clientIpFromRequest(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface GuestShippingDecision {
  shippingFree: boolean;
  /** 系統備註（同會員單 remark 同款字句，分號分隔落 orders.remark → WMS） */
  remarks: string[];
}

/**
 * 訪客單免運判定（region 固定 HK；vip.ts 檔頭規則嘅訪客子集）：
 *  ① 送貨上門 → 永遠到付「送貨上門・運費到付」
 *  ② method ∈ freeMethods 且小計 ≥ freeThresholdCents（預設 $350）→ 免運
 *  ③ 其餘 → 順豐到付
 * （訪客冇 VIP，冇「金會員全年免運」分支；澳門／國外單唔喺訪客流程出現）
 */
export function decideGuestShipping(
  rules: ShippingRules,
  method: DeliveryMethod,
  subtotalCents: number,
): GuestShippingDecision {
  const contractMethod = toContractMethod(method);
  if (contractMethod === "HOME") {
    return { shippingFree: false, remarks: ["送貨上門・運費到付"] };
  }
  if (rules.freeMethods.includes(contractMethod) && subtotalCents >= rules.freeThresholdCents) {
    const thresholdDollars = rules.freeThresholdCents / 100;
    const methodLabel = contractMethod === "SF_STATION" ? "順豐站" : "智能櫃";
    return {
      shippingFree: true,
      remarks: [`消費滿$${thresholdDollars}・${methodLabel}免運`],
    };
  }
  return { shippingFree: false, remarks: ["順豐到付"] };
}

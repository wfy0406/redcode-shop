/**
 * 訪客購買工具函數單元測試（2026-10-09）
 * 覆蓋契約 v1.0 關鍵安全不變量：
 *  - 電話 normalize（852 前綴／空格／dash／唔啱格式）
 *  - guestToken constant-time 比對（長度唔同即刻 fail；相同先 true）
 *  - RateLimiter sliding window（第 max+1 次起擋；窗口過咗放行；key 隔離）
 *  - 統一查單失敗訊息存在（防枚舉用字句唔可以改甩）
 *  - 訪客運費判定（上門永遠到付／滿額免運／唔夠額到付）
 */
import { describe, expect, it } from "vitest";
import {
  GUEST_LOOKUP_FAIL_MESSAGE,
  GUEST_ORDER_TTL_MS,
  RateLimiter,
  decideGuestShipping,
  guestTokenEquals,
  memberPhoneMatches,
  normalizeGuestPhone,
} from "./guestUtils";
import type { ShippingRules } from "./vip";

describe("normalizeGuestPhone", () => {
  it("接受純 8 位數字", () => {
    expect(normalizeGuestPhone("91234567")).toBe("91234567");
  });
  it("接受 +852／852 前綴", () => {
    expect(normalizeGuestPhone("+852 9123 4567")).toBe("91234567");
    expect(normalizeGuestPhone("852-9123-4567")).toBe("91234567");
  });
  it("reject 唔啱長度／字母", () => {
    expect(normalizeGuestPhone("9123456")).toBeNull(); // 7 位
    expect(normalizeGuestPhone("912345678")).toBeNull(); // 9 位
    expect(normalizeGuestPhone("abcd")).toBeNull();
    expect(normalizeGuestPhone("")).toBeNull();
  });
});

describe("memberPhoneMatches（會員單查單電話比對）", () => {
  it("8 位本地號直接中", () => {
    expect(memberPhoneMatches("91234567", "91234567")).toBe(true);
  });
  it("輸入帶 852／+852／空格都中", () => {
    expect(memberPhoneMatches("91234567", "85291234567")).toBe(true);
    expect(memberPhoneMatches("91234567", "+852 9123 4567")).toBe(true);
  });
  it("舊數據存咗 852 前綴都中（變體比對）", () => {
    expect(memberPhoneMatches("85291234567", "91234567")).toBe(true);
  });
  it("唔同號碼／空值 reject", () => {
    expect(memberPhoneMatches("91234567", "91234568")).toBe(false);
    expect(memberPhoneMatches(null, "91234567")).toBe(false);
    expect(memberPhoneMatches(undefined, "91234567")).toBe(false);
    expect(memberPhoneMatches("", "91234567")).toBe(false);
  });
  it("非 8 位輸入：齋比 trimmed 原文（海外號兼容）", () => {
    expect(memberPhoneMatches(" 8613800138000 ", "8613800138000")).toBe(true);
    expect(memberPhoneMatches("8613800138000", "8613800138001")).toBe(false);
  });
});

describe("guestTokenEquals", () => {
  const tok = "123e4567-e89b-42d3-a456-426614174000";
  it("相同 token 回 true", () => {
    expect(guestTokenEquals(tok, tok)).toBe(true);
  });
  it("唔同 token／長度唔同／空字串回 false", () => {
    expect(guestTokenEquals(tok, "123e4567-e89b-42d3-a456-426614174001")).toBe(false);
    expect(guestTokenEquals(tok, "short")).toBe(false);
    expect(guestTokenEquals("", "")).toBe(false);
    expect(guestTokenEquals(tok, "")).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("第 max+1 次起擋", () => {
    const rl = new RateLimiter(3, 60_000);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
    expect(rl.allow("k")).toBe(false);
  });
  it("窗口過咗會放行", () => {
    let t = 1_000_000;
    const rl = new RateLimiter(2, 60_000, () => t);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
    t += 61_000; // 行入下一個窗口
    expect(rl.allow("k")).toBe(true);
  });
  it("唔同 key 互唔影響", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.allow("b")).toBe(true);
  });
});

describe("查單安全不變量", () => {
  it("統一失敗訊息（防單號枚舉）", () => {
    expect(GUEST_LOOKUP_FAIL_MESSAGE).toContain("搵唔到呢張訂單");
  });
  it("付款保留期係 30 分鐘", () => {
    expect(GUEST_ORDER_TTL_MS).toBe(30 * 60 * 1000);
  });
});

describe("decideGuestShipping", () => {
  const rules: ShippingRules = {
    freeThresholdCents: 35000,
    freeMethods: ["SF_STATION", "SF_LOCKER"],
    goldVipFreeMethods: [],
  };
  it("送貨上門永遠到付（夠額都唔免）", () => {
    const d = decideGuestShipping(rules, "address", 999_900);
    expect(d.shippingFree).toBe(false);
    expect(d.remarks[0]).toContain("到付");
  });
  it("順豐站滿 $350 免運", () => {
    const d = decideGuestShipping(rules, "sf_station", 35000);
    expect(d.shippingFree).toBe(true);
    expect(d.remarks[0]).toContain("免運");
  });
  it("智能櫃滿額免運；唔夠額到付", () => {
    expect(decideGuestShipping(rules, "sf_locker", 35000).shippingFree).toBe(true);
    const d = decideGuestShipping(rules, "sf_locker", 34999);
    expect(d.shippingFree).toBe(false);
    expect(d.remarks[0]).toContain("順豐到付");
  });
});

/**
 * LoginFailTracker 單元測試（H1 安全修復，2026-10-24）——唔依賴真 DB。
 * 覆蓋安全不變量：
 *  - 失敗計數真正累加（舊 bug：次次重設做 1，10 次鎖永不觸發）
 *  - 第 10 次失敗起鎖 15 分鐘，期間 lockedUntil 有值
 *  - 鎖過期後重計；未夠 10 次唔鎖
 *  - 成功登入 reset 清零（之後重新計）
 *  - 過期 entry 清理：鎖緊／活躍失敗緊嘅 entry 唔會被掃走
 */
import { describe, expect, it } from "vitest";
import { LOGIN_FAIL_LIMIT, LOGIN_LOCK_MS, LoginFailTracker } from "./loginFailTracker";

describe("LoginFailTracker", () => {
  it("失敗計數累加，第 10 次先鎖（舊 bug 係次次重設做 1）", () => {
    const t = 1_000_000;
    const tracker = new LoginFailTracker(() => t);
    for (let i = 1; i < LOGIN_FAIL_LIMIT; i++) {
      tracker.recordFail("91234567");
      expect(tracker.lockedUntil("91234567")).toBeNull(); // 未夠 10 次唔鎖
    }
    tracker.recordFail("91234567"); // 第 10 次
    expect(tracker.lockedUntil("91234567")).toBe(t + LOGIN_LOCK_MS);
  });

  it("鎖定期內一直保持鎖定；過咗 15 分鐘先解", () => {
    let t = 1_000_000;
    const tracker = new LoginFailTracker(() => t);
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) tracker.recordFail("91234567");
    t += LOGIN_LOCK_MS - 1; // 差 1ms 先過期
    expect(tracker.lockedUntil("91234567")).not.toBeNull();
    t += 1; // 啱啱過期
    expect(tracker.lockedUntil("91234567")).toBeNull();
  });

  it("鎖過期後再失敗由 1 重計（唔會即刻又鎖）", () => {
    let t = 1_000_000;
    const tracker = new LoginFailTracker(() => t);
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) tracker.recordFail("91234567");
    t += LOGIN_LOCK_MS; // 鎖過期
    tracker.recordFail("91234567");
    expect(tracker.lockedUntil("91234567")).toBeNull(); // 重新計第 1 次，唔鎖
  });

  it("成功登入 reset 清零", () => {
    const t = 1_000_000;
    const tracker = new LoginFailTracker(() => t);
    for (let i = 0; i < LOGIN_FAIL_LIMIT - 1; i++) tracker.recordFail("91234567");
    tracker.reset("91234567"); // 成功登入
    for (let i = 0; i < LOGIN_FAIL_LIMIT - 1; i++) tracker.recordFail("91234567");
    expect(tracker.lockedUntil("91234567")).toBeNull(); // 重新計嘅 9 次唔鎖
  });

  it("唔同帳號 key 互唔影響", () => {
    const tracker = new LoginFailTracker(() => 1_000_000);
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) tracker.recordFail("91234567");
    expect(tracker.lockedUntil("91234567")).not.toBeNull();
    expect(tracker.lockedUntil("98765432")).toBeNull();
  });

  it("爆煲清理：過期閒置 entry 被掃走，活躍失敗緊嘅 entry 保留", () => {
    let t = 1_000_000;
    const tracker = new LoginFailTracker(() => t);
    // 一個差一次就鎖嘅舊 key＋一個鎖定中嘅 key
    for (let i = 0; i < LOGIN_FAIL_LIMIT - 1; i++) tracker.recordFail("stale-nine");
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) tracker.recordFail("locked-user");
    // 好耐冇人再郁（舊 key 閒置晒，locked-user 嘅鎖都過埋期）
    t += LOGIN_LOCK_MS * 2;
    // 涌入 5010 個新 key 觸發清理
    for (let i = 0; i < 5010; i++) tracker.recordFail(`fresh-${i}`);
    // 過期閒置嘅 stale-nine 已連同 9 次計數被掃走 → 重新計，9 次唔鎖
    for (let i = 0; i < LOGIN_FAIL_LIMIT - 1; i++) tracker.recordFail("stale-nine");
    expect(tracker.lockedUntil("stale-nine")).toBeNull();
    // 活躍嘅 fresh key 冇被清理影響：fresh-1 喺涌入時已計 1 次，再失敗 8 次（共 9 次）唔鎖，第 10 次先鎖
    for (let i = 0; i < LOGIN_FAIL_LIMIT - 2; i++) tracker.recordFail("fresh-1");
    expect(tracker.lockedUntil("fresh-1")).toBeNull();
    tracker.recordFail("fresh-1");
    expect(tracker.lockedUntil("fresh-1")).not.toBeNull();
  });
});

/**
 * R13（2026-11-19 安全修復）：Airwallex webhook 時效窗＋event 去重測試。
 *
 * 原始漏洞：verifyWebhookSignature 只驗 HMAC，冇 timestamp 新鮮度檢查——
 * 任何人攞到一個舊嘅合法簽名 webhook（例如 log 洩漏），可以無限期 replay。
 * 修復後：isWebhookTimestampFresh 擋舊／未來／非數字 timestamp；
 * WebhookEventDeduper 擋同一 event id 重複派送（官方 retry 語意：同一 id）。
 *
 * 合法流程保留：24h 預設窗內嘅合法 retry 照常入；業務冪等（conditional update）
 * 喺 boot.ts handler，唔喺呢度測（需要 DB）。
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS,
  WebhookEventDeduper,
  isWebhookTimestampFresh,
  processWebhookEvent,
  verifyWebhookSignature,
  webhookTimestampToleranceMs,
} from "./airwallex";

const SECRET = "test-webhook-secret"; // 測試專用 fixture，唔係真 secret

function sign(timestamp: string, rawBody: string): string {
  return createHmac("sha256", SECRET).update(timestamp).update(rawBody).digest("hex");
}

describe("verifyWebhookSignature（原有行為保留）", () => {
  const body = JSON.stringify({ id: "evt_1", name: "payment_intent.succeeded" });
  it("合法簽名通過；錯 secret／改 body／錯簽名拒絕", () => {
    const ts = String(Date.now());
    const good = sign(ts, body);
    expect(verifyWebhookSignature(SECRET, ts, good, body)).toBe(true);
    expect(verifyWebhookSignature("wrong-secret", ts, good, body)).toBe(false);
    expect(verifyWebhookSignature(SECRET, ts, good, body + " ")).toBe(false);
    expect(verifyWebhookSignature(SECRET, ts, "0".repeat(64), body)).toBe(false);
    expect(verifyWebhookSignature("", ts, good, body)).toBe(false);
    expect(verifyWebhookSignature(SECRET, "", good, body)).toBe(false);
  });
  it("timestamp 係簽名覆蓋範圍：改 timestamp 簽名即唔啱", () => {
    const ts = String(Date.now());
    const good = sign(ts, body);
    expect(verifyWebhookSignature(SECRET, String(Date.now() + 1), good, body)).toBe(false);
  });
});

describe("isWebhookTimestampFresh（R13 新時效窗）", () => {
  const now = Date.now();
  it("★ 原始漏洞：舊 timestamp（超出容忍窗）被拒", () => {
    const stale = String(now - DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS - 60_000);
    expect(isWebhookTimestampFresh(stale, now)).toBe(false);
  });
  it("★ 大幅未來 timestamp 一樣被拒（異常）", () => {
    const future = String(now + DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_MS + 60_000);
    expect(isWebhookTimestampFresh(future, now)).toBe(false);
  });
  it("合法流程：而家／窗內嘅 timestamp 通過（合法 retry 唔會被截停）", () => {
    expect(isWebhookTimestampFresh(String(now), now)).toBe(true);
    // 23 小時前嘅 retry 仍然喺 24h 窗內
    expect(isWebhookTimestampFresh(String(now - 23 * 60 * 60 * 1000), now)).toBe(true);
    // 5 分鐘輕微 clock skew（未來方向）都通過
    expect(isWebhookTimestampFresh(String(now + 5 * 60 * 1000), now)).toBe(true);
  });
  it("非數字／空字串／負數／畸形 timestamp 拒絕", () => {
    expect(isWebhookTimestampFresh("", now)).toBe(false);
    expect(isWebhookTimestampFresh("abc", now)).toBe(false);
    expect(isWebhookTimestampFresh("-123", now)).toBe(false);
    expect(isWebhookTimestampFresh("1712345678.9", now)).toBe(false);
    expect(isWebhookTimestampFresh(" 1712345678000 ", now)).toBe(false);
  });
  it("自訂容忍窗生效（staging 核實後可收緊做 5 分鐘）", () => {
    const fiveMin = 5 * 60 * 1000;
    expect(isWebhookTimestampFresh(String(now - 6 * 60 * 1000), now, fiveMin)).toBe(false);
    expect(isWebhookTimestampFresh(String(now - 4 * 60 * 1000), now, fiveMin)).toBe(true);
  });
});

describe("webhookTimestampToleranceMs", () => {
  it("預設 24h；亂填 fail-safe 返預設；合法值照用", () => {
    expect(webhookTimestampToleranceMs({})).toBe(24 * 60 * 60 * 1000);
    expect(webhookTimestampToleranceMs({ AIRWALLEX_WEBHOOK_TOLERANCE_MS: "abc" })).toBe(24 * 60 * 60 * 1000);
    expect(webhookTimestampToleranceMs({ AIRWALLEX_WEBHOOK_TOLERANCE_MS: "0" })).toBe(24 * 60 * 60 * 1000);
    expect(webhookTimestampToleranceMs({ AIRWALLEX_WEBHOOK_TOLERANCE_MS: "300000" })).toBe(300_000);
  });
});

describe("WebhookEventDeduper（R13 event 去重）", () => {
  it("★ inflight 會擋並發重複；完成後同一 event id 仍然被拒", () => {
    const d = new WebhookEventDeduper();
    expect(d.claim("evt_abc")).toBe(true);
    expect(d.claim("evt_abc")).toBe(false);
    d.complete("evt_abc");
    expect(d.claim("evt_abc")).toBe(false);
  });
  it("★ 第一次 handler 失敗→同 event id 可成功 retry→成功後 duplicate 唔再處理", async () => {
    const d = new WebhookEventDeduper();
    let handlerCalls = 0;
    await expect(
      processWebhookEvent(d, "evt_retry", async () => {
        handlerCalls += 1;
        throw new Error("transient DB failure fixture");
      }),
    ).rejects.toThrow("transient DB failure fixture");
    expect(handlerCalls).toBe(1);

    const retry = await processWebhookEvent(d, "evt_retry", async () => {
      handlerCalls += 1;
      return "handled";
    });
    expect(retry).toEqual({ status: "processed", value: "handled" });
    expect(handlerCalls).toBe(2);

    const duplicate = await processWebhookEvent(d, "evt_retry", async () => {
      handlerCalls += 1;
      return "should-not-run";
    });
    expect(duplicate).toEqual({ status: "duplicate" });
    expect(handlerCalls).toBe(2);
  });
  it("失敗 release 只刪 inflight，唔會誤刪 completed", async () => {
    const d = new WebhookEventDeduper();
    d.claim("evt_done");
    d.complete("evt_done");
    d.release("evt_done");
    expect(d.claim("evt_done")).toBe(false);

    d.claim("evt_failed");
    d.release("evt_failed");
    expect(d.claim("evt_failed")).toBe(true);
  });
  it("唔同 event id 互唔影響（合法嘅新事件照入）", () => {
    const d = new WebhookEventDeduper();
    expect(d.claim("evt_1")).toBe(true);
    expect(d.claim("evt_2")).toBe(true);
  });
  it("空 id 唔阻（冇 id 嘅事件交業務層冪等兜底）", async () => {
    const d = new WebhookEventDeduper();
    expect(d.claim("")).toBe(true);
    expect(d.claim("")).toBe(true);
    expect(await processWebhookEvent(d, "", async () => "ok")).toEqual({
      status: "processed",
      value: "ok",
    });
  });
  it("超過 cap 會優先丟最舊已完成 entry，唔會無限增長", () => {
    const d = new WebhookEventDeduper(10);
    for (let i = 0; i < 10; i++) {
      expect(d.claim(`evt_${i}`)).toBe(true);
      d.complete(`evt_${i}`);
    }
    expect(d.claim("evt_new")).toBe(true); // 觸發丟棄最舊已完成 10%
    expect(d.claim("evt_new")).toBe(false); // 新 inflight 仍然記住
  });
});

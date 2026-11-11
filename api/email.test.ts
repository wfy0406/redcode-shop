import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_DISPATCH_POLICY } from "@contracts/publicPolicies";
import { sendOrderApprovedEmail, sendWelcomeEmail } from "./email";

/** 完全 mock transport：測試只驗證實際寄出 payload，唔會連 Resend 或任何外部服務。 */
describe("公開政策電郵", () => {
  const previousKey = process.env.RESEND_API_KEY;
  let payloads: Array<{ html: string; attachments?: Array<{ content: string }> }>;

  beforeEach(() => {
    process.env.RESEND_API_KEY = "isolated-test-key";
    payloads = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body: string }) => {
      payloads.push(JSON.parse(init.body));
      return { ok: true };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousKey == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
  });

  it("訂單確認信實際 HTML 用統一寄出說明，唔再寫死 7-10 日內", async () => {
    const result = await sendOrderApprovedEmail({
      to: "customer@example.test",
      name: "測試客人",
      orderNo: "RC-TEST-001",
      createdAt: new Date("2026-11-11T00:00:00Z"),
      items: [{ productName: "測試上衣", size: "M", price: 199, quantity: 1, originalPrice: 199 }],
      total: 199,
      discountAmount: 0,
      delivery: { method: "sf_station", pickupPoint: "測試站", address: null },
    });
    expect(result).toEqual({ ok: true });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].html).toContain(PUBLIC_DISPATCH_POLICY.emailText);
    expect(payloads[0].html).toContain("部分商品或需更久");
    expect(payloads[0].html).toContain("寄出時間唔等於送達保證");
    expect(payloads[0].html).not.toContain("7-10 個工作天</b>內寄出");
  }, 20_000);

  it("迎新信實際 HTML 唔承諾每晚開播", async () => {
    const result = await sendWelcomeEmail({ to: "member@example.test", name: "測試會員" });
    expect(result).toEqual({ ok: true });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].html).toContain("Glo Glo 會喺 Facebook 直播");
    expect(payloads[0].html).not.toContain("每晚");
    expect(payloads[0].html).not.toContain("今晚直播見");
  });
});

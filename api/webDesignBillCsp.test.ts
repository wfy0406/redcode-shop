// v2026.11.13.2：Airwallex 官方 Components SDK 二段載入 CSP 防回歸。
// 真 script init 由隔離 browser QA 驗；呢度確保正式 boot CSP 唔會再漏必要 host。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bootSource = readFileSync(new URL("./boot.ts", import.meta.url), "utf8");

describe("公開單據 Airwallex CSP", () => {
  it("script-src 涵蓋官方入口及 prod/demo 後續 payments bundle", () => {
    for (const host of [
      "https://static.airwallex.com",
      "https://static-demo.airwallex.com",
      "https://checkout.airwallex.com",
      "https://checkout-demo.airwallex.com",
    ]) {
      expect(bootSource).toContain(host);
    }
    expect(bootSource).toContain("Airwallex Components SDK 入口會按 env 再載入");
  });

  it("connect-src 保留收款 API 並容許官方 prod/demo telemetry", () => {
    for (const host of [
      "https://api.airwallex.com",
      "https://api-demo.airwallex.com",
      "https://o11y.airwallex.com",
      "https://o11y-demo.airwallex.com",
    ]) {
      expect(bootSource).toContain(host);
    }
    expect(bootSource).not.toContain("default-src *");
    expect(bootSource).not.toContain("script-src *");
  });
});

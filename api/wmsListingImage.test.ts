/**
 * S06（2026-11-19 安全修復）：WMS 上架圖片真身驗證。
 *
 * 原始漏洞：POST /api/wms/listing-image 同 downloadListingImage 淨信
 * client／上游報嘅 MIME——偽裝 image/png 嘅 HTML／script 會原樣寫落 uploads，
 * 再經 /uploads/:file 以 image/* content-type 送出（stored-XSS／供應鏈植入面）。
 *
 * 修復後：verifyRealImage 用 sharp 讀真檔頭（limitInputPixels 擋解壓炸彈），
 * reencodeVerifiedImage re-encode 剝 metadata；假圖一律拒絕（fail-closed）。
 *
 * 合法流程覆蓋：真 jpeg/png/webp 照過，re-encode 後格式不變、ext 正確。
 */
import { describe, expect, it } from "vitest";
import { reencodeVerifiedImage, verifyRealImage } from "./wmsListing";

// 用 sharp 即場整真圖 fixture（唔依賴 repo 入面嘅圖）
async function makeRealImage(format: "jpeg" | "png" | "webp"): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const base = sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
  });
  if (format === "jpeg") return base.jpeg().toBuffer();
  if (format === "png") return base.png().toBuffer();
  return base.webp().toBuffer();
}

describe("verifyRealImage（S06）", () => {
  it("合法流程：真 jpeg／png／webp 全部通過，格式認得啱", async () => {
    for (const [fmt, expected] of [
      ["jpeg", "jpeg"],
      ["png", "png"],
      ["webp", "webp"],
    ] as const) {
      const v = await verifyRealImage(await makeRealImage(fmt));
      expect(v).not.toBeNull();
      expect(v!.format).toBe(expected);
    }
  });
  it("★ 原始漏洞：偽裝 MIME 嘅 HTML／script 被拒", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(await verifyRealImage(html)).toBeNull();
  });
  it("★ 得個 PNG magic header 嘅假圖被拒", async () => {
    const fakePng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("not a real png payload"),
    ]);
    expect(await verifyRealImage(fakePng)).toBeNull();
  });
  it("★ GIF／SVG 等唔喺白名單嘅格式拒絕（白名單得 jpeg/png/webp）", async () => {
    const gif89a = Buffer.from("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\x00\x00\x00\x21\xf9\x04\x00\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b", "latin1");
    expect(await verifyRealImage(gif89a)).toBeNull();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await verifyRealImage(svg)).toBeNull();
  });
  it("空 buffer／亂碼拒絕", async () => {
    expect(await verifyRealImage(Buffer.alloc(0))).toBeNull();
    expect(await verifyRealImage(Buffer.from([1, 2, 3, 4, 5]))).toBeNull();
  });
});

describe("reencodeVerifiedImage（S06）", () => {
  it("re-encode 後格式不變、ext 對應、輸出係有效圖", async () => {
    for (const [fmt, ext] of [
      ["jpeg", ".jpg"],
      ["png", ".png"],
      ["webp", ".webp"],
    ] as const) {
      const v = await verifyRealImage(await makeRealImage(fmt));
      const out = await reencodeVerifiedImage(v!);
      expect(out.ext).toBe(ext);
      expect(out.buffer.length).toBeGreaterThan(0);
      // re-encode 出嚟嘅都係真圖（再驗一次都過）
      const again = await verifyRealImage(out.buffer);
      expect(again).not.toBeNull();
      expect(again!.format).toBe(fmt);
    }
  });
  it("re-encode 剝走 EXIF metadata（GPS 等私隱資料唔會留喺貨圖）", async () => {
    const sharp = (await import("sharp")).default;
    const withExif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .withMetadata({ exif: { IFD0: { ImageDescription: "secret-note" } } })
      .toBuffer();
    const v = await verifyRealImage(withExif);
    expect(v).not.toBeNull();
    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeTruthy();
    const out = await reencodeVerifiedImage(v!);
    const after = await sharp(out.buffer).metadata();
    expect(after.exif).toBeUndefined();
  });
});

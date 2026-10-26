import { describe, expect, it } from "vitest";
import {
  buildTryOnShareText,
  buildTryOnWhatsAppUrl,
  latestTryOnAttemptsByStep,
  resolveTryOnProductKind,
  type TryOnShareProduct,
} from "../contracts/tryon";

describe("試穿商品資格及精細穿著部位", () => {
  it.each([
    ["top", "短款外套", "top"],
    ["pants", "闊腳褲", "pants"],
    ["dress", "連身裙", "dress"],
    ["shoes", "皮鞋", "shoes"],
    ["accessory", "925 銀介指", "ring"],
    ["accessory", "寶石指介（Blue）", "ring"],
    ["accessory", "B1特別款限量泰迪比熊造型套鍊", "necklace"],
    ["accessory", "頸鍊", "necklace"],
    ["accessory", "珍珠耳釘", "earrings"],
    ["accessory", "手鐲", "bracelet"],
    ["accessory", "BIGSALE02 手鍊", "bracelet"],
  ] as const)("%s／%s → %s", (category, name, expected) => {
    expect(resolveTryOnProductKind(category, name)).toBe(expected);
  });

  it.each([
    ["top", "LU8"],
    ["pants", "P-2026"],
    ["dress", "D-01"],
    ["shoes", "S-99"],
  ] as const)("衣著按 category 通過，唔靠品名關鍵字：%s／%s", (category, name) => {
    expect(resolveTryOnProductKind(category, name)).toBe(category);
  });

  it.each(["lifestyle", "skincare", "other"])("非穿著類別 %s 完全不可試穿", (category) => {
    expect(resolveTryOnProductKind(category, "戒指造型護膚套裝")).toBeNull();
  });

  it.each([
    "時尚飾品",
    "寶石高貴風手錶（Red）",
    "戒指耳環套裝",
    "頸鏈及手鏈兩件裝",
    "戒指收納盒",
    "首飾盒",
    "耳環展示架",
    "銀器清潔劑",
    "抹銀布",
    "jewelry cleaning kit",
  ])("含糊、混合或非穿戴飾品會拒絕：%s", (name) => {
    expect(resolveTryOnProductKind("accessory", name)).toBeNull();
  });
});

describe("同一步失敗重試嘅對外造型清單", () => {
  it("每一步只保留最新 attempt，舊失敗紀錄唔會變成第三件商品", () => {
    const rows = [
      { id: 10, stepNumber: 1, status: "completed", productId: 101 },
      { id: 11, stepNumber: 2, status: "failed", productId: 202 },
      { id: 12, stepNumber: 2, status: "completed", productId: 202 },
    ];
    expect(latestTryOnAttemptsByStep(rows)).toEqual([rows[0], rows[2]]);
  });

  it("兩件分享只列最新成功商品，兩組品名／貨號／價錢／公開網址", () => {
    const latest = latestTryOnAttemptsByStep([
      {
        id: 10, stepNumber: 1, status: "completed", productId: 101,
        productName: "短款牛仔外套", productSku: "TOP-101", productPrice: 599, productDiscountPrice: 499,
      },
      {
        id: 11, stepNumber: 2, status: "failed", productId: 999,
        productName: "舊失敗商品", productSku: "OLD-999", productPrice: 1, productDiscountPrice: null,
      },
      {
        id: 12, stepNumber: 2, status: "completed", productId: 202,
        productName: "高腰長褲", productSku: "PANTS-202", productPrice: 399, productDiscountPrice: null,
      },
    ]);
    const completed: TryOnShareProduct[] = latest.filter((row) => row.status === "completed");
    const text = buildTryOnShareText(completed, "https://redcode.red/");

    expect(completed).toHaveLength(2);
    expect(text).toContain("RedCode AI 試穿預覽");
    expect(text).toContain("以下 2 件商品嘅 AI 穿著效果");
    expect(text).toContain("1. 短款牛仔外套");
    expect(text).toContain("貨號：TOP-101");
    expect(text).toContain("價錢：優惠價 HK$499（原價 HK$599）");
    expect(text).toContain("商品網址：https://redcode.red/products/101");
    expect(text).toContain("2. 高腰長褲");
    expect(text).toContain("貨號：PANTS-202");
    expect(text).toContain("價錢：HK$399");
    expect(text).toContain("商品網址：https://redcode.red/products/202");
    expect(text).toContain("唔代表實際尺碼、鬆緊、合身程度或舒適度");
    expect(text).not.toContain("舊失敗商品");
    expect(text).not.toContain("/api/tryon/media/");
    expect(text).not.toContain("signed");
  });

  it("WhatsApp fallback 帶兩件完整商品資料及公開網址，但唔帶私人結果圖", () => {
    const products: TryOnShareProduct[] = [
      {
        productId: 101,
        productName: "短款牛仔外套",
        productSku: "TOP-101",
        productPrice: 599,
        productDiscountPrice: 499,
      },
      {
        productId: 202,
        productName: "高腰長褲",
        productSku: "PANTS-202",
        productPrice: 399,
        productDiscountPrice: null,
      },
    ];
    const url = buildTryOnWhatsAppUrl(products, "https://redcode.red/");
    expect(url.startsWith("https://wa.me/?text=")).toBe(true);
    const text = decodeURIComponent(url.slice("https://wa.me/?text=".length));
    expect(text).toContain("RedCode AI 試穿預覽");
    expect(text).toContain("1. 短款牛仔外套");
    expect(text).toContain("貨號：TOP-101");
    expect(text).toContain("優惠價 HK$499（原價 HK$599）");
    expect(text).toContain("商品網址：https://redcode.red/products/101");
    expect(text).toContain("2. 高腰長褲");
    expect(text).toContain("貨號：PANTS-202");
    expect(text).toContain("價錢：HK$399");
    expect(text).toContain("商品網址：https://redcode.red/products/202");
    expect(text).toContain("唔代表實際尺碼、鬆緊、合身程度或舒適度");
    expect(text).not.toContain("/api/tryon/media/");
    expect(text).not.toContain("signature=");
  });

  it("一件商品同樣註明係 AI 試穿；使用生成時價錢快照", () => {
    const text = buildTryOnShareText([{
      productId: 7,
      productName: "商品快照",
      productSku: "SNAP-7",
      productPrice: 888,
      productDiscountPrice: null,
    }], "https://redcode.red");
    expect(text).toContain("以下 1 件商品嘅 AI 穿著效果");
    expect(text).toContain("HK$888");
    expect(text).toContain("AI 試穿視覺預覽");
  });
});

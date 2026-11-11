/**
 * 商品公開事實 mapper 純函數測試（v2026.11.11 一致性）——唔掂 DB。
 * 重點：google category 明確 mapping、折扣口徑、相簿、尺寸開關、
 * Feed 描述行 contracts 同一份清理／截斷規則。
 */
import { describe, expect, it } from "vitest";
import {
  googleProductCategoryId,
  productEffectivePrice,
  productFeedDescription,
  productFeedTitle,
  productImageUrls,
  productInStock,
  productSalePrice,
  productSizeOptions,
  productTypeLabel,
  type ProductPublicRow,
} from "./productPublicFacts";

const base: ProductPublicRow = {
  id: 85,
  name: "067",
  description: "星空閃石上衣。",
  sku: "SKU-067",
  category: "top",
  price: 299,
  discountPrice: 199,
  stock: 5,
  image: "/uploads/p85.jpg",
  photos: ["/uploads/p85.jpg", "/uploads/p85b.jpg"],
  sizes: "S,M,L",
  sizeEnabled: true,
};

describe("googleProductCategoryId — 內部 8 類明確 mapping", () => {
  it("服裝類對到官方 taxonomy ID", () => {
    expect(googleProductCategoryId("top")).toBe("212"); // Shirts & Tops
    expect(googleProductCategoryId("pants")).toBe("204"); // Pants
    expect(googleProductCategoryId("dress")).toBe("2271"); // Dresses
    expect(googleProductCategoryId("shoes")).toBe("187"); // Shoes
    expect(googleProductCategoryId("accessory")).toBe("166"); // 飾物 → 上層 Apparel & Accessories（唔猜細類）
    expect(googleProductCategoryId("lifestyle")).toBe("536"); // Home & Garden
    expect(googleProductCategoryId("skincare")).toBe("567"); // Skin Care
  });

  it("other／未知／null → null（Feed 省略，唔亂套 166）", () => {
    expect(googleProductCategoryId("other")).toBeNull();
    expect(googleProductCategoryId("乜都唔係")).toBeNull();
    expect(googleProductCategoryId(null)).toBeNull();
    expect(googleProductCategoryId(undefined)).toBeNull();
  });
});

describe("productTypeLabel — product_type 用真內部分類", () => {
  it("同商品頁可見分類 label 一致；未知當其他", () => {
    expect(productTypeLabel("top")).toBe("上衣");
    expect(productTypeLabel("skincare")).toBe("護膚品");
    expect(productTypeLabel("other")).toBe("其他");
    expect(productTypeLabel("乜都唔係")).toBe("其他");
  });
});

describe("折扣／售價／庫存口徑", () => {
  it("真折扣（discountPrice < price）先出折扣價", () => {
    expect(productSalePrice(base)).toBe(199);
    expect(productEffectivePrice(base)).toBe(199);
  });

  it("壞折扣（折扣仲貴過原價／等價／null）當冇折扣", () => {
    expect(productSalePrice({ ...base, discountPrice: 399 })).toBeNull();
    expect(productSalePrice({ ...base, discountPrice: 299 })).toBeNull();
    expect(productSalePrice({ ...base, discountPrice: null })).toBeNull();
    expect(productEffectivePrice({ ...base, discountPrice: 399 })).toBe(299);
    expect(productEffectivePrice({ ...base, discountPrice: null })).toBe(299);
  });

  it("stock > 0 先有貨", () => {
    expect(productInStock(base)).toBe(true);
    expect(productInStock({ ...base, stock: 0 })).toBe(false);
  });
});

describe("productImageUrls — 真 photos 相簿", () => {
  it("photos 非空用晒成個相簿並轉絕對 URL；首張＝封面", () => {
    expect(productImageUrls(base, "https://redcode.red")).toEqual([
      "https://redcode.red/uploads/p85.jpg",
      "https://redcode.red/uploads/p85b.jpg",
    ]);
  });

  it("photos 空／null 淨用 image；已絕對 URL 唔再加 origin", () => {
    expect(
      productImageUrls({ ...base, photos: null }, "https://redcode.red"),
    ).toEqual(["https://redcode.red/uploads/p85.jpg"]);
    expect(
      productImageUrls(
        { ...base, photos: [], image: "https://cdn.example.com/x.jpg" },
        "https://redcode.red",
      ),
    ).toEqual(["https://cdn.example.com/x.jpg"]);
  });
});

describe("productSizeOptions — 尺寸選項係真欄位", () => {
  it("sizeEnabled=true split 逗號、trim、去空", () => {
    expect(productSizeOptions(base)).toEqual(["S", "M", "L"]);
    expect(productSizeOptions({ ...base, sizes: " S , , L " })).toEqual(["S", "L"]);
  });

  it("sizeEnabled=false／冇 sizes → 空（唔虛構尺寸）", () => {
    expect(productSizeOptions({ ...base, sizeEnabled: false })).toEqual([]);
    expect(productSizeOptions({ ...base, sizes: null })).toEqual([]);
  });
});

describe("Feed 描述／標題 — 同 contracts 同一份清理截斷", () => {
  it("有描述：剝 HTML／emoji／控制碼做純文字", () => {
    expect(
      productFeedDescription({ ...base, description: "<p>靚衫✨</p>\n<b>必買</b>" }),
    ).toBe("靚衫 必買");
  });

  it("無描述：用真貨號／分類／價錢／庫存補強，唔係模板假內容", () => {
    const d = productFeedDescription({ ...base, description: null });
    expect(d).toContain("067｜上衣｜貨號 SKU-067｜HK$199｜現貨 5 件");
    expect(d).not.toBe("067｜RedCode 香港女裝直播");
  });

  it("title 截斷補「…」唔硬切（同其他出口一致）", () => {
    const long = "衫".repeat(200);
    const t = productFeedTitle({ ...base, name: long });
    expect(t).toHaveLength(150);
    expect(t.endsWith("…")).toBe(true);
  });
});

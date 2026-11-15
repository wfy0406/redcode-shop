import { describe, expect, it } from "vitest";
import { plainProductSeoText, productLiveSessionLabel, productSeoDescription, productSeoTitle } from "@contracts/types";

const product = {
  name: "復古牛仔外套",
  description: null,
  sku: "SKU-251",
  category: "top",
  price: 299,
  discountPrice: 199,
  stock: 5,
};

describe("商品 SEO 描述共用規則", () => {
  it("冇描述時用真品名、貨號、分類、折扣價同庫存，唔寫空泛通用句", () => {
    const text = productSeoDescription(product, 300);
    expect(text).toContain("復古牛仔外套");
    expect(text).toContain("貨號 SKU-251");
    expect(text).toContain("上衣");
    expect(text).toContain("HK$199");
    expect(text).toContain("現貨 5 件");
    expect(text).not.toContain("直播優惠價發售，順豐站自取");
  });

  it("有足夠真描述就剝走 HTML／emoji，唔用貨號價錢改寫商品原意", () => {
    const description = `<p>${"柔軟布料".repeat(15)}✨</p>\n<b>直播精選</b>`;
    const text = productSeoDescription({ ...product, description });
    expect(text).toBe(plainProductSeoText(description));
    expect(plainProductSeoText("<p>A</p>\u0001\n✨B")).toBe("A B");
  });

  it("描述過短先補真名、分類、貨號、價錢、庫存、已批標籤同場次", () => {
    const text = productSeoDescription({
      ...product,
      description: "<p>柔軟布料✨</p>",
      aiTags: ["珍珠", "雙鍊"],
      liveDate: "20261114",
      liveSession: "2",
    }, 300);
    expect(text).toContain("復古牛仔外套｜柔軟布料");
    expect(text).toContain("上衣");
    expect(text).toContain("重點：珍珠、雙鍊");
    expect(text).toContain("直播場次 2026年11月14日 第2場");
    expect(text).not.toContain("✨");
  });

  it("短標題只補真分類；場次拒絕假日期，唔虛構品牌或材質", () => {
    expect(productSeoTitle({ name: "067", category: "dress" })).toBe("067｜裙｜RedCode Fashion Design");
    expect(productSeoTitle(product)).toBe("復古牛仔外套｜上衣｜RedCode Fashion Design");
    expect(productSeoTitle({ name: "快閃福利珍珠雙鍊手鍊", category: "accessory" })).toBe("快閃福利珍珠雙鍊手鍊｜RedCode Fashion Design");
    expect(productLiveSessionLabel("20261301", "2")).toBeNull();
    expect(productLiveSessionLabel("20260229", "2")).toBeNull();
    expect(productLiveSessionLabel("20261114", "not-a-session")).toBe("2026年11月14日");
  });

  it("缺貨同冇貨號都如實顯示，長描述按上限截斷", () => {
    const text = productSeoDescription({ ...product, sku: null, stock: 0 }, 300);
    expect(text).toContain("暫時缺貨");
    expect(text).not.toContain("貨號");
    expect(productSeoDescription({ ...product, description: "甲".repeat(200) })).toHaveLength(120);
    expect(productSeoDescription({ ...product, description: "甲".repeat(200) }).endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { plainProductSeoText, productSeoDescription } from "@contracts/types";

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

  it("有真描述就剝走 HTML／emoji，唔用貨號價錢改寫商品原意", () => {
    const text = productSeoDescription({ ...product, description: "<p>柔軟布料✨</p>\n<b>直播精選</b>" });
    expect(text).toBe("柔軟布料 直播精選");
    expect(plainProductSeoText("<p>A</p>\u0001\n✨B")).toBe("A B");
  });

  it("缺貨同冇貨號都如實顯示，長描述按上限截斷", () => {
    const text = productSeoDescription({ ...product, sku: null, stock: 0 }, 300);
    expect(text).toContain("暫時缺貨");
    expect(text).not.toContain("貨號");
    expect(productSeoDescription({ ...product, description: "甲".repeat(200) })).toHaveLength(120);
    expect(productSeoDescription({ ...product, description: "甲".repeat(200) }).endsWith("…")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { tryOnPurchaseItemsSchema } from "@contracts/purchase";
import {
  purchaseSizes,
  resolveTryOnPurchaseItems,
  type PurchaseProduct,
} from "./purchase";

function product(overrides: Partial<PurchaseProduct> = {}): PurchaseProduct {
  return {
    id: 101,
    sku: "TOP-101",
    name: "短款牛仔外套",
    price: 599,
    discountPrice: 499,
    sizes: "S,M,L",
    sizeEnabled: true,
    stock: 8,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    ...overrides,
  } as PurchaseProduct;
}

describe("試穿購買商品核實", () => {
  it("兩件商品保持兩行，並用目前 DB 品名、貨號及價錢", () => {
    const rows = [
      product(),
      product({ id: 202, sku: "PANTS-202", name: "高腰長褲", price: 399, discountPrice: null }),
    ];
    const result = resolveTryOnPurchaseItems(
      [
        { productId: 101, size: "M", quantity: 1 },
        { productId: 202, size: "L", quantity: 1 },
      ],
      rows,
    );
    expect(result).toHaveLength(2);
    expect(result.map((item) => [item.product.sku, item.product.discountPrice ?? item.product.price, item.size])).toEqual([
      ["TOP-101", 499, "M"],
      ["PANTS-202", 399, "L"],
    ]);
  });

  it("需要尺寸時，AI 結果不能代替客人揀尺碼", () => {
    expect(() => resolveTryOnPurchaseItems([{ productId: 101, quantity: 1 }], [product()])).toThrow(
      "請為《短款牛仔外套》揀返有效尺寸",
    );
    expect(() => resolveTryOnPurchaseItems([{ productId: 101, size: "XXL", quantity: 1 }], [product()])).toThrow(
      "揀返有效尺寸",
    );
  });

  it("關閉尺寸或冇尺寸選項時會正常帶 null", () => {
    const noSizes = resolveTryOnPurchaseItems(
      [{ productId: 101, size: "不應保留", quantity: 1 }],
      [product({ sizeEnabled: false })],
    );
    const emptySizes = resolveTryOnPurchaseItems(
      [{ productId: 101, size: "不應保留", quantity: 1 }],
      [product({ sizes: null })],
    );
    expect(noSizes[0]?.size).toBeNull();
    expect(emptySizes[0]?.size).toBeNull();
  });

  it("尺寸解析同商品頁一致", () => {
    expect(purchaseSizes({ sizes: " S, M ,, L " })).toEqual(["S", "M", "L"]);
    expect(purchaseSizes({ sizes: null })).toEqual([]);
  });

  it("拒絕下架、已自動下架、唔存在及重複商品", () => {
    expect(() => resolveTryOnPurchaseItems([{ productId: 999, quantity: 1 }], [])).toThrow("已下架或唔存在");
    expect(() => resolveTryOnPurchaseItems(
      [{ productId: 101, size: "M", quantity: 1 }],
      [product({ isActive: false })],
    )).toThrow("已下架或唔存在");
    expect(() => resolveTryOnPurchaseItems(
      [{ productId: 101, size: "M", quantity: 1 }],
      [product({ delistEnabled: true, delistAt: new Date(Date.now() - 1000) })],
    )).toThrow("已下架或唔存在");
    expect(() => resolveTryOnPurchaseItems(
      [
        { productId: 101, size: "M", quantity: 1 },
        { productId: 101, size: "L", quantity: 1 },
      ],
      [product()],
    )).toThrow("唔可以重複提交");
  });

  it("API schema 限制一至三件及有效數量，並忽略客戶端價錢欄", () => {
    expect(tryOnPurchaseItemsSchema.parse([
      { productId: 101, size: "M", quantity: 1, price: 1 } as unknown,
    ])).toEqual([{ productId: 101, size: "M", quantity: 1 }]);
    expect(() => tryOnPurchaseItemsSchema.parse([])).toThrow();
    expect(() => tryOnPurchaseItemsSchema.parse([
      { productId: 1, quantity: 1 },
      { productId: 2, quantity: 1 },
      { productId: 3, quantity: 1 },
      { productId: 4, quantity: 1 },
    ])).toThrow();
    expect(() => tryOnPurchaseItemsSchema.parse([{ productId: 101, quantity: 0 }])).toThrow();
    expect(() => tryOnPurchaseItemsSchema.parse([
      { productId: 101, quantity: 1 },
      { productId: 101, quantity: 1 },
    ])).toThrow("唔可以重複提交");
  });
});

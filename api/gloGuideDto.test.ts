/**
 * Glo Glo 公開 DTO mapper 測試（唔掂 DB）：
 * ─ 圖片只出 completed＋approved＋未刪＋合法 /uploads/glo-guide/ 路徑＋正尺寸；
 * ─ Fashn CDN URL／未批／失敗／無尺寸 一律剔走（公開 DTO 擋 CDN 係硬要求）；
 * ─ modelImage 永遠 null；日期 ISO；excerpt 截斷；cover＝position 最細合法圖。
 */
import { describe, expect, it } from "vitest";
import { toGuideDetail, toGuideImage, toGuideListItem, toGuideProduct, type DtoArticleRow, type DtoImageRow, type DtoProductRow } from "./gloGuideDto";

const product = (id: number): DtoProductRow => ({
  id,
  name: `商品${id}`,
  image: `/uploads/p${id}.jpg`,
  photos: [`/uploads/p${id}.jpg`, `/uploads/p${id}-2.jpg`],
  price: 268,
  discountPrice: 228,
  category: "top",
  stock: 3,
  sizeEnabled: true,
  sizes: "S, M ,L",
  isActive: true,
  liveDate: "20261118",
  liveSession: "2",
  aiTags: ["顯瘦", "百搭"],
});

const img = (over: Partial<DtoImageRow>): DtoImageRow => ({
  id: 1,
  productId: 1,
  path: "/uploads/glo-guide/a.png",
  width: 1024,
  height: 1536,
  position: 0,
  status: "completed",
  reviewStatus: "approved",
  deletedAt: null,
  ...over,
});

const article: DtoArticleRow = {
  id: 5,
  slug: "glo-guide-20261116-ab12",
  title: "轉季上班點襯好",
  body: "而".repeat(200),
  theme: "轉季上班",
  status: "published",
  publishedAt: new Date("2026-11-16T01:00:00Z"),
  updatedAt: new Date("2026-11-16T02:00:00Z"),
};

describe("toGuideImage（同公開 media 閘一致）", () => {
  it("completed＋approved＋合法 path＋正尺寸 → 出", () => {
    const g = toGuideImage(img({}), "商品1");
    expect(g).not.toBeNull();
    expect(g!.path).toBe("/uploads/glo-guide/a.png");
    expect(g!.width).toBe(1024);
    expect(g!.height).toBe(1536);
  });
  it("未 approved（pending/rejected）→ 唔出", () => {
    expect(toGuideImage(img({ reviewStatus: "pending" }), "x")).toBeNull();
    expect(toGuideImage(img({ reviewStatus: "rejected" }), "x")).toBeNull();
  });
  it("未完成／已刪 → 唔出", () => {
    expect(toGuideImage(img({ status: "processing" }), "x")).toBeNull();
    expect(toGuideImage(img({ status: "failed" }), "x")).toBeNull();
    expect(toGuideImage(img({ deletedAt: new Date() }), "x")).toBeNull();
  });
  it("Fashn CDN／其他路徑 → 唔出（CDN 絕對唔入公開 DTO）", () => {
    expect(toGuideImage(img({ path: "https://cdn.fashn.ai/x.png" }), "x")).toBeNull();
    expect(toGuideImage(img({ path: "/uploads/other/x.png" }), "x")).toBeNull();
    expect(toGuideImage(img({ path: null }), "x")).toBeNull();
  });
  it("無效尺寸（null／0）→ 唔出（唔准出 0×0）", () => {
    expect(toGuideImage(img({ width: null }), "x")).toBeNull();
    expect(toGuideImage(img({ height: 0 }), "x")).toBeNull();
  });
});

describe("toGuideProduct", () => {
  it("sizes 字串轉 array 兼 trim；aiTags 係 caller 過咗閘嘅 array", () => {
    const p = toGuideProduct(product(1));
    expect(p.sizes).toEqual(["S", "M", "L"]);
    expect(p.aiTags).toEqual(["顯瘦", "百搭"]);
    expect(p.photos).toHaveLength(2);
    expect(p.liveDate).toBe("20261118");
  });
});

describe("toGuideListItem / toGuideDetail", () => {
  const imageRows = [
    { row: img({ id: 2, position: 1 }), alt: "商品1" },
    { row: img({ id: 1, position: 0 }), alt: "商品1" },
    // 未批圖唔會出現喺公開 DTO
    { row: img({ id: 3, position: 2, reviewStatus: "pending" }), alt: "商品1" },
  ];
  it("日期 ISO、modelImage 永遠 null、cover＝position 最細合法圖", () => {
    const item = toGuideListItem(article, [product(1)], imageRows);
    expect(item.publishedAt).toBe("2026-11-16T01:00:00.000Z");
    expect(item.coverImage?.id).toBe(1);
    const detail = toGuideDetail(article, [product(1)], imageRows);
    expect(detail.modelImage).toBeNull();
    expect(detail.images.map((i) => i.id)).toEqual([1, 2]);
    expect(detail.body).toBe(article.body);
  });
  it("excerpt 截斷", () => {
    const item = toGuideListItem(article, [], []);
    expect(item.excerpt.length).toBeLessThanOrEqual(121);
    expect(item.coverImage).toBeNull();
  });
});

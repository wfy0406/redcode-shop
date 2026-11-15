/** 商品管理 server 搜尋／分頁：純 query builder、頁碼窗口同實際接線守衛。 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/providers/trpc", () => ({ trpc: {} }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/auth", () => ({ getToken: () => null }));
vi.mock("lucide-react", () => ({
  Ban: () => null,
  Pencil: () => null,
  Plus: () => null,
  Sparkles: () => null,
  Trash2: () => null,
  Upload: () => null,
  X: () => null,
}));

import {
  PRODUCT_PAGE_SIZES,
  buildAdminProductListInput,
  productPageNumbers,
} from "./ProductManager";

const source = readFileSync(new URL("./ProductManager.tsx", import.meta.url), "utf8");

describe("ProductManager adminPage query input", () => {
  it("名稱／貨號 keyword 會 trim；空篩選唔送上 server", () => {
    expect(
      buildAdminProductListInput({
        q: "  B244  ",
        category: "dress",
        createdDay: "2026-11-16",
        sort: "created",
        page: 2,
        pageSize: 100,
      }),
    ).toEqual({
      q: "B244",
      category: "dress",
      createdDay: "2026-11-16",
      sort: "created",
      page: 2,
      pageSize: 100,
    });
    expect(
      buildAdminProductListInput({
        q: "   ",
        category: "",
        createdDay: null,
        sort: "name",
        page: 1,
        pageSize: 50,
      }),
    ).toEqual({ sort: "name", page: 1, pageSize: 50 });
  });

  it("每頁只係用戶要求嘅 50／100／150／200", () => {
    expect(PRODUCT_PAGE_SIZES).toEqual([50, 100, 150, 200]);
  });

  it("頁碼窗口固定最多五個，頭尾都唔會溢出", () => {
    expect(productPageNumbers(1, 1)).toEqual([1]);
    expect(productPageNumbers(1, 20)).toEqual([1, 2, 3, 4, 5]);
    expect(productPageNumbers(10, 20)).toEqual([8, 9, 10, 11, 12]);
    expect(productPageNumbers(20, 20)).toEqual([16, 17, 18, 19, 20]);
    expect(productPageNumbers(99, 3)).toEqual([1, 2, 3]);
  });

  it("列表改用 adminPage；舊 adminList 冇再喺 ProductManager 全量 useQuery", () => {
    expect(source).toContain("trpc.products.adminPage.useQuery(listInput");
    expect(source).not.toContain("trpc.products.adminList.useQuery");
    expect(source).toContain("id=\"pm-search\"");
    expect(source).toContain("id=\"pm-category-filter\"");
    expect(source).toContain("id=\"pm-page-size\"");
    expect(source).toContain("aria-label=\"商品列表頁碼\"");
    expect(source).toContain("placeholderData: (previous) => previous");
  });
});

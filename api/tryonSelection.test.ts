import { describe, expect, it } from "vitest";
import {
  addTryOnProductSelection,
  moveTryOnProductSelection,
  parseTryOnBatchPlan,
  type TryOnProductSelection,
} from "../src/pages/tryonSelection";

const products = [
  { id: 11, tryOnKind: "top" },
  { id: 22, tryOnKind: "top" },
  { id: 33, tryOnKind: "shoes" },
  { id: 44, tryOnKind: "ring" },
];
const first: TryOnProductSelection = { productId: 11, photoIndex: 0 };

function add(selections: TryOnProductSelection[], productId: number, maxSelections = 2) {
  const product = products.find((item) => item.id === productId)!;
  return addTryOnProductSelection({ selections, products, product, kindLabel: "上衣", maxSelections });
}

describe("即場雙商品選擇", () => {
  it("可揀一件或兩件不同部位，保留生成次序", () => {
    const one = add([], 11);
    expect(one.ok).toBe(true);
    const two = add(one.selections, 33);
    expect(two).toEqual({
      ok: true,
      selections: [first, { productId: 33, photoIndex: 0 }],
    });
  });

  it("同部位及第三件即場拒絕，不會靜默替換", () => {
    const sameKind = add([first], 22);
    expect(sameKind.ok).toBe(false);
    expect(sameKind.selections).toEqual([first]);
    const two = [first, { productId: 33, photoIndex: 0 }];
    const third = add(two, 44);
    expect(third.ok).toBe(false);
    expect(third.selections).toEqual(two);
  });

  it("再按已選商品會移除；兩件可以調換次序", () => {
    const removed = add([first], 11);
    expect(removed).toEqual({ ok: true, selections: [] });
    const two = [first, { productId: 33, photoIndex: 1 }];
    expect(moveTryOnProductSelection(two, 0, 1)).toEqual([two[1], two[0]]);
    expect(moveTryOnProductSelection(two, 0, -1)).toBe(two);
  });
});

describe("已授權第二件計劃恢復", () => {
  const valid = JSON.stringify({
    version: 1,
    userId: 7,
    rootPublicId: "123e4567-e89b-42d3-a456-426614174000",
    second: { productId: 33, photoIndex: 2 },
    idempotencyKey: "tryon_batch_123456",
    paused: false,
  });

  it("只恢復同一用戶、結構完整嘅計劃", () => {
    expect(parseTryOnBatchPlan(valid, 7)?.second).toEqual({ productId: 33, photoIndex: 2 });
    expect(parseTryOnBatchPlan(valid, 8)).toBeNull();
  });

  it("無效 JSON、改過嘅操作編號及越界相簿索引全部拒絕", () => {
    expect(parseTryOnBatchPlan("not-json", 7)).toBeNull();
    expect(parseTryOnBatchPlan(valid.replace("tryon_batch_123456", "bad key"), 7)).toBeNull();
    expect(parseTryOnBatchPlan(valid.replace('"photoIndex":2', '"photoIndex":51'), 7)).toBeNull();
  });
});

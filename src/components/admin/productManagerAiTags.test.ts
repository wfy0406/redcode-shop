/**
 * L3：ProductManager 批量停用 重點標籤 嘅 chunk 邏輯測試（唔掂 DB、唔 render DOM）。
 *
 * 背景：後端 products.disableAiTags 每 call 最多 100 ids（zod max(100)）；
 * 之前 UI 直接成批送，揀超過 100 件會被 server 拒絕。
 * 而家 UI 用 chunkAiDisableIds＋runAiTagsDisableInChunks 逐 100 chunk 順序送，
 * 總數同部分失敗如實回報——呢度直接驗呢兩個純邏輯。
 */
import { describe, expect, it, vi } from "vitest";

// ProductManager module-level import 鏈防 side effect（測試淨係用佢 export 嘅純函數）
vi.mock("@/providers/trpc", () => ({ trpc: {} }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/auth", () => ({ getToken: () => null }));
// 測試環境冇 lucide-react；淨係 import module 攞純函數，icon 全部用 stub
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
  AI_TAGS_DISABLE_CHUNK_SIZE,
  chunkAiDisableIds,
  runAiTagsDisableInChunks,
} from "./ProductManager";

describe("chunkAiDisableIds", () => {
  it("預設每 chunk 100，保持順序", () => {
    expect(AI_TAGS_DISABLE_CHUNK_SIZE).toBe(100);
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const chunks = chunkAiDisableIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat()).toEqual(ids); // 順序唔變
  });

  it("啱啱好 100 → 一個 chunk；空陣列 → 空", () => {
    expect(chunkAiDisableIds(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(1);
    expect(chunkAiDisableIds([])).toEqual([]);
  });
});

describe("runAiTagsDisableInChunks — 順序＋如實成敗", () => {
  it("全部成功：updatedCount 係逐 chunk server count 總和，succeededIds 齊", async () => {
    const calls: number[][] = [];
    const mutateAsync = vi.fn(async (vars: { ids: number[] }) => {
      calls.push(vars.ids);
      return { count: vars.ids.length - 1 }; // 模擬 server 實際更新少一行（例如一件已被停）
    });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const res = await runAiTagsDisableInChunks(ids, mutateAsync);
    expect(mutateAsync).toHaveBeenCalledTimes(3);
    expect(res.updatedCount).toBe(99 + 99 + 49); // 報 server 實數，唔係報已揀數
    expect(res.succeededIds).toEqual(ids);
    expect(res.failedIds).toEqual([]);
    expect(res.firstError).toBeNull();
  });

  it("順序執行：chunk 2 未完成之前 chunk 3 唔會開始", async () => {
    const order: string[] = [];
    const mutateAsync = vi.fn(
      (vars: { ids: number[] }) =>
        new Promise((resolve) => {
          order.push(`start:${vars.ids[0]}`);
          setTimeout(() => {
            order.push(`end:${vars.ids[0]}`);
            resolve({ count: vars.ids.length });
          }, vars.ids[0] === 101 ? 20 : 1); // chunk 2 慢啲
        }),
    );
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    await runAiTagsDisableInChunks(ids, mutateAsync);
    expect(order).toEqual(["start:1", "end:1", "start:101", "end:101", "start:201", "end:201"]);
  });

  it("部分失敗：失敗 chunk 記入 failedIds＋firstError，繼續跑完後面 chunk，唔會報全成功", async () => {
    const mutateAsync = vi.fn(async (vars: { ids: number[] }) => {
      if (vars.ids[0] === 101) throw new Error("第 2 chunk 網絡斷");
      return { count: vars.ids.length };
    });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const res = await runAiTagsDisableInChunks(ids, mutateAsync);
    expect(mutateAsync).toHaveBeenCalledTimes(3); // 失敗唔會中斷後面
    expect(res.failedIds).toEqual(ids.slice(100, 200));
    expect(res.succeededIds).toEqual([...ids.slice(0, 100), ...ids.slice(200)]);
    expect(res.updatedCount).toBe(150); // 只計成功 chunk 嘅實數
    expect(res.firstError).toBe("第 2 chunk 網絡斷");
  });

  it("server 冇回 count（null）→ 當 chunk 全數成功；錯誤冇 message → 未知錯誤", async () => {
    const mutateAsync = vi.fn(async (vars: { ids: number[] }) => {
      if (vars.ids[0] === 101) throw { weird: true };
      return null;
    });
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const res = await runAiTagsDisableInChunks(ids, mutateAsync);
    expect(res.updatedCount).toBe(100);
    expect(res.firstError).toBe("未知錯誤");
    expect(res.failedIds).toHaveLength(50);
  });
});

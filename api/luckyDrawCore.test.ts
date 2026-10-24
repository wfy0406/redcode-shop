/**
 * v2.5.6 抽獎核心（api/luckyDrawCore.ts）單元測試——純函數。
 * 覆蓋：normalize 口径、N=1 同舊 Set guard 等價、加權抽邊界同分佈、限中過濾、forceExclude。
 * 注意：真 PostgreSQL advisory lock／transaction 並發行為冇喺度驗（要 integration）。
 */
import { describe, expect, it } from "vitest";
import {
  filterEligibleEntries,
  normalizeListName,
  pickWeightedEntry,
  pickWeightedIndex,
  totalTickets,
  underWinLimit,
} from "./luckyDrawCore";

describe("normalizeListName", () => {
  it("trim＋toLowerCase，同舊名單去重口径一致", () => {
    expect(normalizeListName("  Chan Tai Man ")).toBe("chan tai man");
    expect(normalizeListName("陳小明")).toBe("陳小明");
    expect(normalizeListName("")).toBe("");
  });
});

describe("underWinLimit：名單每日限中 N 次", () => {
  it("N=1 ≡ 舊 Set guard（中過 1 次即踢；冇中過先入池）", () => {
    expect(underWinLimit(undefined, 1)).toBe(true); // 從未中 → 入池
    expect(underWinLimit(0, 1)).toBe(true);
    expect(underWinLimit(1, 1)).toBe(false); // 舊 Set.has()=true → 踢
    expect(underWinLimit(2, 1)).toBe(false);
  });

  it("N=3：中 0/1/2 次入池，中 3 次踢", () => {
    expect(underWinLimit(2, 3)).toBe(true);
    expect(underWinLimit(3, 3)).toBe(false);
    expect(underWinLimit(5, 3)).toBe(false);
  });

  it("forceExcluded（重抽保險）唔理次數都踢", () => {
    expect(underWinLimit(0, 100, true)).toBe(false);
    expect(underWinLimit(undefined, 1, true)).toBe(false);
  });
});

describe("加權抽（劵模式）", () => {
  const pool = [
    { id: 1, ticketCount: 1 },
    { id: 2, ticketCount: 3 },
    { id: 3, ticketCount: 6 },
  ]; // total = 10

  it("totalTickets 計總數", () => {
    expect(totalTickets(pool.map((e) => ({ entryId: e.id, weight: e.ticketCount })))).toBe(10);
    expect(totalTickets([])).toBe(0);
  });

  it("累計權重邊界：pick 0 → 第一個；pick total-1 → 最後；區間按權重", () => {
    const weighted = pool.map((e) => ({ entryId: e.id, weight: e.ticketCount }));
    expect(pickWeightedIndex(weighted, 0)).toBe(0); // 第一張劵
    expect(pickWeightedIndex(weighted, 1)).toBe(1); // 入第二個人嘅區間（1..3）
    expect(pickWeightedIndex(weighted, 3)).toBe(1);
    expect(pickWeightedIndex(weighted, 4)).toBe(2); // 4..9 係第三個
    expect(pickWeightedIndex(weighted, 9)).toBe(2); // 最後一張
    expect(pickWeightedIndex(weighted, 10)).toBe(-1); // 越界
    expect(pickWeightedIndex(weighted, -1)).toBe(-1);
    expect(pickWeightedIndex([], 0)).toBe(-1);
  });

  it("等權：每張劵中獎概率一樣（統計抽樣 20000 次，誤差 < 2%）", () => {
    // 用確定性 PRNG（mulberry32，0..1 float 先乘——LCG 低位短周期唔啱 % 細數）
    let a = 42;
    const rand = (n: number) => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(f * n);
    };
    const hits = [0, 0, 0];
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const idx = pickWeightedIndex(pool.map((e) => ({ entryId: e.id, weight: e.ticketCount })), rand(10));
      hits[idx]++;
    }
    // 期望比例 1:3:6 → 2000/6000/12000 ±2%
    expect(Math.abs(hits[0] - 2000)).toBeLessThan(400);
    expect(Math.abs(hits[1] - 6000)).toBeLessThan(400);
    expect(Math.abs(hits[2] - 12000)).toBeLessThan(400);
  });

  it("pickWeightedEntry：空池 → null；命中返原 entry object", () => {
    expect(pickWeightedEntry([], 0)).toBeNull();
    expect(pickWeightedEntry(pool, 0)?.id).toBe(1);
    expect(pickWeightedEntry(pool, 9)?.id).toBe(3);
  });
});

describe("filterEligibleEntries：全活動累計限中", () => {
  const entries = [
    { id: 1, ticketCount: 2 },
    { id: 2, ticketCount: 5 },
    { id: 3, ticketCount: 1 },
  ];

  it("中夠上限嘅人踢走；cancelled/declined 唔計（由 caller 嘅 counts 口径保證）", () => {
    const counts = new Map([[1, 2]]); // entry 1 已中 2 次
    expect(filterEligibleEntries(entries, counts, 3).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(filterEligibleEntries(entries, counts, 2).map((e) => e.id)).toEqual([2, 3]);
    expect(filterEligibleEntries(entries, counts, 1).map((e) => e.id)).toEqual([2, 3]);
  });

  it("同人多次中獎到上限後唔再入池（N=1 等同舊「中過即踢」）", () => {
    const counts = new Map([[2, 1]]);
    expect(filterEligibleEntries(entries, counts, 1).map((e) => e.id)).toEqual([1, 3]);
  });

  it("forceExcludeId（重抽）永遠踢走舊中獎人，即使佢未夠上限", () => {
    const counts = new Map([[2, 0]]);
    expect(filterEligibleEntries(entries, counts, 3, 2).map((e) => e.id)).toEqual([1, 3]);
  });

  it("全部中夠 → 空池（上游回「冇人抽得」）", () => {
    const counts = new Map([[1, 1], [2, 1], [3, 1]]);
    expect(filterEligibleEntries(entries, counts, 1)).toEqual([]);
  });
});

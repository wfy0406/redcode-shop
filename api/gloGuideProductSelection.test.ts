/**
 * Glo Glo 商品選擇模組測試（SPEC 第 3 輪凍結 contract；唔掂真 DB——
 * 全部 DB 存取經 GloGuideProductStore 介面注入 in-memory fake 實跑真規則）：
 *
 * ─ auto 由香港本週向過去逐週 fallback：本週無貨 → 上星期 → 再上一週；
 *   全歷史（最舊直播貨嗰週為止）搵唔到 ≥2 件合資格未用 → 409 真錯誤；
 * ─ 已用商品永不重用（gloGuideProductUsage 係唯一真相；就算 article link 刪咗，
 *   usage 歷史仲喺度一樣擋）；同一文章（excludeArticleId）可保留自身商品；
 * ─ week/session 指定貨必須屬該來源（唔准跨來源，指定貨絕對唔隨機）；
 *   唔指定就由該來源合資格池**隨機抽 2–3 件**（用戶規則：無選／自動產生就隨機選商品；
 *   可注入 seed RNG → deterministic 斷言），少於 2 件 → 409 唔跨來源 fallback；
 * ─ products 模式直接指定 2–3 件；唔存在／inactive／缺貨／到期下架／無圖／類別 → 400；
 * ─ 舊 top-level productIds ＝ products 模式；同時傳 selection → 400；
 * ─ claimProductUsage：23505 PK 撞 → 可讀 409；其他錯照抛；
 * ─ productSources 星期／場次概覽 total/eligible 計數。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimProductUsage,
  compactToDashYmd,
  dashYmdToCompact,
  groupLiveRowsByWeek,
  ineligibleReason,
  isDelistedNow,
  isProductUsageViolation,
  listGloGuideProducts,
  listGloGuideProductSources,
  normalizeGenerateSelection,
  parseProductFilter,
  parseLiveDate,
  parseLiveSession,
  parseWeekStart,
  pickRandomTwoThree,
  resolveGenerateProducts,
  weekStartOfYmd,
  type GloGuideProductRow,
  type GloGuideProductStore,
} from "./gloGuideProductSelection";

/** deterministic RNG（mulberry32）：注入 resolveGenerateProducts／pickRandomTwoThree 令隨機抽貨可重現 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 固定「而家」：香港 2026-11-18（星期三）10:00 → 本週 = 週一 20261116 至週日 20261122
const NOW = new Date("2026-11-18T10:00:00+08:00");
const THIS_WEEK = { start: "20261116", end: "20261122" };
const LAST_WEEK = { start: "20261109", end: "20261115" };
const WEEK_BEFORE = { start: "20261102", end: "20261108" };

function row(over: Partial<GloGuideProductRow> & { id: number }): GloGuideProductRow {
  return {
    name: `商品${over.id}`,
    image: `/uploads/p${over.id}.jpg`,
    price: 100,
    discountPrice: null,
    aiTagsRaw: null,
    aiTagsEnabled: true,
    liveDate: THIS_WEEK.start,
    liveSession: null,
    category: "top",
    stock: 5,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    ...over,
  };
}

interface FakeStore extends GloGuideProductStore {
  calls: { fn: string; args: unknown[] }[];
}

/** in-memory store：記低呼叫（驗查詢範圍）；id 大＝listedDate 新（模擬排序） */
function fakeStore(rows: GloGuideProductRow[], usage: Record<number, number> = {}): FakeStore {
  const calls: FakeStore["calls"] = [];
  const rec =
    <A extends unknown[], R>(fn: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push({ fn, args });
      return impl(...args);
    };
  return {
    calls,
    liveInRange: rec("liveInRange", async (start: string, end: string) =>
      rows
        .filter((r) => r.liveDate !== null && r.liveDate >= start && r.liveDate <= end)
        .sort((a, b) => b.id - a.id),
    ),
    liveInSession: rec("liveInSession", async (d: string, s: string) =>
      rows
        .filter((r) => r.liveDate === d && r.liveSession === s)
        .sort((a, b) => b.id - a.id),
    ),
    byIds: rec("byIds", async (ids: number[]) => rows.filter((r) => ids.includes(r.id))),
    search: rec("search", async (q: string) => rows.filter((r) => r.name.includes(q))),
    usageByProduct: rec("usageByProduct", async (ids: number[]) => {
      const out = new Map<number, number>();
      for (const id of ids) if (usage[id] !== undefined) out.set(id, usage[id]!);
      return out;
    }),
    earliestLiveDate: rec("earliestLiveDate", async () => {
      const dates = rows.map((r) => r.liveDate).filter((d): d is string => d !== null);
      return dates.length === 0 ? null : dates.reduce((a, b) => (a < b ? a : b));
    }),
  };
}

// ──────────────────────────── 日期／輸入解析 ────────────────────────────

describe("日期／輸入解析（純函數）", () => {
  it("YYYY-MM-DD ↔ YYYYMMDD；假日期（2月30日／13月）→ null", () => {
    expect(dashYmdToCompact("2026-11-16")).toBe("20261116");
    expect(compactToDashYmd("20261116")).toBe("2026-11-16");
    expect(dashYmdToCompact("2026-02-30")).toBeNull();
    expect(dashYmdToCompact("2026-13-01")).toBeNull();
    expect(dashYmdToCompact("20261116")).toBeNull();
    expect(dashYmdToCompact("")).toBeNull();
  });

  it("weekStartOfYmd：週三 20261118 → 週一 20261116；週一自己 → 自己", () => {
    expect(weekStartOfYmd("20261118")).toBe("20261116");
    expect(weekStartOfYmd("20261116")).toBe("20261116");
    expect(weekStartOfYmd("20261122")).toBe("20261116"); // 週日都屬同一週
  });

  it("parseWeekStart：一定要香港星期一；星期二／假日期／非字串 → 400", () => {
    expect(parseWeekStart("2026-11-16")).toBe("20261116");
    expect(() => parseWeekStart("2026-11-17")).toThrowError(/星期一/);
    expect(() => parseWeekStart("2026-02-30")).toThrowError(/YYYY-MM-DD/);
    expect(() => parseWeekStart(123)).toThrowError(/YYYY-MM-DD/);
    expect(() => parseWeekStart("2026-11-16")).not.toThrow();
  });

  it("parseLiveDate／parseLiveSession：YYYYMMDD 真實日期；場次 1–16 字", () => {
    expect(parseLiveDate("20261120")).toBe("20261120");
    expect(() => parseLiveDate("2026-11-20")).toThrowError(/YYYYMMDD/);
    expect(() => parseLiveDate("20260230")).toThrowError(/YYYYMMDD/);
    expect(parseLiveSession("2")).toBe("2");
    expect(() => parseLiveSession("")).toThrowError(/liveSession/);
    expect(() => parseLiveSession("x".repeat(17))).toThrowError(/liveSession/);
  });

  it("parseProductFilter：省略 → auto；四模式形狀閘；search 1–60 字", () => {
    expect(parseProductFilter(undefined)).toEqual({ mode: "auto" });
    expect(parseProductFilter({ mode: "auto" })).toEqual({ mode: "auto" });
    expect(parseProductFilter({ mode: "week", weekStart: "2026-11-16" })).toEqual({
      mode: "week",
      weekStart: "20261116",
    });
    expect(
      parseProductFilter({ mode: "session", liveDate: "20261120", liveSession: "2" }),
    ).toEqual({ mode: "session", liveDate: "20261120", liveSession: "2" });
    expect(parseProductFilter({ mode: "search", query: " 連身裙 " })).toEqual({
      mode: "search",
      query: "連身裙",
    });
    expect(() => parseProductFilter({ mode: "hack" })).toThrowError(/未知商品來源模式/);
    expect(() => parseProductFilter({ mode: "search", query: "" })).toThrowError(/1–60/);
    expect(() => parseProductFilter({ mode: "search", query: "x".repeat(61) })).toThrowError(/1–60/);
    expect(() => parseProductFilter({ mode: "week", weekStart: "2026-11-17" })).toThrowError(/星期一/);
    expect(() => parseProductFilter("auto")).toThrowError(/filter 格式無效/);
  });

  it("normalizeGenerateSelection：舊 productIds ＝ products 模式；同時傳兩種 → 400；省略 → auto", () => {
    expect(normalizeGenerateSelection({})).toEqual({ mode: "auto" });
    expect(normalizeGenerateSelection({ productIds: [11, 12] })).toEqual({
      mode: "products",
      productIds: [11, 12],
    });
    expect(
      normalizeGenerateSelection({ selection: { mode: "week", weekStart: "2026-11-16" } }),
    ).toEqual({ mode: "week", weekStart: "20261116" });
    expect(() =>
      normalizeGenerateSelection({
        selection: { mode: "auto" },
        productIds: [1, 2],
      }),
    ).toThrowError(/唔可以同時提供/);
    // products 模式一定要 2–3 件（1 件 → 400）
    expect(() => normalizeGenerateSelection({ productIds: [1] })).toThrowError(/2–3/);
    expect(() =>
      normalizeGenerateSelection({ selection: { mode: "products", productIds: [] } }),
    ).toThrowError(/2–3 件/);
    expect(() => normalizeGenerateSelection({ selection: { mode: "hack" } })).toThrowError(
      /未知生成模式/,
    );
    // week/session 附帶 productIds 都過 2–3＋唔重複閘
    expect(() =>
      normalizeGenerateSelection({
        selection: { mode: "week", weekStart: "2026-11-16", productIds: [1, 1] },
      }),
    ).toThrowError(/重複/);
  });
});

// ──────────────────────────── 合資格判定（純函數）────────────────────────────

describe("ineligibleReason 優先次序（SPEC：used > inactive > out_of_stock > delisted > no_image > category）", () => {
  const base = row({ id: 1 });
  it("逐個原因＋優先次序", () => {
    expect(ineligibleReason(base, false, NOW)).toBeNull();
    expect(ineligibleReason(base, true, NOW)).toBe("used"); // 用過大過一切
    expect(ineligibleReason({ ...base, isActive: false }, false, NOW)).toBe("inactive");
    expect(ineligibleReason({ ...base, isActive: false, stock: 0 }, false, NOW)).toBe("inactive");
    expect(ineligibleReason({ ...base, stock: 0 }, false, NOW)).toBe("out_of_stock");
    expect(
      ineligibleReason({ ...base, delistEnabled: true, delistAt: new Date("2026-11-01T00:00:00+08:00") }, false, NOW),
    ).toBe("delisted");
    expect(ineligibleReason({ ...base, image: " " }, false, NOW)).toBe("no_image");
    expect(ineligibleReason({ ...base, category: "skincare" }, false, NOW)).toBe("category");
    // 未到期 delist 唔擋
    expect(
      ineligibleReason({ ...base, delistEnabled: true, delistAt: new Date("2026-12-31T00:00:00+08:00") }, false, NOW),
    ).toBeNull();
    expect(isDelistedNow({ delistEnabled: false, delistAt: new Date("2020-01-01") }, NOW)).toBe(false);
  });

  it("pickRandomTwoThree：0/1 件 → 空；2 件 → 全取；≥3 → 抽 3 件", () => {
    expect(pickRandomTwoThree([], mulberry32(1))).toEqual([]);
    expect(pickRandomTwoThree([1], mulberry32(1))).toEqual([]);
    // 池得 2 件 → 無論 rng 點都全取
    expect(pickRandomTwoThree([1, 2], mulberry32(1)).sort()).toEqual([1, 2]);
    expect(pickRandomTwoThree([1, 2], mulberry32(99)).sort()).toEqual([1, 2]);
    expect(pickRandomTwoThree([1, 2, 3, 4], mulberry32(1))).toHaveLength(3);
  });

  it("pickRandomTwoThree：抽中嘅一定屬原池、唔重複；同 seed 可重現，唔再固定 newest", () => {
    const pool = [1, 2, 3, 4, 5];
    const a = pickRandomTwoThree(pool, mulberry32(42));
    const b = pickRandomTwoThree(pool, mulberry32(42));
    expect(a).toEqual(b); // 同 seed deterministic
    expect(a).toHaveLength(3);
    expect(new Set(a).size).toBe(3);
    for (const x of a) expect(pool).toContain(x);
    // 唔同 seed 抽多幾次，至少出現過非「頭 3 件」組合（證明真係隨機，唔再固定 newest）
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      seen.add([...pickRandomTwoThree(pool, mulberry32(seed))].sort().join(","));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

// ──────────────────────────── auto 逐週 fallback ────────────────────────────

describe("auto：由香港本週向過去逐週 fallback（冇人為週數上限），揀中週嘅合資格池隨機抽", () => {
  it("本週無貨 → 上星期唔夠 → 再上一週隨機抽 2–3 件（揀中嗰週係最近夠貨嗰週）", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: THIS_WEEK.start, stock: 0 }), // 本週唯一一件缺貨
      row({ id: 2, liveDate: LAST_WEEK.start }), // 上星期得 1 件
      row({ id: 3, liveDate: WEEK_BEFORE.start }),
      row({ id: 4, liveDate: WEEK_BEFORE.start }),
      row({ id: 5, liveDate: WEEK_BEFORE.start }),
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "auto" },
      { now: NOW, store, rng: mulberry32(42) },
    );
    // 隨機抽：3 件、全部嚟自再上一週合資格池 {3,4,5}、唔重複
    expect(resolved.products).toHaveLength(3);
    expect(resolved.products.map((p) => p.id).sort()).toEqual([3, 4, 5]);
    // 一次查晒「最舊直播貨嗰週 → 本週尾」範圍（weekStartOf(20261102)=20261102），唔會漏舊貨
    expect(store.calls.filter((c) => c.fn === "liveInRange").map((c) => c.args)).toEqual([
      [WEEK_BEFORE.start, THIS_WEEK.end],
    ]);
  });

  it("回歸：超過 12 週前嘅舊貨 auto 一樣搵到（唔准再有週數 cap）", async () => {
    // 20 週前（2026-06-29 嗰週）先得 2 件合資格貨
    const store = fakeStore([
      row({ id: 1, liveDate: THIS_WEEK.start, stock: 0 }),
      row({ id: 2, liveDate: "20260629" }),
      row({ id: 3, liveDate: "20260701" }),
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "auto" },
      { now: NOW, store, rng: mulberry32(1) },
    );
    expect(resolved.products.map((p) => p.id).sort()).toEqual([2, 3]);
    expect(store.calls.filter((c) => c.fn === "liveInRange")[0]!.args).toEqual([
      "20260629",
      THIS_WEEK.end,
    ]);
  });

  it("本週 2 件合資格未用 → 直接揀本週，唔會落舊週", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: THIS_WEEK.start }),
      row({ id: 2, liveDate: THIS_WEEK.end }),
      row({ id: 3, liveDate: LAST_WEEK.start }),
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "auto" },
      { now: NOW, store, rng: mulberry32(2) },
    );
    expect(resolved.products.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it("全歷史都唔夠 2 件 → 409 真錯誤；全庫冇直播貨 → 一樣 409（唔會假成功）", async () => {
    const store = fakeStore([row({ id: 1, liveDate: THIS_WEEK.start })]); // 全期得 1 件
    await expect(
      resolveGenerateProducts({ mode: "auto" }, { now: NOW, store }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "CONFLICT" });
    const empty = fakeStore([]);
    await expect(
      resolveGenerateProducts({ mode: "auto" }, { now: NOW, store: empty }),
    ).rejects.toMatchObject({ httpStatus: 409, code: "CONFLICT" });
    // 冇直播貨嘅話唔會亂查範圍
    expect(empty.calls.filter((c) => c.fn === "liveInRange")).toHaveLength(0);
  });

  it("用過嘅商品唔計合資格：本週 3 件但 2 件用過 → 落去上星期抽 2 件全新", async () => {
    const store = fakeStore(
      [
        row({ id: 1, liveDate: THIS_WEEK.start }),
        row({ id: 2, liveDate: THIS_WEEK.start }),
        row({ id: 3, liveDate: THIS_WEEK.start }),
        row({ id: 4, liveDate: LAST_WEEK.start }),
        row({ id: 5, liveDate: LAST_WEEK.start }),
      ],
      { 1: 101, 2: 101 }, // 商品 1、2 曾屬文章 101
    );
    const resolved = await resolveGenerateProducts(
      { mode: "auto" },
      { now: NOW, store, rng: mulberry32(3) },
    );
    expect(resolved.products.map((p) => p.id).sort()).toEqual([4, 5]);
  });

  it("listGloGuideProducts auto：回最近夠貨週次嘅**完整 rows**（唔隨機，preview 穩定）；全空 → []", async () => {
    // 上星期 3 件：id 1 用過（usedBefore 標記＋唔合資格），2、3 合資格 → eligible=2 夠門檻
    const store = fakeStore(
      [
        row({ id: 1, liveDate: LAST_WEEK.start }),
        row({ id: 2, liveDate: LAST_WEEK.start }),
        row({ id: 3, liveDate: LAST_WEEK.end }),
      ],
      { 1: 101 },
    );
    const refs = await listGloGuideProducts({ mode: "auto" }, { now: NOW, store });
    // 完整 rows（連唔合資格嗰件都回），順序跟 store（listedDate 新→舊），唔係隨機抽
    expect(refs.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(refs.find((r) => r.id === 1)).toMatchObject({
      usedBefore: true,
      eligible: false,
      ineligibleReason: "used",
    });
    expect(refs.find((r) => r.id === 2)).toMatchObject({
      usedBefore: false,
      eligible: true,
      ineligibleReason: null,
    });

    const empty = await listGloGuideProducts({ mode: "auto" }, { now: NOW, store: fakeStore([]) });
    expect(empty).toEqual([]);
  });

  it("listGloGuideProducts auto：最近週因 usage 淨返 1 件合資格 → 正確 skip 落舊週", async () => {
    // 本週 2 件但 1 件用過 → 得 1 件合資格（唔夠 ≥2 門檻）→ fallback 上星期
    const store = fakeStore(
      [
        row({ id: 1, liveDate: THIS_WEEK.start }),
        row({ id: 2, liveDate: THIS_WEEK.start }),
        row({ id: 3, liveDate: LAST_WEEK.start }),
        row({ id: 4, liveDate: LAST_WEEK.start }),
      ],
      { 1: 101 },
    );
    const refs = await listGloGuideProducts({ mode: "auto" }, { now: NOW, store });
    expect(refs.map((r) => r.id)).toEqual([4, 3]); // 上星期完整 rows，唔會回本週
  });
});

// ──────────────────────────── week／session 來源 ────────────────────────────

describe("week／session 手動來源", () => {
  it("week 查詢回嗰週全部直播商品（唔合資格都回，標原因）；唔會混其他週；store 收 compact YYYYMMDD 範圍", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: "20261117" }),
      row({ id: 2, liveDate: "20261118", stock: 0 }),
      row({ id: 3, liveDate: "20261109" }), // 上星期，唔應該出現
      row({ id: 4, liveDate: null }), // 普通商品，唔應該出現
    ]);
    const refs = await listGloGuideProducts(
      { mode: "week", weekStart: "2026-11-16" }, // wire 係 dash；內部轉 compact 先落 DB
      { now: NOW, store },
    );
    // 回歸閘：store 一定要收到 compact YYYYMMDD（products.liveDate 格式），唔係 dash
    expect(store.calls.filter((c) => c.fn === "liveInRange")[0]!.args).toEqual(["20261116", "20261122"]);
    expect(refs.map((r) => r.id)).toEqual([2, 1]);
    expect(refs.find((r) => r.id === 2)).toMatchObject({ eligible: false, ineligibleReason: "out_of_stock" });
  });

  it("week 生成：唔指定 productIds → 該週合資格池隨機抽 2–3 件；少於 2 件 → 409 唔跨來源", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: "20261110" }),
      row({ id: 2, liveDate: "20261111" }),
      row({ id: 3, liveDate: "20261112" }),
      row({ id: 9, liveDate: THIS_WEEK.start }), // 本週有貨都唔准跨來源
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "week", weekStart: "20261109" },
      { now: NOW, store, rng: mulberry32(11) },
    );
    // 隨機抽 3 件、全部屬指定嗰週（唔會跨來源）
    expect(resolved.products).toHaveLength(3);
    expect(resolved.products.map((p) => p.id).sort()).toEqual([1, 2, 3]);

    const short = fakeStore([row({ id: 1, liveDate: "20261110" }), row({ id: 9, liveDate: THIS_WEEK.start })]);
    await expect(
      resolveGenerateProducts({ mode: "week", weekStart: "20261109" }, { now: NOW, store: short }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    // 證明冇跨來源：只查過指定嗰週一次
    expect(short.calls.filter((c) => c.fn === "liveInRange")).toHaveLength(1);
  });

  it("week 生成：指定 productIds 必須屬該週；唔屬 → 400；屬嘅按輸入次序", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: "20261110" }),
      row({ id: 2, liveDate: "20261111" }),
      row({ id: 9, liveDate: THIS_WEEK.start }),
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "week", weekStart: "20261109", productIds: [2, 1] },
      { now: NOW, store },
    );
    expect(resolved.products.map((p) => p.id)).toEqual([2, 1]);
    await expect(
      resolveGenerateProducts(
        { mode: "week", weekStart: "20261109", productIds: [1, 9] },
        { now: NOW, store },
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("session 生成：場次歸屬閘＋少於 2 件 409；查詢只限該場次", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: "20261120", liveSession: "1" }),
      row({ id: 2, liveDate: "20261120", liveSession: "2" }),
      row({ id: 3, liveDate: "20261120", liveSession: "2" }),
    ]);
    const resolved = await resolveGenerateProducts(
      { mode: "session", liveDate: "20261120", liveSession: "2" },
      { now: NOW, store, rng: mulberry32(5) },
    );
    expect(resolved.products.map((p) => p.id).sort()).toEqual([2, 3]);
    await expect(
      resolveGenerateProducts(
        { mode: "session", liveDate: "20261120", liveSession: "2", productIds: [1, 2] },
        { now: NOW, store },
      ),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("唔屬於") as unknown as string });
    await expect(
      resolveGenerateProducts(
        { mode: "session", liveDate: "20261120", liveSession: "1" },
        { now: NOW, store },
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
});

// ──────────────────────────── products 直接指定 ────────────────────────────

describe("products 直接指定（普通＋直播商品皆可；server 重查全部閘）", () => {
  it("普通商品（冇 liveDate）都揀得；2–3 件閘；唔存在 → 400", async () => {
    const store = fakeStore([row({ id: 1, liveDate: null }), row({ id: 2, liveDate: null })]);
    const resolved = await resolveGenerateProducts(
      { mode: "products", productIds: [1, 2] },
      { now: NOW, store },
    );
    expect(resolved.products.map((p) => p.id)).toEqual([1, 2]);
    await expect(
      resolveGenerateProducts({ mode: "products", productIds: [1, 2, 3] }, { now: NOW, store }),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("唔存在") as unknown as string });
  });

  it("inactive／缺貨／到期下架／無圖／類別唔啱 → 400 真錯誤", async () => {
    const bad: Array<[Partial<GloGuideProductRow>, RegExp]> = [
      [{ isActive: false }, /已下架/],
      [{ stock: 0 }, /已缺貨/],
      [{ delistEnabled: true, delistAt: new Date("2026-11-01T00:00:00+08:00") }, /自動下架/],
      [{ image: "" }, /冇商品圖/],
      [{ category: "skincare" }, /服飾／飾品/],
    ];
    for (const [over, re] of bad) {
      const store = fakeStore([row({ id: 1, ...over }), row({ id: 2 })]);
      await expect(
        resolveGenerateProducts({ mode: "products", productIds: [1, 2] }, { now: NOW, store }),
      ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(re) as unknown as string });
    }
  });
});

// ──────────────────────────── 永久去重／同一文章排除自身 ────────────────────────────

describe("永久去重（gloGuideProductUsage 歷史係唯一真相）", () => {
  it("其他文章用過 → 409，就算篇文已刪 link（usage 唔會被 update 抹走）", async () => {
    // 模擬「文章 101 用過商品 1，之後 update 刪咗 link」：usage 仲有紀錄 → 永遠唔准重用
    const store = fakeStore([row({ id: 1 }), row({ id: 2 })], { 1: 101 });
    await expect(
      resolveGenerateProducts({ mode: "products", productIds: [1, 2] }, { now: NOW, store }),
    ).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("唔可以重用") as unknown as string });
  });

  it("week 明確 ids 撞 usage → 409 重用閘；week 無 ids 隨機抽會避開用過嘅（used 唔入合資格池）", async () => {
    const wk = fakeStore(
      [
        row({ id: 1, liveDate: "20261110" }),
        row({ id: 2, liveDate: "20261111" }),
        row({ id: 3, liveDate: "20261112" }),
      ],
      { 1: 101 },
    );
    // 明確指定用過嘅貨 → 真正重用閘（唔係 insufficient）
    await expect(
      resolveGenerateProducts(
        { mode: "week", weekStart: "20261109", productIds: [1, 2] },
        { now: NOW, store: wk },
      ),
    ).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("唔可以重用") as unknown as string });
    // 無 ids：合資格池得 {2,3} → 隨機抽 2 件，用過嘅 1 永遠唔會中
    const resolved = await resolveGenerateProducts(
      { mode: "week", weekStart: "20261109" },
      { now: NOW, store: wk, rng: mulberry32(7) },
    );
    expect(resolved.products.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  it("同一文章（excludeArticleId）可保留自身商品；selfClaimedIds 標記唔使再 claim", async () => {
    const store = fakeStore([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })], { 1: 55, 2: 55, 3: 77 });
    // 文章 55 改貨：保留自身 1、2 得；想加 3（屬文章 77）→ 409
    const ok = await resolveGenerateProducts(
      { mode: "products", productIds: [1, 2] },
      { now: NOW, store, excludeArticleId: 55 },
    );
    expect(ok.products.map((p) => p.id)).toEqual([1, 2]);
    expect(ok.selfClaimedIds).toEqual([1, 2]);
    await expect(
      resolveGenerateProducts(
        { mode: "products", productIds: [1, 3] },
        { now: NOW, store, excludeArticleId: 55 },
      ),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
});

// ──────────────────────────── claimProductUsage（DB PK 並發閘）────────────────────────────

describe("claimProductUsage", () => {
  it("正常寫入：insert 收到 productId＋firstArticleId", async () => {
    const values: unknown[] = [];
    const tx = { insert: () => ({ values: (v: unknown) => { values.push(v); return Promise.resolve(); } }) };
    await claimProductUsage(tx as never, 42, [7, 8]);
    expect(values).toEqual([[{ productId: 7, firstArticleId: 42 }, { productId: 8, firstArticleId: 42 }]]);
  });

  it("23505 PK 撞（並發搶用）→ 可讀 409 conflict；其他錯照抛", async () => {
    const dup = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "gloGuideProductUsage_pkey",
    });
    const txDup = { insert: () => ({ values: () => Promise.reject(dup) }) };
    await expect(claimProductUsage(txDup as never, 42, [7])).rejects.toMatchObject({
      httpStatus: 409,
      code: "CONFLICT",
      message: expect.stringContaining("搶先使用") as unknown as string,
    });
    const boom = new Error("db down");
    const txBoom = { insert: () => ({ values: () => Promise.reject(boom) }) };
    await expect(claimProductUsage(txBoom as never, 42, [7])).rejects.toBe(boom);
  });

  it("isProductUsageViolation：PK 名大小寫兩種都認；其他 constraint 唔認", () => {
    expect(
      isProductUsageViolation(Object.assign(new Error("x"), { code: "23505", constraint: "gloGuideProductUsage_pkey" })),
    ).toBe(true);
    expect(
      isProductUsageViolation(Object.assign(new Error("x"), { code: "23505", constraint: "gloguideproductusage_idx" })),
    ).toBe(true);
    expect(
      isProductUsageViolation(Object.assign(new Error("x"), { code: "23505", constraint: "gloguidejobs_idempotency" })),
    ).toBe(false);
    expect(isProductUsageViolation(new Error("x"))).toBe(false);
  });
});

// ──────────────────────────── productSources 概覽 ────────────────────────────

describe("listGloGuideProductSources", () => {
  it("星期（週一起計）＋場次分組，total/eligible 計數，新→舊排", async () => {
    const store = fakeStore(
      [
        row({ id: 1, liveDate: "20261117", liveSession: "1" }),
        row({ id: 2, liveDate: "20261117", liveSession: "1", stock: 0 }), // 缺貨唔合資格
        row({ id: 3, liveDate: "20261118", liveSession: "2" }),
        row({ id: 4, liveDate: "20261110", liveSession: "1" }),
        row({ id: 5, liveDate: "20261110", liveSession: null }), // 直播日但冇場次 → 只計星期
        row({ id: 6, liveDate: null }), // 普通商品唔入來源
      ],
      { 3: 101 }, // 商品 3 用過 → 唔合資格
    );
    const out = await listGloGuideProductSources({ now: NOW, store });
    // 窗＝最舊直播貨嗰週（20261110 → 週一 20261109）→ 本週尾
    expect(store.calls.filter((c) => c.fn === "liveInRange")[0]!.args).toEqual([
      "20261109",
      THIS_WEEK.end,
    ]);
    expect(out.weeks).toEqual([
      { weekStart: "2026-11-16", weekEnd: "2026-11-22", total: 3, eligible: 1 },
      { weekStart: "2026-11-09", weekEnd: "2026-11-15", total: 2, eligible: 2 },
    ]);
    expect(out.sessions).toEqual([
      { liveDate: "20261118", liveSession: "2", total: 1, eligible: 0 },
      { liveDate: "20261117", liveSession: "1", total: 2, eligible: 1 },
      { liveDate: "20261110", liveSession: "1", total: 1, eligible: 1 },
    ]);
  });

  it("回歸：超過 8 週前嘅舊場次／星期都列出（唔准有固定週窗）；全庫冇直播貨 → 空", async () => {
    const store = fakeStore([
      row({ id: 1, liveDate: "20260701", liveSession: "3" }), // 20 週前
      row({ id: 2, liveDate: THIS_WEEK.start, liveSession: "1" }),
    ]);
    const out = await listGloGuideProductSources({ now: NOW, store });
    expect(out.weeks.map((w) => w.weekStart)).toEqual(["2026-11-16", "2026-06-29"]);
    expect(out.sessions.map((s) => `${s.liveDate}#${s.liveSession}`)).toEqual([
      "20261116#1",
      "20260701#3",
    ]);
    const empty = await listGloGuideProductSources({ now: NOW, store: fakeStore([]) });
    expect(empty).toEqual({ weeks: [], sessions: [] });
  });
});

// ──────────────────────────── search 查詢 ────────────────────────────

describe("search：普通商品及直播商品都搵到", () => {
  it("按名搜；普通商品（冇 liveDate）都回；連 usedBefore/eligible", async () => {
    const store = fakeStore(
      [
        row({ id: 1, name: "黑色連身裙", liveDate: null }),
        row({ id: 2, name: "碎花連身裙", liveDate: "20261117" }),
        row({ id: 3, name: "衛衣" }),
      ],
      { 2: 101 },
    );
    const refs = await listGloGuideProducts({ mode: "search", query: "連身裙" }, { now: NOW, store });
    expect(refs.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(refs.find((r) => r.id === 2)).toMatchObject({ usedBefore: true, eligible: false });
  });
});

// ──────────────────────────── schema／migration／service 接線 source guard ────────────────────────────

describe("永久去重接線（source guard，防回歸）", () => {
  const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8");

  it("db/schema.ts 有 gloGuideProductUsage（productId PK＋firstArticleId）", () => {
    const schema = read("../db/schema.ts");
    expect(schema).toContain('pgTable("gloGuideProductUsage"');
    expect(schema).toMatch(/productId:\s*integer\("productId"\)\.primaryKey\(\)/);
    expect(schema).toContain('"firstArticleId"');
  });

  it("boot-migrate DDL 建新表＋由 gloGuideArticleProducts 回填（idempotent）", () => {
    const boot = read("boot-migrate.ts");
    expect(boot).toContain('CREATE TABLE IF NOT EXISTS "gloGuideProductUsage"');
    expect(boot).toMatch(/INSERT INTO "gloGuideProductUsage"[\s\S]*FROM "gloGuideArticleProducts"[\s\S]*ON CONFLICT \("productId"\) DO NOTHING/);
  });

  it("migration 檔 0003 同 boot-migrate 一致（建表＋回填）", () => {
    const mig = read("../db/migrations/0003_glo_guide_product_usage.sql");
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS "gloGuideProductUsage"');
    expect(mig).toContain('"productId" integer PRIMARY KEY');
    expect(mig).toMatch(/INSERT INTO "gloGuideProductUsage"[\s\S]*ON CONFLICT \("productId"\) DO NOTHING/);
  });

  it("generateArticle：selection 規範化＋server 重查揀貨＋同一 tx 寫 usage", () => {
    const src = read("gloGuideService.ts");
    const gen = src.slice(src.indexOf("export async function generateArticle"), src.indexOf("export async function recordFailedScheduledSlot"));
    expect(gen).toContain("normalizeGenerateSelection");
    expect(gen).toContain("resolveGenerateProducts(selection)");
    // whitespace-insensitive：prettier 可能拆行，淨係關心真係同一 tx claim
    expect(gen).toMatch(/claimProductUsage\(\s*tx,\s*article\.id/);
    expect(gen).toContain("db.transaction");
    // 唔准再用舊「本週先得」閘做生成入口
    expect(gen).not.toContain("唔係本週可選貨");
  });

  it("updateArticle：鎖內重查歷史、同一文章排除自身、絕對唔刪 usage 歷史", () => {
    const src = read("gloGuideService.ts");
    const upd = src.slice(src.indexOf("export async function updateArticle"), src.indexOf("export async function submitArticle"));
    expect(upd).toContain("excludeArticleId: input.id");
    // whitespace-insensitive：call site 拆行都認到
    expect(upd).toMatch(/claimProductUsage\(\s*tx,\s*input\.id/);
    expect(upd).toContain("db.transaction");
    expect(upd).toContain("FOR UPDATE");
    // 改貨唔准刪歷史（成個 service 都唔准 delete usage 表）
    expect(src).not.toContain("delete(gloGuideProductUsage)");
  });

  it("scheduler 唔使改都經 generateArticle({}) 行新 auto fallback", () => {
    const sched = read("gloGuideScheduler.ts");
    expect(sched).toMatch(/generateArticle\(\s*\{ id: 0, name: "系統自動排程", role: "admin" \},\s*\{\},/);
  });
});

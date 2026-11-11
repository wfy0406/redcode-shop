/**
 * products.disableAiTags＋公開 byId AI 標籤 DTO focused tests——
 * 全部經 productsRouter.createCaller 真跑 middleware＋input 驗證＋resolver，
 * DB 隔離 mock（thenable chain），**唔掂真 DB**。
 *
 * 覆蓋（2026-11 合約 v2）：
 * 1) 權限：staff／member／未登入 → FORBIDDEN／UNAUTHORIZED，DB 零寫入（update 冇執行、冇 audit）；
 *    supervisor／admin 每 request 以 DB 覆核角色後先放行（降職 → FORBIDDEN、刪帳號 → UNAUTHORIZED）。
 * 2) 成功停用：1–100 個唯一 ids；update 淨係 set { aiTagsEnabled:false }（內容保留）；
 *    where 係 products.id IN (...)；寫一條 product.disableAiTags audit。
 * 3) input 閘：重複 id／空 array／>100／非正整數 → BAD_REQUEST，resolver 未執行（零寫入）。
 * 4) 公開 byId DTO：aiTagsEnabled=false 一律回 aiTags:[]；回應唔泄 aiTagsEnabled 開關／raw JSON；
 *    enabled=true 先 parse 出 tags；搵唔到 → NOT_FOUND。
 *
 * ⚠️ 界限：DB 全 mock，真 PostgreSQL 行為（IN 上限、audit 落庫）要靠 integration 驗。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: string },
    // middleware 每 request 以 users PK 覆核角色；undefined＝跟 JWT role；null＝帳號已刪
    dbRole: null as string | null,
    userRoleColumn: null as any,
    queue: [] as any[],
    selects: [] as { selection?: any; authRoleQuery: boolean }[],
    updates: [] as { set?: any; where?: any; returning?: any }[],
    inserts: [] as { table?: any; values?: any; onConflictDoNothing?: boolean }[],
    findFirstResult: undefined as any,
  };
  const pop = () => (state.queue.length > 0 ? state.queue.shift() : []);
  /** select chain：middleware 嘅 role 覆核直接回 dbRole；業務查詢行 queue */
  function makeSelectChain(rec: { authRoleQuery: boolean }) {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const value = rec.authRoleQuery
              ? state.dbRole
                ? [{ role: state.dbRole }]
                : []
              : pop();
            return (res: any, rej: any) =>
              (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(
                res,
                rej,
              );
          }
          if (prop === "catch") {
            return (fn: any) => Promise.resolve(pop()).catch(fn);
          }
          return (..._args: any[]) => chain;
        },
      },
    );
    return chain;
  }
  const db: any = {
    select: (selection?: any) => {
      const rec = {
        selection,
        authRoleQuery: Boolean(
          selection &&
            Object.keys(selection).length === 1 &&
            state.userRoleColumn &&
            selection.role === state.userRoleColumn,
        ),
      };
      state.selects.push(rec);
      return makeSelectChain(rec);
    },
    update: (_table?: any) => {
      const rec: { set?: any; where?: any; returning?: any } = {};
      state.updates.push(rec);
      const chain: any = {
        set: (v: any) => {
          rec.set = v;
          return chain;
        },
        where: (c: any) => {
          rec.where = c;
          return chain;
        },
        returning: (sel?: any) => {
          rec.returning = sel;
          const v = pop();
          return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
        },
      };
      return chain;
    },
    // L2：disableAiTags 會將受影響 SKU 寫入 productAiTagsTombstones（onConflictDoNothing）
    insert: (table?: any) => {
      const rec: { table?: any; values?: any; onConflictDoNothing?: boolean } = { table };
      state.inserts.push(rec);
      const chain: any = {
        values: (v: any) => {
          rec.values = v;
          return chain;
        },
        onConflictDoNothing: () => {
          rec.onConflictDoNothing = true;
          return Promise.resolve(pop());
        },
        returning: () => Promise.resolve(pop()),
      };
      return chain;
    },
    query: {
      products: {
        findFirst: async () => state.findFirstResult,
      },
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => h.state.user),
  verifyToken: vi.fn(async () => h.state.user),
}));
vi.mock("./lib/env", () => ({
  env: { appSecret: "unit-test-secret", appId: "unit-test", databaseUrl: "", isProduction: false },
}));
vi.mock("./audit", () => ({ logAudit: vi.fn() }));

import { productsRouter } from "./productsRouter";
import { logAudit } from "./audit";
import { users } from "@db/schema";

h.state.userRoleColumn = users.role;

// ───────────────────────── helpers ─────────────────────────

function caller(authed = true) {
  return productsRouter.createCaller({
    req: new Request("http://test.local/api/trpc", {
      headers: authed ? { authorization: "Bearer x" } : {},
    }),
    resHeaders: new Headers(),
  } as any);
}

function reset(
  user: { userId: number; role: string } | null = { userId: 9001, role: "supervisor" },
  dbRole?: string | null,
) {
  h.state.user = user;
  h.state.dbRole = dbRole === undefined ? (user?.role ?? null) : dbRole;
  h.state.queue = [];
  h.state.selects = [];
  h.state.updates = [];
  h.state.inserts = [];
  h.state.findFirstResult = undefined;
  vi.mocked(logAudit).mockClear();
}

/** middleware 有冇真係每 request 打 DB 覆核角色 */
const roleRechecks = () => h.state.selects.filter((s) => s.authRoleQuery).length;

const pgDialect = new PgDialect();
function whereSig(where: any): { sql: string; params: any[] } {
  expect(where, "呢個 statement 冇 where 條件可斷言").toBeTruthy();
  const q = pgDialect.sqlToQuery(where);
  return { sql: q.sql, params: q.params };
}

/** 完整 DB 行（刻意帶 raw aiTags JSON＋內部開關，證明公開 DTO 會剝走／閂走） */
function makeRawProduct(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 42,
    sku: "LU8",
    name: "測試商品",
    description: "AI 描述",
    image: "https://img.example/1.jpg",
    photos: ["https://img.example/1.jpg"],
    price: 100,
    discountPrice: null,
    sizes: null,
    sizeEnabled: true,
    note: null,
    category: "other",
    listedDate: new Date("2026-11-01T00:00:00Z"),
    stock: 3,
    isActive: true,
    delistEnabled: false,
    delistAt: null,
    liveDate: null,
    liveSession: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    aiTags: '["熱賣","新品"]',
    aiTagsEnabled: true,
    ...overrides,
  };
}

// ───────────────────────── 1) 權限閘 ─────────────────────────

describe("disableAiTags 權限：主管級先准", () => {
  beforeEach(() => reset());

  it("staff → FORBIDDEN，DB 零寫入、零 audit", async () => {
    reset({ userId: 1001, role: "staff" });
    await expect(caller().disableAiTags({ ids: [1, 2] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.state.updates).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
    expect(roleRechecks()).toBe(1); // 每 request 真係有打 DB 覆核
  });

  it("member → FORBIDDEN，DB 零寫入", async () => {
    reset({ userId: 2001, role: "member" });
    await expect(caller().disableAiTags({ ids: [1] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.state.updates).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("未登入 → UNAUTHORIZED，DB 零寫入", async () => {
    reset(null);
    await expect(caller(false).disableAiTags({ ids: [1] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(h.state.updates).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("每 request DB 覆核：JWT 係 supervisor 但 DB 已降職做 staff → FORBIDDEN", async () => {
    reset({ userId: 3001, role: "supervisor" }, "staff");
    await expect(caller().disableAiTags({ ids: [1] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(roleRechecks()).toBe(1);
    expect(h.state.updates).toHaveLength(0);
  });

  it("每 request DB 覆核：帳號已刪（DB 搵唔到）→ UNAUTHORIZED", async () => {
    reset({ userId: 3002, role: "supervisor" }, null);
    await expect(caller().disableAiTags({ ids: [1] })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(roleRechecks()).toBe(1);
    expect(h.state.updates).toHaveLength(0);
  });
});

// ───────────────────────── 2) 成功停用（supervisor／admin）─────────────────────────

describe("disableAiTags 成功路徑", () => {
  beforeEach(() => reset());

  it("supervisor 停用 3 件：淨 set aiTagsEnabled=false、where 係 id IN、寫 audit、回 count；SKU 寫入 tombstones（L2）", async () => {
    h.state.queue = [
      [{ id: 11, sku: "SKU-11" }, { id: 22, sku: "SKU-22" }, { id: 33, sku: "SKU-33" }],
    ];
    const res = await caller().disableAiTags({ ids: [11, 22, 33] });
    expect(res).toEqual({ ok: true, count: 3 });

    // 唯一一次 update；set 係**完全得** { aiTagsEnabled: false }（內容欄唔郁）
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0].set).toEqual({ aiTagsEnabled: false });
    expect(Object.keys(h.state.updates[0].set)).toEqual(["aiTagsEnabled"]);

    const sig = whereSig(h.state.updates[0].where);
    expect(sig.sql).toContain('"products"."id" in');
    expect(sig.params).toEqual([11, 22, 33]);

    // L2：受影響 SKU 全部記入 productAiTagsTombstones，onConflictDoNothing 冪等
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.inserts[0].values).toEqual([
      { sku: "SKU-11" },
      { sku: "SKU-22" },
      { sku: "SKU-33" },
    ]);
    expect(h.state.inserts[0].onConflictDoNothing).toBe(true);

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 9001,
        actorRole: "supervisor",
        action: "product.disableAiTags",
        targetType: "product",
      }),
    );
  });

  it("admin 同樣准；單件 id 都得；已停用重送冇 hitting 行 → count 0（冪等），零行更新唔寫 tombstone", async () => {
    reset({ userId: 9002, role: "admin" });
    h.state.queue = [[]]; // DB 已停用／唔存在 → returning 空
    const res = await caller().disableAiTags({ ids: [7] });
    expect(res).toEqual({ ok: true, count: 0 });
    expect(h.state.updates[0].set).toEqual({ aiTagsEnabled: false });
    expect(whereSig(h.state.updates[0].where).params).toEqual([7]);
    expect(h.state.inserts).toHaveLength(0); // L2：冇行被停就唔會亂記 SKU
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it("上限 100 個 ids 啱啱好放行，100 個 SKU 全部記 tombstone", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    h.state.queue = [ids.map((id) => ({ id, sku: `SKU-${id}` }))];
    const res = await caller().disableAiTags({ ids });
    expect(res).toEqual({ ok: true, count: 100 });
    expect(whereSig(h.state.updates[0].where).params).toEqual(ids);
    expect(h.state.inserts).toHaveLength(1);
    expect(h.state.inserts[0].values).toHaveLength(100);
    expect(h.state.inserts[0].values[0]).toEqual({ sku: "SKU-1" });
  });
});

// ───────────────────────── 3) input 閘（supervisor 身份）─────────────────────────

describe("disableAiTags input 驗證", () => {
  beforeEach(() => reset());

  it("重複 id → BAD_REQUEST（ids 唔可以重複），零寫入", async () => {
    await expect(caller().disableAiTags({ ids: [5, 5] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller().disableAiTags({ ids: [5, 5] })).rejects.toThrow(/重複/);
    expect(h.state.updates).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("空 array → BAD_REQUEST，零寫入", async () => {
    await expect(caller().disableAiTags({ ids: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.state.updates).toHaveLength(0);
  });

  it("101 個 ids → BAD_REQUEST，零寫入", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(caller().disableAiTags({ ids })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.state.updates).toHaveLength(0);
  });

  it("非正整數 id（0／負數／小數）→ BAD_REQUEST", async () => {
    await expect(caller().disableAiTags({ ids: [0] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller().disableAiTags({ ids: [-3] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller().disableAiTags({ ids: [1.5] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.state.updates).toHaveLength(0);
  });
});

// ───────────────────────── 4) 公開 list／latest／byId DTO ─────────────────────────

describe("公開 list／latest：AI 標籤 DTO", () => {
  beforeEach(() => reset(null));

  it("商品清單：disabled 回 []、enabled 回已 parse tags；兩者都唔泄 raw JSON／enabled flag", async () => {
    h.state.queue = [[
      makeRawProduct({ id: 41, aiTagsEnabled: false }),
      makeRawProduct({ id: 42, aiTagsEnabled: true }),
    ]];
    const res = await caller(false).list();
    expect(res).toHaveLength(2);
    expect(res[0].aiTags).toEqual([]);
    expect(res[1].aiTags).toEqual(["熱賣", "新品"]);
    for (const row of res) {
      expect(row).not.toHaveProperty("aiTagsEnabled");
      expect(JSON.stringify(row)).not.toContain('\\"熱賣\\"');
    }
  });

  it("首頁最新商品：同一公開過濾，停用後唔會由另一個 endpoint 漏出", async () => {
    h.state.queue = [[makeRawProduct({ aiTagsEnabled: false })]];
    const res = await caller(false).latest({ limit: 8 });
    expect(res).toHaveLength(1);
    expect(res[0].aiTags).toEqual([]);
    expect(res[0]).not.toHaveProperty("aiTagsEnabled");
    expect(JSON.stringify(res[0])).not.toContain('\\"熱賣\\"');
  });
});

describe("公開 byId：AI 標籤 DTO", () => {
  beforeEach(() => reset(null));

  it("aiTagsEnabled=false → aiTags:[]，就算 DB 有內容都唔出；唔泄 enabled／raw 欄", async () => {
    h.state.findFirstResult = makeRawProduct({ aiTagsEnabled: false });
    const res = await caller(false).byId({ id: 42 });
    expect(res.aiTags).toEqual([]);
    expect(res).not.toHaveProperty("aiTagsEnabled");
    // raw JSON 字串唔會出現喺任何欄位
    expect(JSON.stringify(res)).not.toContain('\\"熱賣\\"');
    expect(res.name).toBe("測試商品"); // 其他公開欄照舊有
  });

  it("aiTagsEnabled=true → aiTags parse 出 string[]；enabled flag 一樣唔泄", async () => {
    h.state.findFirstResult = makeRawProduct({ aiTagsEnabled: true });
    const res = await caller(false).byId({ id: 42 });
    expect(res.aiTags).toEqual(["熱賣", "新品"]);
    expect(res).not.toHaveProperty("aiTagsEnabled");
  });

  it("壞 raw JSON＋enabled=true → aiTags:[]（公開路徑唔會因壞資料炸）", async () => {
    h.state.findFirstResult = makeRawProduct({ aiTags: "{唔係json", aiTagsEnabled: true });
    const res = await caller(false).byId({ id: 42 });
    expect(res.aiTags).toEqual([]);
  });

  it("搵唔到（下架／唔存在）→ NOT_FOUND", async () => {
    h.state.findFirstResult = undefined;
    await expect(caller(false).byId({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

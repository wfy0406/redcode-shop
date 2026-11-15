/** products.adminPage：staff 權限、input 閘、真 DB 分頁查詢合同（DB mock，唔掂生產）。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => {
  type Rec = {
    selection?: unknown;
    authRoleQuery: boolean;
    where?: any;
    limit?: number;
    offset?: number;
    orderBy?: any[];
    groupBy?: any[];
  };
  const state = {
    user: null as null | { userId: number; role: string },
    dbRole: null as string | null,
    userRoleColumn: null as any,
    queue: [] as any[],
    selects: [] as Rec[],
  };
  const pop = () => (state.queue.length ? state.queue.shift() : []);
  function selectChain(rec: Rec): any {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === "then") {
          const value = rec.authRoleQuery
            ? state.dbRole ? [{ role: state.dbRole }] : []
            : pop();
          return (resolve: any, reject: any) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(resolve, reject);
        }
        return (...args: any[]) => {
          if (prop === "where") rec.where = args[0];
          if (prop === "limit") rec.limit = args[0];
          if (prop === "offset") rec.offset = args[0];
          if (prop === "orderBy") rec.orderBy = args;
          if (prop === "groupBy") rec.groupBy = args;
          return selectChain(rec);
        };
      },
    });
  }
  const db = {
    select: (selection?: unknown) => {
      const rec: Rec = {
        selection,
        authRoleQuery: Boolean(
          selection && Object.keys(selection).length === 1 && state.userRoleColumn &&
          (selection as any).role === state.userRoleColumn,
        ),
      };
      state.selects.push(rec);
      return selectChain(rec);
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
vi.mock("./approvalGuard", () => ({ requestApprovalIfStaff: vi.fn() }));

import {
  adminProductPageMetadata,
  adminProductPageInputSchema,
  escapeAdminProductSearch,
  productsRouter,
} from "./productsRouter";
import { users } from "@db/schema";

h.state.userRoleColumn = users.role;
const dialect = new PgDialect();
const sqlText = (value: any) => dialect.sqlToQuery(value);

function caller(authed = true) {
  return productsRouter.createCaller({
    req: new Request("http://test.local/api/trpc", { headers: authed ? { authorization: "Bearer x" } : {} }),
    resHeaders: new Headers(),
  } as any);
}

function reset(user: { userId: number; role: string } | null = { userId: 1, role: "supervisor" }) {
  h.state.user = user;
  h.state.dbRole = user?.role ?? null;
  h.state.queue = [];
  h.state.selects = [];
}
const businessSelects = () => h.state.selects.filter((s) => !s.authRoleQuery);

beforeEach(() => reset());

describe("adminProductPage helpers / input", () => {
  it("LIKE wildcard 全部當字面；分頁會 clamp 最後頁，空結果固定第 1 頁", () => {
    expect(escapeAdminProductSearch("B%_\\2")).toBe("B\\%\\_\\\\2");
    expect(adminProductPageMetadata(225, 99, 50)).toEqual({ total: 225, totalPages: 5, page: 5, offset: 200 });
    expect(adminProductPageMetadata(0, 9, 200)).toEqual({ total: 0, totalPages: 1, page: 1, offset: 0 });
  });

  it("pageSize 只准 50/100/150/200；頁碼必須正整數；keyword trim", () => {
    for (const pageSize of [50, 100, 150, 200]) {
      expect(adminProductPageInputSchema.parse({ q: "  B244  ", pageSize })).toMatchObject({ q: "B244", pageSize, page: 1, sort: "created" });
    }
    for (const bad of [0, 1, 25, 49, 201, 50.5]) {
      expect(adminProductPageInputSchema.safeParse({ pageSize: bad }).success).toBe(false);
    }
    expect(adminProductPageInputSchema.safeParse({ page: 0 }).success).toBe(false);
    expect(adminProductPageInputSchema.safeParse({ createdDay: "20261116" }).success).toBe(false);
  });
});

describe("products.adminPage resolver", () => {
  it("名稱 OR 貨號搜尋＋分類＋香港日；total clamp、limit/offset、dailyCounts 分開計", async () => {
    const items = [{ id: 201, sku: "B244", name: "蕾絲花邊衫" }];
    h.state.queue = [
      [{ total: 225 }],
      [{ key: "2026-11-16", count: 225 }],
      items,
    ];
    const result = await caller().adminPage({
      q: " B%_\\2 ", category: "dress", createdDay: "2026-11-16", sort: "category", page: 99, pageSize: 50,
    });
    expect(result).toEqual({
      items, total: 225, page: 5, pageSize: 50, totalPages: 5,
      dailyCounts: [{ key: "2026-11-16", label: "11月16日", count: 225 }],
    });
    const queries = businessSelects();
    expect(queries).toHaveLength(3);
    const countWhere = sqlText(queries[0]!.where);
    expect(countWhere.sql).toContain("ilike");
    expect(countWhere.sql).toContain("escape");
    expect(countWhere.sql).toContain("Asia/Hong_Kong");
    expect(countWhere.params).toContain("%B\\%\\_\\\\2%");
    expect(countWhere.params).toContain("dress");
    expect(countWhere.params).toContain("2026-11-16");
    const dayWhere = sqlText(queries[1]!.where);
    expect(dayWhere.params).toContain("%B\\%\\_\\\\2%");
    expect(dayWhere.params).toContain("dress");
    expect(dayWhere.params).not.toContain("2026-11-16");
    expect(queries[1]!.groupBy).toHaveLength(1);
    expect(queries[2]!.limit).toBe(50);
    expect(queries[2]!.offset).toBe(200);
    expect(queries[2]!.orderBy?.some((part) => sqlText(part).sql.includes("array_position"))).toBe(true);
  });

  it("空結果唔再查 items；回真 total=0 同空 dailyCounts", async () => {
    h.state.queue = [[{ total: 0 }], []];
    const result = await caller().adminPage({ q: "冇貨", page: 3, pageSize: 200 });
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 200, totalPages: 1, dailyCounts: [] });
    expect(businessSelects()).toHaveLength(2);
  });

  it.each(["staff", "supervisor", "admin"])("%s 可以查；pageSize 100 原樣回", async (role) => {
    reset({ userId: 1, role });
    h.state.queue = [[{ total: 1 }], [{ key: "2026-11-01", count: 1 }], [{ id: 7 }]];
    const result = await caller().adminPage({ pageSize: 100, sort: "name" });
    expect(result.pageSize).toBe(100);
    expect(result.items).toEqual([{ id: 7 }]);
    expect(businessSelects()[2]!.limit).toBe(100);
  });

  it("member／未登入被拒；無效 pageSize 唔入 resolver", async () => {
    reset({ userId: 1, role: "member" });
    await expect(caller().adminPage({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    reset(null);
    await expect(caller(false).adminPage({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    reset();
    await expect(caller().adminPage({ pageSize: 25 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(businessSelects()).toHaveLength(0);
  });
});

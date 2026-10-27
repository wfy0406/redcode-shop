/**
 * 後台 AI 試穿紀錄（tryon.listAdminRecords）focused tests——mock DB（thenable chain）＋mock auth。
 * 覆蓋：
 * - 權限：admin／supervisor 允許；staff／member／未登入拒絕；DB 角色覆核（降職／刪帳號）
 * - 一套造型兩件商品 → 逐件兩列（第幾件 stepNumber）
 * - 商品品名／貨號用生成時 snapshot；已刪商品 exists=false 仍顯示 snapshot；改過名 changed=true
 * - pagination（limit/offset/total/totalPages）＋ member/product/status filter（SQL＋params 斷言、%_\\ escape）
 * - response 絕無私人媒體／內部技術欄位（inputImagePath/outputImagePath/provider/cost/credits/prompt…）
 *
 * ⚠️ 界限：DB 全部 mock，冇真 PostgreSQL；ilike escape 嘅實際 DB 行為要靠 integration 先驗到。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: string },
    // middleware 每 request 以 users PK 覆核角色；undefined＝reset 時跟 JWT role
    dbRole: null as string | null,
    userRoleColumn: null as any,
    queue: [] as any[],
    // 記低每個 select 嘅 from/where/limit/offset（filter／pagination SQL 斷言用）
    selects: [] as {
      selection?: any;
      from?: any;
      where?: any;
      limit?: number;
      offset?: number;
      authRoleQuery: boolean;
    }[],
  };
  const pop = () => (state.queue.length > 0 ? state.queue.shift() : []);
  const settle = (rec?: { authRoleQuery?: boolean }) => {
    // 只攔截 middleware 嘅 { role } 覆核查詢；業務查詢行 queue
    if (rec?.authRoleQuery) {
      return Promise.resolve(state.dbRole ? [{ role: state.dbRole }] : []);
    }
    const v = pop();
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  function makeChain(rec: NonNullable<Parameters<typeof settle>[0]> & Record<string, any>) {
    const chain: any = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (res: any, rej: any) => settle(rec).then(res, rej);
          }
          if (prop === "catch") {
            return (fn: any) => settle(rec).catch(fn);
          }
          return (...args: any[]) => {
            if (prop === "from") rec.from = args[0];
            if (prop === "where") rec.where = args[0];
            if (prop === "limit") rec.limit = args[0];
            if (prop === "offset") rec.offset = args[0];
            return chain;
          };
        },
      },
    );
    return chain;
  }
  const db: any = {
    select: (selection?: any) => {
      const rec: Record<string, any> = {
        selection,
        from: undefined,
        where: undefined,
        limit: undefined,
        offset: undefined,
        authRoleQuery: Boolean(
          selection &&
            Object.keys(selection).length === 1 &&
            state.userRoleColumn &&
            selection.role === state.userRoleColumn,
        ),
      };
      state.selects.push(rec as any);
      return makeChain(rec as any);
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
// tryonRouter 其他 endpoint 用嘅 service 全部 stub——呢個測試淨係驗 listAdminRecords。
vi.mock("./tryonService", () => ({
  createTryOnGeneration: vi.fn(),
  deleteOwnedTryOnMedia: vi.fn(),
  getMyTryOnAccess: vi.fn(),
  getOwnedTryOnJob: vi.fn(),
  getTryOnAdminStats: vi.fn(),
  getTryOnSettings: vi.fn(),
  listTryOnProducts: vi.fn(),
  saveTryOnSettings: vi.fn(),
  tryOnMediaSecretConfigured: vi.fn(),
}));

import { tryonRouter } from "./tryonRouter";
import { getTryOnAdminRecordMedia, listTryOnAdminRecords } from "./tryonAdminRecords";
import { TRYON_ADMIN_ARCHIVE_RETENTION_MS } from "./tryonAdminArchive";
import { users } from "@db/schema";

h.state.userRoleColumn = users.role;

// ───────────────────────── helpers ─────────────────────────

function caller() {
  return tryonRouter.createCaller({
    req: new Request("http://test.local/api/trpc", { headers: { authorization: "Bearer x" } }),
    resHeaders: new Headers(),
  } as any);
}

function reset(user: { userId: number; role: string } | null = { userId: 9001, role: "admin" }, dbRole?: string | null) {
  h.state.user = user;
  h.state.dbRole = dbRole === undefined ? (user?.role ?? null) : dbRole;
  h.state.queue = [];
  h.state.selects = [];
}

/** 業務查詢（排除 middleware 嘅 role 覆核 select） */
const bizSelects = () => h.state.selects.filter((s) => !s.authRoleQuery);

const pgDialect = new PgDialect();
function whereSig(where: any): { sql: string; params: any[] } {
  expect(where, "呢個 statement 冇 where 條件可斷言").toBeTruthy();
  const q = pgDialect.sqlToQuery(where);
  return { sql: q.sql, params: q.params };
}

/** 完整 DB 行（刻意包晒私人／內部欄位，證明 response mapping 會剥走佢哋） */
function makeRawRow(overrides: Record<string, any> = {}): Record<string, any> {
  const now = new Date("2026-10-25T10:00:00Z");
  return {
    jobId: 11,
    publicId: "123e4567-e89b-42d3-a456-426614174000",
    lookId: "223e4567-e89b-42d3-a456-426614174000",
    stepNumber: 1,
    status: "completed",
    failureCode: null,
    mediaDeletedAt: null,
    expiresAt: new Date("2026-10-26T10:00:00Z"),
    createdAt: now,
    startedAt: now,
    completedAt: new Date("2026-10-25T10:01:00Z"),
    memberId: 7,
    memberName: "陳小明",
    memberPhone: "91234567",
    productId: 101,
    productName: "生成時品名快照",
    productSku: "TOP-101",
    productCategory: "top",
    tryOnKind: "top",
    currentProductName: "生成時品名快照",
    currentProductSku: "TOP-101",
    // ↓ 私隱紅線欄位：response 絕對唔准出現
    inputImagePath: "private-media/secret-input-aaa.jpg",
    outputImagePath: "private-media/secret-output-bbb.jpg",
    productImagePath: "/uploads/product-101.png",
    provider: "fashn",
    providerJobId: "fashn-job-999",
    generationMode: "quality",
    resolution: "1k",
    creditsReserved: 3,
    creditsUsed: 3,
    estimatedCostCents: 30,
    unitCreditCostCents: 10,
    idempotencyKey: "op-secret-key-1",
    requestHash: "f".repeat(64),
    failureMessage: "供應商內部錯誤原文",
    ...overrides,
  };
}

const queuePage = (total: number, rows: any[]) => {
  h.state.queue.push([{ value: total }], rows);
};

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

// ───────────────────────── 權限 ─────────────────────────

describe("listAdminRecords 權限（最小必要：supervisor／admin）", () => {
  it("未登入 → UNAUTHORIZED", async () => {
    reset(null);
    await expect(caller().listAdminRecords({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(h.state.queue.length).toBe(0); // 冇行到業務查詢
  });

  it("member → FORBIDDEN", async () => {
    reset({ userId: 9101, role: "member" });
    await expect(caller().listAdminRecords({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.state.queue.length).toBe(0);
  });

  it("staff（入到其他後台頁）→ FORBIDDEN", async () => {
    reset({ userId: 9102, role: "staff" });
    await expect(caller().listAdminRecords({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.state.queue.length).toBe(0);
  });

  it("supervisor → 過到權限關並攞到真實列表", async () => {
    reset({ userId: 9103, role: "supervisor" });
    queuePage(1, [makeRawRow()]);
    const res = await caller().listAdminRecords({});
    expect(res.total).toBe(1);
    expect(res.items[0]?.member?.name).toBe("陳小明");
  });

  it("admin → 過到權限關並攞到真實列表", async () => {
    reset({ userId: 9104, role: "admin" });
    queuePage(0, []);
    const res = await caller().listAdminRecords({});
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
  });

  it("JWT 係 admin 但 DB 已降做 member → FORBIDDEN；帳號已刪 → UNAUTHORIZED", async () => {
    reset({ userId: 9105, role: "admin" }, "member");
    await expect(caller().listAdminRecords({})).rejects.toMatchObject({ code: "FORBIDDEN" });

    reset({ userId: 9106, role: "admin" }, null);
    await expect(caller().listAdminRecords({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("輸入驗證：page<1／pageSize>50／status 無效 → BAD_REQUEST", async () => {
    reset({ userId: 9107, role: "admin" });
    await expect(caller().listAdminRecords({ page: 0 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().listAdminRecords({ pageSize: 51 } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller().listAdminRecords({ status: "bogus" } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ───────────────────────── service 行為（直接呼叫，mock DB）─────────────────────────

describe("listTryOnAdminRecords 資料內容", () => {
  it("一套造型兩件商品 → 逐件兩列，各帶自己嘅 job/商品/第幾件", async () => {
    const row1 = makeRawRow({ jobId: 11, stepNumber: 1, productName: "白色恤衫", productSku: "TOP-101", productId: 101 });
    const row2 = makeRawRow({
      jobId: 12,
      publicId: "323e4567-e89b-42d3-a456-426614174000",
      stepNumber: 2,
      productName: "牛仔褲",
      productSku: "BTM-202",
      productId: 202,
      productCategory: "pants",
      tryOnKind: "pants",
      currentProductName: "牛仔褲",
      currentProductSku: "BTM-202",
      status: "processing",
      completedAt: null,
    });
    queuePage(2, [row2, row1]); // id desc：新嘅（第 2 件）排先
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
    // 逐件獨立成列：同一 lookId、唔同 job／商品／第幾件
    expect(res.items[0]?.lookId).toBe(row1.lookId);
    expect(res.items[1]?.lookId).toBe(row1.lookId);
    expect(res.items.map((i) => i.stepNumber)).toEqual([2, 1]);
    expect(res.items.map((i) => i.product.name)).toEqual(["牛仔褲", "白色恤衫"]);
    expect(res.items.map((i) => i.product.sku)).toEqual(["BTM-202", "TOP-101"]);
    expect(res.items.map((i) => i.publicId)).toEqual([row2.publicId, row1.publicId]);
    expect(res.items[0]?.status).toBe("processing");
  });

  it("商品已刪除 → exists=false 仍顯示生成時 snapshot 品名/貨號；改過名 → changed=true", async () => {
    const deleted = makeRawRow({
      jobId: 21,
      productName: "已落架連身裙",
      productSku: "DRS-303",
      currentProductName: null,
      currentProductSku: null,
    });
    const renamed = makeRawRow({
      jobId: 22,
      productName: "舊品名",
      productSku: "TOP-404",
      currentProductName: "新品名",
      currentProductSku: "TOP-404",
    });
    queuePage(2, [renamed, deleted]);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    const gone = res.items.find((i) => i.jobId === 21);
    const changed = res.items.find((i) => i.jobId === 22);
    expect(gone?.product.exists).toBe(false);
    expect(gone?.product.name).toBe("已落架連身裙");
    expect(gone?.product.sku).toBe("DRS-303");
    expect(gone?.product.changed).toBe(false);
    expect(changed?.product.exists).toBe(true);
    expect(changed?.product.changed).toBe(true);
    expect(changed?.product.name).toBe("舊品名"); // 顯示 snapshot
    expect(changed?.product.currentName).toBe("新品名");
  });

  it("會員 join 唔到（已刪帳號）→ member=null；媒體已刪 → mediaDeleted=true（唔出時間戳）", async () => {
    const row = makeRawRow({ memberId: null, memberName: null, memberPhone: null, mediaDeletedAt: new Date() });
    queuePage(1, [row]);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    expect(res.items[0]?.member).toBeNull();
    expect(res.items[0]?.mediaDeleted).toBe(true);
    expect(JSON.stringify(res.items[0])).not.toContain("mediaDeletedAt");
  });

  it("pagination：page=2 pageSize=10 → limit 10 offset 10；totalPages 正確", async () => {
    queuePage(25, [makeRawRow()]);
    const res = await listTryOnAdminRecords({ page: 2, pageSize: 10 });
    expect(res.totalPages).toBe(3);
    const rowsQuery = bizSelects()[1];
    expect(rowsQuery?.limit).toBe(10);
    expect(rowsQuery?.offset).toBe(10);
  });

  it("空結果：total=0 → items=[] totalPages=0（前端顯示空態）", async () => {
    queuePage(0, []);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.totalPages).toBe(0);
  });

  it("filter：status＋會員（名/電話 ilike）＋商品（snapshot 品名/貨號 ilike）落晒 where，%_\\ 有 escape", async () => {
    queuePage(1, [makeRawRow()]);
    await listTryOnAdminRecords({ page: 1, pageSize: 20, status: "completed", member: "陳", product: "TOP" });
    const rowsQuery = bizSelects()[1];
    const { sql, params } = whereSig(rowsQuery?.where);
    expect(sql).toContain("status");
    expect(sql.match(/ilike/gi)?.length).toBe(4); // 會員 2 欄＋商品 2 欄
    expect(params).toEqual(["completed", "%陳%", "%陳%", "%TOP%", "%TOP%"]);

    // escape：用戶輸入嘅 % 唔會變通配符
    reset();
    queuePage(0, []);
    await listTryOnAdminRecords({ page: 1, pageSize: 20, member: "100%_" });
    const escaped = whereSig(bizSelects()[1]?.where);
    expect(escaped.params).toContain("%100\\%\\_%");
  });

  it("response 絕無私人媒體／內部技術欄位（key 白名單＋敏感值掃描）", async () => {
    queuePage(1, [makeRawRow()]);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    const item = res.items[0]!;
    expect(Object.keys(item).sort()).toEqual(
      [
        "jobId",
        "publicId",
        "lookId",
        "stepNumber",
        "status",
        "failureCode",
        "member",
        "product",
        "mediaDeleted",
        "media",
        "createdAt",
        "startedAt",
        "completedAt",
      ].sort(),
    );
    expect(Object.keys(item.media).sort()).toEqual(["archiveAvailable", "productImageUrl"].sort());
    expect(Object.keys(item.product).sort()).toEqual(
      ["id", "name", "sku", "category", "tryOnKind", "exists", "changed", "currentName", "currentSku"].sort(),
    );
    expect(Object.keys(item.member!).sort()).toEqual(["id", "name", "phone"].sort());

    const json = JSON.stringify(res);
    for (const forbidden of [
      "inputImagePath",
      "outputImagePath",
      "productImagePath",
      "ImagePath",
      "provider",
      "generationMode",
      "resolution",
      "idempotencyKey",
      "requestHash",
      "failureMessage",
      "estimatedCost",
      "unitCreditCost",
      "credits",
      "prompt",
      "secret",
      "signed",
      "storage",
    ]) {
      expect(json).not.toContain(forbidden);
    }
    // 敏感值都唔准漏（路徑／供應商 job id）
    expect(json).not.toContain("secret-input-aaa");
    expect(json).not.toContain("secret-output-bbb");
    expect(json).not.toContain("fashn-job-999");
    expect(json).not.toContain("供應商內部錯誤原文");
  });
});

// ───────────────────────── 30 日後台副本 availability ─────────────────────────

describe("30 日後台副本 availability（只按 createdAt，唔掛客戶 expiresAt／mediaDeletedAt）", () => {
  it("30 日內仍然 archiveAvailable=true；過咗 30 日係 false（精準 boundary 由 tryonAdminArchive pure helper 測試鎖定）", async () => {
    const now = Date.now();
    // 呢度係 service 層整合測試（Date.now() 喺 test 同 service 之間會行）；
    // 用 1 秒緩衝驗兩邊，亞毫秒精準 boundary 由 tryonAdminArchiveAvailable／adminMedia handler 測試覆蓋。
    const justInside = makeRawRow({
      jobId: 31,
      createdAt: new Date(now - TRYON_ADMIN_ARCHIVE_RETENTION_MS + 1000),
      expiresAt: new Date(now + 60_000),
    });
    const exactBoundary = makeRawRow({
      jobId: 32,
      publicId: "423e4567-e89b-42d3-a456-426614174000",
      createdAt: new Date(now - TRYON_ADMIN_ARCHIVE_RETENTION_MS - 1000),
      expiresAt: new Date(now + 60_000),
    });
    queuePage(2, [justInside, exactBoundary]);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    expect(res.items.find((i) => i.jobId === 31)?.media.archiveAvailable).toBe(true);
    expect(res.items.find((i) => i.jobId === 32)?.media.archiveAvailable).toBe(false);
  });

  it("客戶私人媒體已刪／24 小時已過期：mediaDeleted=true 但後台副本仍 available", async () => {
    const now = Date.now();
    const row = makeRawRow({
      jobId: 33,
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000), // 10 日前建立（30 日內）
      mediaDeletedAt: new Date(now - 9 * 24 * 60 * 60 * 1000), // 客戶早已刪除
      expiresAt: new Date(now - 9 * 24 * 60 * 60 * 1000), // 24 小時保留早已過
    });
    queuePage(1, [row]);
    const res = await listTryOnAdminRecords({ page: 1, pageSize: 20 });
    expect(res.items[0]?.mediaDeleted).toBe(true);
    expect(res.items[0]?.media.archiveAvailable).toBe(true);
  });
});

// ───────────────────────── getTryOnAdminRecordMedia 即場簽發 ─────────────────────────

describe("getTryOnAdminRecordMedia 即場簽發後台圖片 URL", () => {
  const makeMediaJob = (overrides: Record<string, any> = {}) => ({
    status: "completed",
    inputImagePath: "x/input.jpg",
    outputImagePath: "x/output.png",
    createdAt: new Date(Date.now() - 60_000),
    ...overrides,
  });

  it("completed job：input＋output 都簽到 /api/admin/tryon-media/... URL（不含 userId）", async () => {
    h.state.queue.push([makeMediaJob()]);
    const res = await getTryOnAdminRecordMedia("123e4567-e89b-42d3-a456-426614174000");
    for (const url of [res.inputUrl, res.outputUrl]) {
      expect(url).toBeTruthy();
      const parsed = new URL(url!, "https://redcode.red");
      expect(parsed.pathname).toMatch(/^\/api\/admin\/tryon-media\/123e4567-e89b-42d3-a456-426614174000\/(input|output)$/);
      expect(parsed.searchParams.get("e")).toBeTruthy();
      expect(parsed.searchParams.get("s")).toBeTruthy();
      expect(parsed.searchParams.get("u")).toBeNull();
    }
  });

  it("未完成 job 唔簽 output；冇 input 紀錄唔簽 input", async () => {
    h.state.queue.push([makeMediaJob({ status: "processing", outputImagePath: null })]);
    const res = await getTryOnAdminRecordMedia("123e4567-e89b-42d3-a456-426614174000");
    expect(res.inputUrl).toBeTruthy();
    expect(res.outputUrl).toBeNull();
  });

  it("30 日已到（createdAt+30d ≤ now）→ NOT_FOUND，唔會簽任何 URL", async () => {
    h.state.queue.push([
      makeMediaJob({ createdAt: new Date(Date.now() - TRYON_ADMIN_ARCHIVE_RETENTION_MS - 1) }),
    ]);
    await expect(getTryOnAdminRecordMedia("123e4567-e89b-42d3-a456-426614174000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("job 唔存在 → NOT_FOUND", async () => {
    h.state.queue.push([]);
    await expect(getTryOnAdminRecordMedia("123e4567-e89b-42d3-a456-426614174000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("客戶已刪除私人媒體嘅 job 仍然簽到後台副本 URL", async () => {
    h.state.queue.push([makeMediaJob({ mediaDeletedAt: new Date() })]);
    const res = await getTryOnAdminRecordMedia("123e4567-e89b-42d3-a456-426614174000");
    expect(res.inputUrl).toBeTruthy();
    expect(res.outputUrl).toBeTruthy();
  });
});

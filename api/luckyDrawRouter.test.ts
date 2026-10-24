/**
 * v2.5.6 luckyDrawRouter 層 focused tests——mock DB（thenable chain）＋mock auth/audit/notify。
 * 覆蓋：supervisor 權限、名單每日全域限中 N（N=1 同舊 Set guard 相容）、event 全活動限中、
 * 加權中獎寫入 eventId/eventEntryId、prize 滿 CONFLICT、並發限中重檢 CONFLICT、歸檔擋抽、
 * event redraw（舊中獎人排除／成功重抽 redrawOfId）、Excel preview 零寫、commit 有錯全批唔寫、
 * ticket merge/skip commit、list commit 開新名單、template endpoint、history eventName 合約。
 *
 * hardening 補強覆蓋（驗證呼叫順序／鎖內查詢，唔只係結果）：
 * 會員池 adminDraw 一日一件鎖內重檢、adminDrawManual 鎖內重數當日限中（default N=1）、
 * event redraw 鎖後 delete affected=1（0 → CONFLICT 唔插新 winner）／刪舊後數件／鎖內限中重數、
 * 名單 redraw 同款鎖次序、Excel list 空名單拒絕、ticket 鎖內重讀 entries 驗每人/總劵上限
 * （並發 merge＋跨批累加）、unique 23505 → CONFLICT。
 *
 * ⚠️ 界限：呢度 mock 咗 DB，真 PostgreSQL advisory lock／transaction 並發語義冇驗到（要 integration）；
 * DDL（boot-migrate）都冇喺真 DB 跑過。鎖次序／鎖內查詢只能靠 ops 順序斷言間接驗證。
 *
 * v2.5.7 覆核補強（M1–M4）：
 * - mock chain 記低 .where()/.from()/.returning()，經 PgDialect 轉真 SQL＋params 斷言守衛條件
 *   （CAS id+status+orderId null-safe／訂單可取消狀態／claim pending／bind confirmed+orderId-null／
 *    notifyWin notifiedAt-null／會員 redraw pending claim／deleteDraw DELETE RETURNING orderId），
 *   邊個守衛俾人刪走都會有對應測試紅。
 * - M1：訂單取消係原子條件 update（id＋可取消狀態）；並發已批 affected=0／張單被 hard-delete
 *   都走 orderUntouchedWarn 分支，唔報 orderCancelled=true。
 * - M2：adminDrawEvent 鎖內重讀 event archivedAt（歸檔 CONFLICT／唔存在 NOT_FOUND）。
 * - M3：adminDeleteDraw/byDate 用 tx 內 DELETE luckyDraws RETURNING orderId 攞真實綁單
 *   （唔靠 transaction 外快照；regression：快照 orderId=null 但 RETURNING 有單 → 照刪真實關聯單）；
 *   仔行清單包 orderShipments（FK 指 orders，漏刪 23503），斷言佢喺 orders 之前刪＋orderId 精準。
 * - M5：adminSetEventArchived 行 DB transaction＋EVENT_LOCK_NS(845120) event 雙 key 鎖
 *   （execute SQL params 精確斷言）→ 鎖內重讀 → 先 update；歸檔/取消歸檔同一把鎖，同抽獎互斥。
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

// ───────────────────────── mock 基礎設施（hoisted）─────────────────────────
const h = vi.hoisted(() => {
  const state = {
    user: null as null | { userId: number; role: string },
    // JWT 身份同 DB 覆核角色分開模擬；undefined 喺 reset 時預設跟 JWT role。
    dbRole: null as string | null,
    userTable: null as any,
    userRoleColumn: null as any,
    queue: [] as any[],
    // 呼叫順序 log（鎖次序／鎖內查詢斷言用）：op＝select/insert/update/delete/execute
    ops: [] as { op: string; table?: any }[],
    // v2.5.7 覆核補強：select 都記低 from/where（守衛 SQL 斷言用——where 條件唔再被 mock 吞咗）
    selects: [] as { from?: any; where?: any }[],
    inserts: [] as { table: any; values: any }[],
    updates: [] as { table: any; set: any; where?: any; returning?: any }[],
    deletes: [] as { table: any; where?: any; returning?: any }[],
    // execute 嘅 SQL template 都記低（advisory lock key/namespace 斷言用）
    executes: [] as any[],
    executeCount: 0,
    // db.transaction 呼叫次數（「一定要行 transaction」斷言用）
    txCount: 0,
  };
  const pop = () => (state.queue.length > 0 ? state.queue.shift() : []);
  // Error 實例 → reject（模擬 DB 層錯誤，例如 unique 23505）
  const settle = (rec?: { from?: any; authRoleQuery?: boolean }) => {
    // middleware 每 request 都會以 users PK 覆核角色；只攔截佢嘅 { role } 查詢，
    // 唔可以吃掉下方業務程序預設嘅 queue，更唔可以攔截 router 自己嘅 users 查詢。
    if (state.userTable && rec?.from === state.userTable && rec?.authRoleQuery) {
      return Promise.resolve(state.dbRole ? [{ role: state.dbRole }] : []);
    }
    const v = pop();
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  function makeChain(rec?: { values?: any; set?: any; table?: any; where?: any; from?: any; returning?: any }) {
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
            if (rec && prop === "values") rec.values = args[0];
            if (rec && prop === "set") rec.set = args[0];
            if (rec && prop === "where") rec.where = args[0];
            if (rec && prop === "from") rec.from = args[0];
            if (rec && prop === "returning") rec.returning = args[0];
            return chain;
          };
        },
      },
    );
    return chain;
  }
  const db: any = {
    select: (selection?: any) => {
      state.ops.push({ op: "select" });
      const rec = {
        from: undefined as any,
        where: undefined as any,
        authRoleQuery:
          selection &&
          Object.keys(selection).length === 1 &&
          state.userRoleColumn &&
          selection.role === state.userRoleColumn,
      };
      state.selects.push(rec);
      return makeChain(rec);
    },
    insert: (table: any) => {
      state.ops.push({ op: "insert", table });
      const rec = { table, values: undefined as any, returning: undefined as any };
      state.inserts.push(rec);
      return makeChain(rec);
    },
    update: (table: any) => {
      state.ops.push({ op: "update", table });
      const rec = { table, set: undefined as any, where: undefined as any, returning: undefined as any };
      state.updates.push(rec);
      return makeChain(rec);
    },
    delete: (table: any) => {
      state.ops.push({ op: "delete", table });
      const rec = { table, where: undefined as any, returning: undefined as any };
      state.deletes.push(rec);
      return makeChain(rec);
    },
    transaction: (cb: any) => {
      state.txCount += 1;
      return cb(db);
    },
    execute: (q?: any) => {
      state.executeCount += 1;
      state.ops.push({ op: "execute" });
      state.executes.push(q);
      return makeChain();
    },
  };
  return { state, db };
});

vi.mock("./queries/connection", () => ({ getDb: () => h.db }));
vi.mock("./auth", () => ({
  userFromAuthHeader: vi.fn(async () => h.state.user),
  verifyToken: vi.fn(async () => h.state.user),
}));
vi.mock("./audit", () => ({ logAudit: vi.fn() }));
vi.mock("./email", () => ({ sendPrizeWinEmail: vi.fn(async () => undefined) }));
vi.mock("./livePush", () => ({ sendPrizeWinPush: vi.fn(async () => undefined) }));
vi.mock("./wmsSync", () => ({ forwardOrderToWms: vi.fn(async () => undefined) }));

import { luckyDrawRouter } from "./luckyDrawRouter";
import { luckyDraws, luckyDrawEventEntries, luckyDrawEvents, luckyDrawLists, orderItems, orderShipments, orders, paymentProofs, users, wmsSyncLog } from "@db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import { writeZipDeflate } from "./xlsxZip";
import { expectedHeaders, hasPkMagic, parseXlsxRows } from "./luckyDrawXlsx";
import { sendPrizeWinEmail } from "./email";
import { sendPrizeWinPush } from "./livePush";
import { forwardOrderToWms } from "./wmsSync";

// hoisted mock 唔直接捕捉 import 綁定；模組載入後先登記 users table identity。
h.state.userTable = users;
h.state.userRoleColumn = users.role;

// ───────────────────────── helpers ─────────────────────────

function caller() {
  return luckyDrawRouter.createCaller({
    req: new Request("http://test.local/api/trpc", { headers: { authorization: "Bearer x" } }),
    resHeaders: new Headers(),
  });
}

function reset(
  user: { userId: number; role: string } | null = { userId: 1, role: "supervisor" },
  dbRole?: string | null,
) {
  h.state.user = user;
  h.state.dbRole = dbRole === undefined ? (user?.role ?? null) : dbRole;
  h.state.queue = [];
  h.state.ops = [];
  h.state.selects = [];
  h.state.inserts = [];
  h.state.updates = [];
  h.state.deletes = [];
  h.state.executes = [];
  h.state.executeCount = 0;
  h.state.txCount = 0;
}

// ─── 守衛 SQL 斷言（v2.5.7 覆核補強）───
// mock chain 而家記低 .where(...) 嘅 drizzle 條件；用呢個 helper 經 PgDialect 轉做
// 真 SQL＋params 先斷言——刪走某個守衛條件（例如 status='pending'）會即時有測試失敗，
// 唔會再出現「queue 照樣回 affected rows → 錯誤謂詞都綠」嘅假陽性。
const pgDialect = new PgDialect();

/** drizzle where 條件 → { sql, params }（PgDialect 正規化，唔靠 object inspect 撞字串） */
function whereSig(where: any): { sql: string; params: any[] } {
  expect(where, "呢個 statement 冇 where 條件可斷言").toBeTruthy();
  const q = pgDialect.sqlToQuery(where);
  return { sql: q.sql, params: q.params };
}

/** 斷言 where 包含指定 SQL 片段（string＝toContain；RegExp＝toMatch）＋ params 完全一致 */
function expectWhere(where: any, sqlChecks: (string | RegExp)[], params: any[]) {
  const { sql, params: actual } = whereSig(where);
  for (const c of sqlChecks) {
    if (typeof c === "string") expect(sql).toContain(c);
    else expect(sql).toMatch(c);
  }
  expect(actual).toEqual(params);
}

/** 鎖次序斷言：target op（預設 insert:luckyDraws）之前要有齊 wantLocks 道 execute，
 *  而且最後一道鎖之後、target 之前要有 minSelects 個 select（鎖內重數查詢） */
function expectLockedWrites(wantLocks: number, minSelects: number, target?: { op: string; table?: any }) {
  const ops = h.state.ops;
  const tgt = target ?? { op: "insert", table: luckyDraws };
  const tgtIdx = ops.findIndex((o) => o.op === tgt.op && (tgt.table === undefined || o.table === tgt.table));
  expect(tgtIdx, "搵唔到目標寫入 op").toBeGreaterThanOrEqual(0);
  const lockIdxs = ops.map((o, i) => (o.op === "execute" ? i : -1)).filter((i) => i >= 0);
  expect(lockIdxs.length, "advisory lock 次數").toBe(wantLocks);
  expect(lockIdxs[lockIdxs.length - 1], "所有鎖都要喺寫入之前").toBeLessThan(tgtIdx);
  const selectsInside = ops.slice(lockIdxs[lockIdxs.length - 1] + 1, tgtIdx).filter((o) => o.op === "select").length;
  expect(selectsInside, "鎖內重數查詢次數").toBeGreaterThanOrEqual(minSelects);
}

const PRIZE = { id: 9, name: "禮物A", sku: "SKU-A", price: 100, imagePath: null, session: "", quantity: 1, active: true, createdAt: new Date() };
const DRAW_ROW = { id: 321 };

function makeXlsxBase64(kind: "list" | "ticket", dataRows: string[][]): string {
  const all = [expectedHeaders(kind), ...dataRows];
  const sheetData = all
    .map(
      (r, i) =>
        `<row r="${i + 1}">${r
          .map((c, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t>${c}</t></is></c>`)
          .join("")}</row>`,
    )
    .join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`;
  const buf = writeZipDeflate(new Map([["xl/worksheets/sheet1.xml", Buffer.from(sheet, "utf8")]]));
  return buf.toString("base64");
}

const insertsOf = (table: any) => h.state.inserts.filter((r) => r.table === table);

beforeEach(() => {
  reset();
  // 清晒 module mock 呼叫紀錄（email/push/WMS 斷言用；implementations 喺 vi.mock factory 度，唔會被清走）
  vi.clearAllMocks();
});

// ───────────────────────── 權限 ─────────────────────────

describe("supervisor 權限", () => {
  it("未登入 → UNAUTHORIZED；member/staff → FORBIDDEN；supervisor 過到權限關", async () => {
    reset(null);
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().adminImportExcel({ kind: "list", fileBase64: "eA==" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().adminCreateEvent({ name: "X", maxWinsPerPerson: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller().adminDraw({ prizeId: 9, filter: { allMembers: true } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    reset({ userId: 2, role: "member" });
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // staff 可以入後台其他嘢，但抽獎新 endpoint 係 supervisor 級——staff 要俾佢擋
    reset({ userId: 3, role: "staff" });
    await expect(caller().adminImportExcel({ kind: "list", fileBase64: "eA==" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // supervisor：過權限關，落去業務檢查（冇獎品 → NOT_FOUND 而唔係權限錯）
    reset({ userId: 1, role: "supervisor" });
    h.state.queue.push([]); // prize select → 空
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("DB 帳號已刪 → UNAUTHORIZED；DB 角色同 JWT 唔符 → FORBIDDEN", async () => {
    reset({ userId: 1, role: "supervisor" }, null);
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    reset({ userId: 1, role: "supervisor" }, "member");
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ───────────────────────── 名單模式每日限中 N ─────────────────────────

describe("adminDrawManual 名單每日全域限中 N", () => {
  const LIST_BASE = { id: 5, name: "VIP場", names: ["陳小明", "陳大文"], memberIds: [], createdBy: null, createdByName: null, createdAt: new Date() };

  it("N=1（舊名單冇 maxWinsPerPerson 欄）≡ 舊 Set guard：今日中過嘅名被踢，淨返另一個", async () => {
    h.state.queue = [
      [PRIZE],
      [{ ...LIST_BASE }],
      [{ winnerName: "陳小明" }],
      [],
      [], // shadow select miss
      [{ id: 900, name: "陳大文" }], // shadow insert returning
      [{ name: "Boss" }], // actorName
      {}, // tx execute：prize advisory lock
      {}, // tx execute：香港抽獎日全域 advisory lock（prize → date 次序）
      [{ n: 0 }], // tx 數件
      [{ c: 0 }], // tx 鎖內重數中獎人當日已中次數
      [DRAW_ROW], // tx insert luckyDraws returning
    ];
    const r = await caller().adminDrawManual({ prizeId: 9, listId: 5 });
    expect(r.winner.name).toBe("陳大文"); // 陳小明被全日全域 guard 踢走
    const userIns = insertsOf(users);
    expect(userIns[0].values.phone).toBe("DRAW#陳大文");
    const drawIns = insertsOf(luckyDraws);
    expect(drawIns).toHaveLength(1);
    expect(drawIns[0].values).toMatchObject({ winnerName: "陳大文", listId: 5, status: "pending" });
    // 鎖次序：prize＋日期兩道鎖 → 鎖內兩個重數查詢 → 先至 insert
    expectLockedWrites(2, 2);
  });

  it("N=1：名單所有人今日都中過 → BAD_REQUEST，唔准靜默放寬", async () => {
    h.state.queue = [
      [PRIZE],
      [{ ...LIST_BASE }],
      [{ winnerName: "陳小明" }, { winnerName: "陳大文" }],
      [],
    ];
    await expect(caller().adminDrawManual({ prizeId: 9, listId: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("N=2：中過 1 次（< 2）仲抽得；winnerName count 口径（cancelled/declined 唔入 mock rows）", async () => {
    h.state.queue = [
      [PRIZE],
      [{ ...LIST_BASE, maxWinsPerPerson: 2 }],
      [{ winnerName: "陳小明" }, { winnerName: "陳大文" }], // 各中 1 次 < 2
      [],
      [],
      [{ id: 901, name: "陳小明" }],
      [{ name: "Boss" }],
      {}, {}, // prize lock → 日期全域 lock
      [{ n: 0 }],
      [{ c: 0 }], // 鎖內重數：中獎人當日 1 次 < 2（並發後都仲係咁先抽得）
      [DRAW_ROW],
    ];
    const r = await caller().adminDrawManual({ prizeId: 9, listId: 5 });
    expect(["陳小明", "陳大文"]).toContain(r.winner.name); // 兩個都仲喺池
    expect(insertsOf(luckyDraws)).toHaveLength(1);
  });

  it("hardening：鎖內重數發現中獎人當日已達上限（並發改變）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [PRIZE],
      [{ ...LIST_BASE, maxWinsPerPerson: 1 }], // default N=1 同舊一日一次相容
      [], // pre-check：池快照兩個都未中過
      [],
      [],
      [{ id: 901, name: "陳小明" }], // shadow insert
      [{ name: "Boss" }],
      {}, {}, // prize lock → 日期全域 lock
      [{ n: 0 }], // 獎品仲有
      [{ c: 1 }], // 鎖內重數：同一個人啱啱俾另一 transaction 抽中咗
    ];
    await expect(caller().adminDrawManual({ prizeId: 9, listId: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0); // 唔准靜默成功
    expect(h.state.executeCount).toBe(2); // 確實入咗鎖先重數
  });

  it("N=2：中夠 2 次嘅人先踢", async () => {
    h.state.queue = [
      [PRIZE],
      [{ ...LIST_BASE, maxWinsPerPerson: 2, names: ["陳小明"] }],
      [{ winnerName: "陳小明" }, { winnerName: "陳小明" }], // 中咗 2 次 = 上限
      [],
    ];
    await expect(caller().adminDrawManual({ prizeId: 9, listId: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ───────────────────────── 會員池抽獎（一日一件鎖內重檢）─────────────────────────

describe("adminDraw 會員池一日一件（prize → 香港日期全域鎖內重檢）", () => {
  it("成功：兩道鎖後重數件數＋中獎人當日次數先 insert（鎖次序斷言）", async () => {
    h.state.queue = [
      [PRIZE], // prize
      [{ id: 42 }], // collectParticipantIds allMembers
      [], // 影子帳號排除 select
      [], // exclusions
      [], // winnersOfDate（今日未中過）
      [{ id: 42, name: "王小虎", phone: "91234567", email: null }], // pickWinner
      [{ name: "Boss" }], // actorName
      {}, // tx execute：prize lock
      {}, // tx execute：香港抽獎日全域 lock
      [{ n: 0 }], // tx 數件
      [{ c: 0 }], // tx 鎖內重檢一日一件
      [DRAW_ROW],
    ];
    const r = await caller().adminDraw({ prizeId: 9, filter: { allMembers: true } });
    expect(r.winner.name).toBe("王小虎");
    expect(insertsOf(luckyDraws)).toHaveLength(1);
    expectLockedWrites(2, 2);
  });

  it("鎖內重檢：中獎人今日啱啱中過（並發改變）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [PRIZE],
      [{ id: 42 }],
      [],
      [],
      [], // pre-check 快照：未中過
      [{ id: 42, name: "王小虎", phone: "91234567", email: null }],
      [{ name: "Boss" }],
      {}, {},
      [{ n: 0 }],
      [{ c: 1 }], // 鎖內重檢：今日已中（另一 transaction 啱啱插咗）
    ];
    await expect(caller().adminDraw({ prizeId: 9, filter: { allMembers: true } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
    expect(h.state.executeCount).toBe(2);
  });
});

// ───────────────────────── 劵活動抽獎 ─────────────────────────

describe("adminDrawEvent 劵活動全活動限中＋加權", () => {
  const EVENT = { id: 7, name: "週年慶", maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date(), archivedAt: null, archivedByName: null };
  const A = { id: 11, eventId: 7, holderName: "甲", normalizedName: "甲", ticketCount: 2, createdBy: null, createdByName: null, createdAt: new Date() };
  const B = { id: 12, eventId: 7, holderName: "乙", normalizedName: "乙", ticketCount: 1, createdBy: null, createdByName: null, createdAt: new Date() };

  it("中夠全活動上限嘅人踢出池；中獎寫入 eventId/eventEntryId（影子帳號可追溯）", async () => {
    h.state.queue = [
      [PRIZE], // prize
      [EVENT], // event
      [A, B], // entries
      [{ eventEntryId: 11, n: 1 }], // 甲已中 1 次＝上限 → 踢
      [], // shadow select miss
      [{ id: 902, name: "乙" }], // shadow insert
      [{ name: "Boss" }], // actorName
      {}, // tx execute：prize lock
      {}, // tx execute：event lock
      [{ archivedAt: null }], // tx 鎖內重讀活動歸檔狀態（防舊快照補抽）
      [{ n: 0 }], // tx 數獎品件數
      [{ c: 0 }], // tx 重檢中獎人限中
      [DRAW_ROW], // tx insert draw
    ];
    const r = await caller().adminDrawEvent({ prizeId: 9, eventId: 7 });
    expect(r.winner).toMatchObject({ name: "乙", kind: "manual" });
    const drawIns = insertsOf(luckyDraws);
    expect(drawIns).toHaveLength(1);
    expect(drawIns[0].values).toMatchObject({ eventId: 7, eventEntryId: 12, winnerName: "乙", status: "pending" });
    expect(h.state.executeCount).toBe(2); // prize lock → event lock 兩道鎖
    expectLockedWrites(2, 2); // 兩道鎖後先重數（件數＋限中）再 insert
  });

  it("全部人中夠上限 → BAD_REQUEST，零寫入", async () => {
    h.state.queue = [[PRIZE], [EVENT], [A, B], [{ eventEntryId: 11, n: 1 }, { eventEntryId: 12, n: 1 }]];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("獎品件數喺鎖內重數：已滿 → CONFLICT，唔會靜默超抽", async () => {
    h.state.queue = [
      [{ ...PRIZE, quantity: 1 }], [EVENT], [B], [],
      [],
      [{ id: 902, name: "乙" }],
      [{ name: "Boss" }],
      {}, {},
      [{ archivedAt: null }], // tx 鎖內重讀活動歸檔狀態
      [{ n: 1 }], // 鎖內重數：1 件已抽出
    ];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("並發狀態改變：鎖內重檢中獎人已達上限 → 可見 CONFLICT", async () => {
    h.state.queue = [
      [PRIZE], [EVENT], [B], [],
      [],
      [{ id: 902, name: "乙" }],
      [{ name: "Boss" }],
      {}, {},
      [{ archivedAt: null }], // tx 鎖內重讀活動歸檔狀態
      [{ n: 0 }],
      [{ c: 1 }], // 重檢：乙啱啱中咗（並發）
    ];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("已歸檔活動 → CONFLICT，唔入 transaction", async () => {
    h.state.queue = [[PRIZE], [{ ...EVENT, archivedAt: new Date() }]];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.executeCount).toBe(0);
  });

  it("hardening：鎖內重讀發現活動啱啱歸檔咗（archived after lock）→ CONFLICT，唔插中獎", async () => {
    h.state.queue = [
      [PRIZE], [EVENT], [B], [], // transaction 外快照：活動未歸檔
      [],
      [{ id: 902, name: "乙" }],
      [{ name: "Boss" }],
      {}, {}, // tx：prize lock → event lock
      [{ archivedAt: new Date() }], // 鎖內重讀：抽獎途中俾人歸檔咗
    ];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
    expect(h.state.executeCount).toBe(2); // 確實入咗兩道鎖先重讀
  });

  it("hardening：鎖內重讀發現活動已唔存在 → NOT_FOUND，唔插中獎", async () => {
    h.state.queue = [
      [PRIZE], [EVENT], [B], [],
      [],
      [{ id: 902, name: "乙" }],
      [{ name: "Boss" }],
      {}, {},
      [], // 鎖內重讀：活動 row 冇咗
    ];
    await expect(caller().adminDrawEvent({ prizeId: 9, eventId: 7 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
    expect(h.state.executeCount).toBe(2);
  });
});

// ───────────────────────── event redraw ─────────────────────────

describe("adminRedraw event 分支", () => {
  const EVENT = { id: 7, name: "週年慶", maxWinsPerPerson: 1, archivedAt: null };
  const OLD = { id: 50, prizeId: 9, winnerUserId: 800, winnerName: "甲", status: "pending", drawDate: "20261024", eventId: 7, eventEntryId: 11 };
  const A = { id: 11, eventId: 7, holderName: "甲", normalizedName: "甲", ticketCount: 2 };
  const B = { id: 12, eventId: 7, holderName: "乙", normalizedName: "乙", ticketCount: 1 };

  it("舊中獎人永遠踢出重抽池：得返佢一個 → BAD_REQUEST 兼保留舊中獎（零刪零插）", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A], // 活動得甲一個人
      [{ eventEntryId: 11, n: 1 }],
    ];
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.state.deletes).toHaveLength(0);
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("成功重抽：鎖後 delete affected=1 → 刪舊後數件 → 鎖內限中重數 → 插新（redrawOfId 鏈、eventEntryId 追溯）", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A, B],
      [{ eventEntryId: 11, n: 1 }],
      [{ id: 800, name: "乙" }],
      [{ name: "Boss" }],
      {}, {}, // tx：prize lock → event lock
      [{ archivedAt: null }], // tx 鎖內重讀活動歸檔狀態（防舊快照補抽）
      [{ id: 50 }], // tx delete luckyDraws returning（affected 啱啱 1）
      [{ n: 0 }], // tx 刪舊後數獎品件數（舊 pending 已讓返一件，唔會假爆滿）
      [{ c: 0 }], // tx 鎖內重數新中獎劵全活動限中
      [{ id: 51 }], // tx insert returning
    ];
    const r = await caller().adminRedraw({ drawId: 50 });
    expect(r.cancelledDrawId).toBe(50);
    expect(r.winner.name).toBe("乙");
    expect(h.state.deletes).toHaveLength(1);
    // 刪舊守衛 SQL：id＋status='pending'（affected 必須啱啱 1；刪走 status 條件會令測試紅）
    expectWhere(h.state.deletes[0].where, ['"id" = $1', '"status" = $2'], [50, "pending"]);
    const drawIns = insertsOf(luckyDraws);
    expect(drawIns).toHaveLength(1);
    expect(drawIns[0].values).toMatchObject({ redrawOfId: 50, eventId: 7, eventEntryId: 12, drawDate: "20261024" });
    // 鎖次序：兩道鎖 → 鎖內 delete（狀態重檢）→ 重數 → insert
    expectLockedWrites(2, 2);
    const delIdx = h.state.ops.findIndex((o) => o.op === "delete" && o.table === luckyDraws);
    const insIdx = h.state.ops.findIndex((o) => o.op === "insert" && o.table === luckyDraws);
    const lastLock = h.state.ops.map((o, i) => (o.op === "execute" ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(delIdx).toBeGreaterThan(lastLock); // 刪舊一定要喺鎖後
    expect(insIdx).toBeGreaterThan(delIdx);
  });

  it("hardening：鎖後 delete affected=0（狀態已俾人改）→ CONFLICT，唔准插入新 winner", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A, B],
      [{ eventEntryId: 11, n: 1 }],
      [{ id: 800, name: "乙" }],
      [{ name: "Boss" }],
      {}, {}, // locks
      [{ archivedAt: null }], // 鎖內重讀活動歸檔狀態
      [], // tx delete returning：0 rows——另一 transaction 已確認/取消/重抽咗
    ];
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0); // 唔准插新 winner
    expect(h.state.executeCount).toBe(2);
  });

  it("hardening：刪舊後數件——另一 transaction 已用晒件數 → CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A, B],
      [{ eventEntryId: 11, n: 1 }],
      [{ id: 800, name: "乙" }],
      [{ name: "Boss" }],
      {}, {},
      [{ archivedAt: null }], // 鎖內重讀活動歸檔狀態
      [{ id: 50 }], // delete affected=1
      [{ n: 1 }], // 刪舊後重數：另一抽已佔咗嗰件（quantity=1）
    ];
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("hardening：鎖內重讀發現活動已歸檔（transaction 外舊快照補抽）→ CONFLICT，唔刪舊唔插新", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A, B],
      [{ eventEntryId: 11, n: 1 }],
      [{ id: 800, name: "乙" }],
      [{ name: "Boss" }],
      {}, {}, // locks
      [{ archivedAt: new Date() }], // 鎖內重讀：抽獎途中啱啱俾人歸檔咗
    ];
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.deletes).toHaveLength(0); // 唔准郁舊紀錄
    expect(insertsOf(luckyDraws)).toHaveLength(0);
    expect(h.state.executeCount).toBe(2); // 確實入咗鎖先重讀
  });

  it("hardening：鎖內重數新中獎劵已達全活動上限（並發改變）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [OLD], [PRIZE], [EVENT],
      [A, B],
      [{ eventEntryId: 11, n: 1 }],
      [{ id: 800, name: "乙" }],
      [{ name: "Boss" }],
      {}, {},
      [{ archivedAt: null }], // 鎖內重讀活動歸檔狀態
      [{ id: 50 }],
      [{ n: 0 }],
      [{ c: 1 }], // 乙啱啱中夠 1 次（event.maxWinsPerPerson=1）
    ];
    await expect(caller().adminRedraw({ drawId: 50 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });
});

// ───────────────────────── list redraw（名單重抽鎖內重檢）─────────────────────────

describe("adminRedraw 名單分支（prize → 香港日期全域鎖內重檢）", () => {
  const OLD_LIST_DRAW = { id: 60, prizeId: 9, winnerUserId: 800, winnerName: "陳小明", status: "pending", drawDate: "20261024", listId: 5, eventId: null, eventEntryId: null };
  const LIST = { id: 5, name: "VIP場", names: ["陳小明", "陳大文"], memberIds: [], maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date() };

  it("成功重抽：鎖後 delete affected=1 → 刪舊後數件 → 鎖內重數當日限中（N=1）→ 插新（redrawOfId 鏈）", async () => {
    h.state.queue = [
      [OLD_LIST_DRAW], [PRIZE], [LIST],
      [{ winnerName: "陳小明" }], // winnerNameCountsOfDate：舊 pending 計緊舊中獎人一次
      [], // winnerIdCountsOfDate
      [], // shadow select miss（陳大文）
      [{ id: 900, name: "陳大文" }], // shadow insert
      [{ name: "Boss" }], // actorName
      {}, {}, // tx：prize lock → 香港抽獎日全域 lock（舊紀錄抽獎日）
      [{ id: 60 }], // tx delete returning（affected 啱啱 1）
      [{ n: 0 }], // tx 刪舊後數件（舊 pending 已讓返一件）
      [{ c: 0 }], // tx 鎖內重數新中獎名當日限中
      [{ id: 61 }], // tx insert returning
    ];
    const r = await caller().adminRedraw({ drawId: 60 });
    expect(r.cancelledDrawId).toBe(60);
    expect(r.winner).toMatchObject({ name: "陳大文", kind: "manual" }); // 舊中獎人陳小明被 forceExclude
    // 刪舊守衛 SQL：id＋status='pending'
    expectWhere(h.state.deletes[0].where, ['"id" = $1', '"status" = $2'], [60, "pending"]);
    const drawIns = insertsOf(luckyDraws);
    expect(drawIns).toHaveLength(1);
    expect(drawIns[0].values).toMatchObject({ redrawOfId: 60, listId: 5, winnerName: "陳大文", drawDate: "20261024" });
    expectLockedWrites(2, 2);
    const delIdx = h.state.ops.findIndex((o) => o.op === "delete" && o.table === luckyDraws);
    const lastLock = h.state.ops.map((o, i) => (o.op === "execute" ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(delIdx).toBeGreaterThan(lastLock); // 刪舊一定要喺鎖後
  });

  it("hardening：鎖內重數新中獎名當日已達上限（並發改變）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [OLD_LIST_DRAW], [PRIZE], [LIST],
      [{ winnerName: "陳小明" }],
      [],
      [],
      [{ id: 900, name: "陳大文" }],
      [{ name: "Boss" }],
      {}, {},
      [{ id: 60 }],
      [{ n: 0 }],
      [{ c: 1 }], // 陳大文啱啱喺另一 transaction 中咗（N=1）
    ];
    await expect(caller().adminRedraw({ drawId: 60 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("hardening：鎖後 delete affected=0（狀態已俾人改）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      [OLD_LIST_DRAW], [PRIZE], [LIST],
      [{ winnerName: "陳小明" }],
      [],
      [],
      [{ id: 900, name: "陳大文" }],
      [{ name: "Boss" }],
      {}, {},
      [], // delete returning 0 rows
    ];
    await expect(caller().adminRedraw({ drawId: 60 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });
});

// ───────────────────────── Excel 匯入 preview/commit ─────────────────────────

describe("adminImportExcel preview/commit", () => {
  const EVENT = { id: 7, name: "週年慶", maxWinsPerPerson: 1, archivedAt: null };
  const EXISTING_A = { id: 11, eventId: 7, holderName: "甲", normalizedName: "甲", ticketCount: 3, createdBy: null, createdByName: null, createdAt: new Date() };

  it("preview（預設 commit=false）完全唔寫 DB，但回齊 rows/duplicates/summary", async () => {
    const b64 = makeXlsxBase64("ticket", [["甲", "2"], ["乙", "1"]]);
    h.state.queue = [[EVENT], [EXISTING_A]]; // event select + entries select（重複檢查要讀，但唔寫）
    const r = await caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, duplicatePolicy: "merge" });
    expect(r.committed).toBe(false);
    expect(r.summary.validRows).toBe(2);
    expect(r.duplicates).toHaveLength(1); // 甲撞現有
    expect(r.duplicates[0].action).toBe("merge");
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("commit=true 但有逐行錯誤 → 全部唔寫", async () => {
    const b64 = makeXlsxBase64("ticket", [["甲", "abc"], ["乙", "1"]]);
    h.state.queue = [[EVENT], [EXISTING_A]];
    const r = await caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true });
    expect(r.committed).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("ticket commit merge：現有人加劵（update）、新人 insert，同一 transaction（event 鎖內重讀 entries）", async () => {
    const b64 = makeXlsxBase64("ticket", [["甲", "2"], ["乙", "1"]]);
    h.state.queue = [
      [EVENT], [EXISTING_A],
      [{ name: "Boss" }], // actorName
      {}, // tx execute：event lock
      [{ archivedAt: null }], // tx 鎖內重讀活動（未歸檔）
      [EXISTING_A], // tx 鎖內重讀現有 entries（唔信 preview 快照）
      [{ id: 11 }], // tx merge update returning（affected=1）
      [], // tx insert pop
    ];
    const r = await caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true, duplicatePolicy: "merge" });
    expect(r.committed).toBe(true);
    expect(r.summary).toMatchObject({ inserts: 1, merges: 1, duplicates: 1, errors: 0, totalTickets: 3 });
    expect(h.state.updates).toHaveLength(1);
    expect(h.state.updates[0].table).toBe(luckyDrawEventEntries);
    const entryIns = insertsOf(luckyDrawEventEntries);
    expect(entryIns).toHaveLength(1);
    expect(entryIns[0].values).toEqual([
      expect.objectContaining({ eventId: 7, holderName: "乙", normalizedName: "乙", ticketCount: 1 }),
    ]);
    // 鎖次序：event lock → 鎖內重讀 → 先至 update/insert
    const lockIdx = h.state.ops.findIndex((o) => o.op === "execute");
    const updIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDrawEventEntries);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updIdx).toBeGreaterThan(lockIdx);
    const rereads = h.state.ops.slice(lockIdx + 1, updIdx).filter((o) => o.op === "select").length;
    expect(rereads).toBeGreaterThanOrEqual(2); // 活動歸檔重檢＋entries 重讀
  });

  it("ticket commit skip（預設）：撞現有略過唔加劵", async () => {
    const b64 = makeXlsxBase64("ticket", [["甲", "2"], ["乙", "1"]]);
    h.state.queue = [
      [EVENT], [EXISTING_A], [{ name: "Boss" }],
      {}, // tx event lock
      [{ archivedAt: null }], // 鎖內重讀活動
      [EXISTING_A], // 鎖內重讀 entries
      [], // tx insert pop
    ];
    const r = await caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true });
    expect(r.committed).toBe(true);
    expect(r.duplicates[0].action).toBe("skip");
    expect(h.state.updates).toHaveLength(0); // skip 唔郁現有 entry
    expect(insertsOf(luckyDrawEventEntries)[0].values[0]).toMatchObject({ holderName: "乙" });
  });

  it("hardening：並發 merge——鎖內重讀 ticketCount 後超每人上限 → CONFLICT，全批 rollback", async () => {
    const b64 = makeXlsxBase64("ticket", [["甲", "1000"]]);
    h.state.queue = [
      [EVENT],
      [{ ...EXISTING_A, ticketCount: 9000 }], // preview 快照：9000＋1000＝10000 啱啱過
      [{ name: "Boss" }],
      {}, // tx event lock
      [{ archivedAt: null }],
      [{ ...EXISTING_A, ticketCount: 9500 }], // 鎖內重讀：另一批已並發加咗 500 → 10500 超上限
    ];
    await expect(
      caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true, duplicatePolicy: "merge" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.updates).toHaveLength(0); // 全批唔寫
    expect(insertsOf(luckyDrawEventEntries)).toHaveLength(0);
  });

  it("hardening：跨批累加——鎖內重讀後全活動總劵超上限 → CONFLICT，全批 rollback", async () => {
    const b64 = makeXlsxBase64("ticket", [["乙", "2000"]]);
    h.state.queue = [
      [EVENT],
      [{ ...EXISTING_A, ticketCount: 100 }], // preview 快照
      [{ name: "Boss" }],
      {},
      [{ archivedAt: null }],
      [{ id: 11, eventId: 7, holderName: "甲", normalizedName: "甲", ticketCount: 9_999_900 }], // 鎖內最新（並發跨批累加）
    ];
    await expect(
      caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDrawEventEntries)).toHaveLength(0);
  });

  it("hardening：並發插入同名——鎖內重讀見到「乙」已存在 → CONFLICT，唔准重複插", async () => {
    const b64 = makeXlsxBase64("ticket", [["乙", "1"]]);
    h.state.queue = [
      [EVENT], [EXISTING_A],
      [{ name: "Boss" }],
      {},
      [{ archivedAt: null }],
      [EXISTING_A, { id: 12, eventId: 7, holderName: "乙", normalizedName: "乙", ticketCount: 1 }], // 並發另一批插咗
    ];
    await expect(
      caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDrawEventEntries)).toHaveLength(0);
  });

  it("hardening：DB unique index 撞（23505，最後防線）→ CONFLICT", async () => {
    const b64 = makeXlsxBase64("ticket", [["乙", "1"]]);
    const dup = Object.assign(new Error("duplicate key value"), { code: "23505" });
    h.state.queue = [
      [EVENT], [EXISTING_A],
      [{ name: "Boss" }],
      {},
      [{ archivedAt: null }],
      [EXISTING_A], // 鎖內重讀仲見唔到（極端 race 窗）→ 交俾 DB unique index
      dup, // tx insert reject 23505
    ];
    await expect(
      caller().adminImportExcel({ kind: "ticket", fileBase64: b64, eventId: 7, commit: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("list commit：開新名單（檔案內去重）＋maxWinsPerPerson 落 DB", async () => {
    const b64 = makeXlsxBase64("list", [["陳小明"], [" 陳小明 "], ["陳大文"]]);
    h.state.queue = [
      [{ name: "Boss" }], // actorName
      [{ id: 55 }], // insert luckyDrawLists returning
    ];
    const r = await caller().adminImportExcel({ kind: "list", fileBase64: b64, commit: true, listName: "11月場", maxWinsPerPerson: 2 });
    expect(r.committed).toBe(true);
    expect(r.listId).toBe(55);
    expect(r.duplicates).toHaveLength(1); // 檔案內重複去咗
    const listIns = insertsOf(luckyDrawLists);
    expect(listIns).toHaveLength(1);
    expect(listIns[0].values).toMatchObject({ name: "11月場", names: ["陳小明", "陳大文"], memberIds: [], maxWinsPerPerson: 2 });
  });

  it("list commit 冇填名單名 → BAD_REQUEST，零寫入", async () => {
    const b64 = makeXlsxBase64("list", [["陳小明"]]);
    await expect(caller().adminImportExcel({ kind: "list", fileBase64: b64, commit: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insertsOf(luckyDrawLists)).toHaveLength(0);
  });

  it("hardening：list commit 最終 names 為空（得 header）→ BAD_REQUEST，唔准開空名單", async () => {
    const b64 = makeXlsxBase64("list", []); // header only，零數據行、零逐行錯誤
    await expect(
      caller().adminImportExcel({ kind: "list", fileBase64: b64, commit: true, listName: "空場" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insertsOf(luckyDrawLists)).toHaveLength(0);
    // preview（commit=false）同一檔案就唔會 throw，照回 committed:false 零寫
    const r = await caller().adminImportExcel({ kind: "list", fileBase64: b64, listName: "空場" });
    expect(r.committed).toBe(false);
    expect(insertsOf(luckyDrawLists)).toHaveLength(0);
  });

  it("非 PK 檔案 → BAD_REQUEST（2MB/magic 守衛）", async () => {
    const b64 = Buffer.from("definitely not a zip").toString("base64");
    await expect(caller().adminImportExcel({ kind: "list", fileBase64: b64 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ───────────────────────── template endpoint ─────────────────────────

describe("adminDownloadTemplate", () => {
  it("回真 .xlsx base64，parser 讀返正確 header", async () => {
    const r = await caller().adminDownloadTemplate({ kind: "ticket" });
    expect(r.filename).toContain("抽獎劵");
    const buf = Buffer.from(r.base64, "base64");
    expect(hasPkMagic(buf)).toBe(true);
    const rows = parseXlsxRows(buf);
    expect(rows[0].cells).toEqual(["姓名", "抽獎劵數"]);
    expect(rows).toHaveLength(1); // header only，冇示例人名
  });
});

// ───────────────────────── history 合約 ─────────────────────────

describe("adminHistory 活動追溯合約", () => {
  it("回傳按日分組（新→舊）＋帶 eventId/eventName/eventEntryId", async () => {
    const row = (id: number, date: string, eventName: string | null) => ({
      id, status: "pending", drawDate: date, createdAt: new Date(), redrawOfId: null, cancelNote: null,
      drawnByName: "Boss", orderId: null, notifiedAt: null, winnerNameSnap: "甲", listId: null,
      eventId: eventName ? 7 : null, eventEntryId: eventName ? 11 : null, eventName,
      winnerName: "甲", winnerPhone: "DRAW#甲", orderStatus: null, orderNo: null,
      prizeId: 9, prizeName: "禮物A", prizeSku: "SKU-A", prizePrice: 100, prizeImagePath: null,
    });
    h.state.queue = [[row(2, "20261024", "週年慶"), row(1, "20261023", null)]];
    const days = await caller().adminHistory();
    expect(days.map((d) => d.date)).toEqual(["20261024", "20261023"]);
    expect(days[0].rows[0]).toMatchObject({ eventId: 7, eventName: "週年慶", eventEntryId: 11 });
    expect(days[1].rows[0].eventName).toBeNull(); // 非活動抽獎 → null，向後相容
  });
});

// ───────────────────────── 會員池 redraw（鎖＋狀態認領＋鎖內重數）─────────────────────────

describe("adminRedraw 會員池分支（prize → 香港日期全域鎖＋認領＋鎖內重數）", () => {
  const OLD_MEMBER = { id: 70, prizeId: 9, winnerUserId: 800, winnerName: null, status: "pending", drawDate: "20261024", listId: null, eventId: null, eventEntryId: null, orderId: null };
  const memberQueueBase = () => [
    [OLD_MEMBER], // 讀取舊紀錄
    [PRIZE],
    [{ id: 42 }], // collectParticipantIds allMembers
    [], // 影子帳號排除 select
    [], // exclusions select
    [], // winnersOfDate(old.drawDate)：嗰日冇其他人中（舊中獎人 800 顯式踢走）
    [{ id: 42, name: "王小虎", phone: "91234567", email: null }], // pickWinner
    [{ name: "Boss" }], // actorName
  ];

  it("成功重抽：兩道鎖 → 鎖後認領舊 pending（留 cancelled 底）→ 重數件數 → 重數新中獎人當日限中 → 插新", async () => {
    h.state.queue = [
      ...memberQueueBase(),
      {}, {}, // tx：prize lock → 香港抽獎日全域 lock（舊紀錄抽獎日）
      [{ id: 70 }], // tx 認領舊 pending（update...where status='pending' returning affected=1）
      [{ n: 0 }], // tx 取消舊後重數件數（舊 pending 已讓返一件，唔會假爆滿）
      [{ c: 0 }], // tx 鎖內重數新中獎人嗰日已中次數（會員池一日一次）
      [{ id: 71 }], // tx insert returning
    ];
    const r = await caller().adminRedraw({ drawId: 70, filter: { allMembers: true } });
    expect(r.cancelledDrawId).toBe(70);
    expect(r.winner.name).toBe("王小虎");
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    expect(drawUpd).toHaveLength(1);
    expect(drawUpd[0].set).toMatchObject({ status: "cancelled" }); // 會員池重抽保留「留 cancelled 底」語義
    // 認領守衛 SQL：id＋status='pending'（淨係認領 pending；刪走 status 條件會令測試紅）
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2'], [70, "pending"]);
    const drawIns = insertsOf(luckyDraws);
    expect(drawIns).toHaveLength(1);
    expect(drawIns[0].values).toMatchObject({ redrawOfId: 70, winnerUserId: 42, winnerName: "王小虎", drawDate: "20261024", status: "pending" });
    // 鎖次序：兩道鎖 → 鎖內認領 update → 重數（≥2 個 select）→ insert
    expectLockedWrites(2, 2);
    const claimIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDraws);
    const insIdx = h.state.ops.findIndex((o) => o.op === "insert" && o.table === luckyDraws);
    const lastLock = h.state.ops.map((o, i) => (o.op === "execute" ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(claimIdx).toBeGreaterThan(lastLock); // 認領一定要喺鎖後
    expect(insIdx).toBeGreaterThan(claimIdx);
  });

  it("hardening：鎖後認領 affected=0（狀態已俾人改）→ CONFLICT，唔准插入新 winner", async () => {
    h.state.queue = [
      ...memberQueueBase(),
      {}, {}, // locks
      [], // 認領 returning 0 rows——另一 transaction 已確認/取消/重抽咗
    ];
    await expect(caller().adminRedraw({ drawId: 70, filter: { allMembers: true } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
    expect(h.state.executeCount).toBe(2);
  });

  it("hardening：認領後鎖內重數件數——另一 transaction 已用晒 → CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      ...memberQueueBase(),
      {}, {},
      [{ id: 70 }], // 認領 affected=1
      [{ n: 1 }], // 取消舊後重數：另一抽已佔咗嗰件（quantity=1）
    ];
    await expect(caller().adminRedraw({ drawId: 70, filter: { allMembers: true } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });

  it("hardening：鎖內重數新中獎人嗰日已中（並發改變，會員池一日一次）→ CONFLICT，唔插新 winner", async () => {
    h.state.queue = [
      ...memberQueueBase(),
      {}, {},
      [{ id: 70 }],
      [{ n: 0 }],
      [{ c: 1 }], // 王小虎啱啱喺嗰日中咗（另一 transaction）
    ];
    await expect(caller().adminRedraw({ drawId: 70, filter: { allMembers: true } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(luckyDraws)).toHaveLength(0);
  });
});

// ───────────────────────── adminCancelWin compare-and-swap ─────────────────────────

describe("adminCancelWin compare-and-swap（id＋讀取時 status＋讀取時 orderId）", () => {
  const OLD_PEND = { id: 80, prizeId: 9, winnerUserId: 800, status: "pending", orderId: null, drawDate: "20261024" };
  const OLD_CONF = { id: 81, prizeId: 9, winnerUserId: 800, status: "confirmed", orderId: 500, drawDate: "20261024" };

  it("pending 無單：CAS 認領成功 → cancelled，唔郁訂單", async () => {
    h.state.queue = [
      [OLD_PEND], // 讀取快照
      [{ id: 80 }], // tx CAS update returning（affected=1）
    ];
    const r = await caller().adminCancelWin({ drawId: 80 });
    expect(r).toEqual({ ok: true, orderCancelled: false });
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    expect(drawUpd).toHaveLength(1);
    expect(drawUpd[0].set).toMatchObject({ status: "cancelled" });
    // CAS 守衛 SQL：id＋讀取時 status＋orderId null-safe（orderId null → IS NULL 而唔係 = NULL）
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2', '"orderId" is null'], [80, "pending"]);
    expect(h.state.updates.filter((u) => u.table === orders)).toHaveLength(0);
  });

  it("confirmed 有未批 0 元單：同一 tx 先 CAS 認領 draw，再按訂單狀態取消官網單（次序斷言）", async () => {
    h.state.queue = [
      [OLD_CONF],
      [{ id: 81 }], // tx CAS 認領
      [{ id: 500, status: "payment_review", orderNo: "RC202610240001" }], // tx 內重讀訂單狀態
      [{ id: 500 }], // tx 原子條件 update orders → cancelled（affected=1）
    ];
    const r = await caller().adminCancelWin({ drawId: 81 });
    expect(r).toEqual({ ok: true, orderCancelled: true });
    const drawUpdIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDraws);
    const ordSelIdx = h.state.ops.findIndex((o, i) => o.op === "select" && i > drawUpdIdx);
    const ordUpdIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === orders);
    // 先 CAS 認領成功先郁單——認領失敗就乜都唔郁（唔會 cancelled draw＋live 0 元單）
    expect(ordSelIdx).toBeGreaterThan(drawUpdIdx);
    expect(ordUpdIdx).toBeGreaterThan(drawUpdIdx);
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    // CAS 守衛 SQL（orderId 有值 → = 比對，唔係 IS NULL）
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2', '"orderId" = $3'], [81, "confirmed", 500]);
    const ordUpd = h.state.updates.filter((u) => u.table === orders);
    expect(ordUpd).toHaveLength(1);
    expect(ordUpd[0].set).toMatchObject({ status: "cancelled" });
    // 原子條件取消守衛 SQL：id＋可取消狀態 in (pending_payment, payment_review)——
    // 唔可以淨係 WHERE id（會覆寫並發已批/出貨嘅單）
    expectWhere(ordUpd[0].where, ['"id" = $1', /"status" in \(/], [500, "pending_payment", "payment_review"]);
  });

  it("confirmed 有單但已批出：唔郁張單，照取消中獎（orderCancelled=false）", async () => {
    h.state.queue = [
      [OLD_CONF],
      [{ id: 81 }],
      [{ id: 500, status: "approved", orderNo: "RC202610240001" }],
    ];
    const r = await caller().adminCancelWin({ drawId: 81 });
    expect(r.orderCancelled).toBe(false);
    expect(h.state.updates.filter((u) => u.table === orders)).toHaveLength(0); // 已批嘅單唔郁
    expect(h.state.updates.filter((u) => u.table === luckyDraws)).toHaveLength(1); // draw 照取消
  });

  it("hardening（M1）：select 見未批但並發已 approved——原子條件 update affected=0 → 唔報 orderCancelled，draw 照取消＋警告", async () => {
    h.state.queue = [
      [OLD_CONF],
      [{ id: 81 }], // tx CAS 認領成功
      [{ id: 500, status: "payment_review", orderNo: "RC202610240001" }], // select 快照：仲未批
      [], // 原子條件 update returning 0 rows——select 到 update 之間俾人批咗
    ];
    const r = await caller().adminCancelWin({ drawId: 81 });
    expect(r).toEqual({ ok: true, orderCancelled: false }); // 唔准報 orderCancelled=true
    expect(h.state.updates.filter((u) => u.table === luckyDraws)).toHaveLength(1); // draw CAS 唔回滾
    expect(h.state.updates.filter((u) => u.table === orders)).toHaveLength(1); // 有嘗試原子條件取消
  });

  it("hardening（M1）：訂單已被 hard-delete（select 唔到）→ 唔報 orderCancelled，走警告分支", async () => {
    h.state.queue = [
      [OLD_CONF],
      [{ id: 81 }], // tx CAS 認領成功
      [], // tx 內 select 訂單：已唔存在
    ];
    const r = await caller().adminCancelWin({ drawId: 81 });
    expect(r).toEqual({ ok: true, orderCancelled: false });
    expect(h.state.updates.filter((u) => u.table === orders)).toHaveLength(0); // 冇單可郁
    expect(h.state.updates.filter((u) => u.table === luckyDraws)).toHaveLength(1); // draw 照取消
  });

  it("hardening：CAS affected=0（狀態/orderId 俾人改咗）→ CONFLICT，唔郁訂單", async () => {
    h.state.queue = [
      [OLD_CONF],
      [], // CAS returning 0 rows——另一請求已確認/換咗新 orderId/取消咗
    ];
    await expect(caller().adminCancelWin({ drawId: 81 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.state.updates.filter((u) => u.table === luckyDraws)).toHaveLength(1); // 淨係 CAS 一次嘗試
    expect(h.state.updates.filter((u) => u.table === orders)).toHaveLength(0); // 唔准郁人哋新綁嘅單
  });
});

// ───────────────────────── adminConfirmManual／respondWin 認領＋起單同一 transaction ─────────────────────────

describe("adminConfirmManual 認領＋起單同一 transaction", () => {
  const DRAW_M = { id: 90, prizeId: 9, winnerUserId: 900, winnerName: "陳小明", status: "pending", drawDate: "20261024", createdAt: new Date("2026-10-24T04:00:00Z"), orderId: null };
  const PRODUCT = { id: 30, sku: "SKU-A", name: "禮物A" };
  const confirmQueueBase = () => [
    [DRAW_M], // 讀取中獎紀錄
    [{ phone: "DRAW#陳小明" }], // 影子帳號守衛
    [PRIZE],
    [PRODUCT], // getOrCreatePrizeProduct：同 SKU 重用
    [], // genOrderNo 重複檢查
  ];

  it("成功：tx 內 claim（pending→confirmed）→ 起單 → 行項目 → 狀態守衛綁 orderId（次序斷言）", async () => {
    h.state.queue = [
      ...confirmQueueBase(),
      [{ id: 90 }], // tx claim returning affected=1
      [{ id: 600, orderNo: "RC202610240001" }], // tx insert orders returning
      [], // tx insert orderItems
      [{ id: 90 }], // tx 綁 orderId（status=confirmed＋orderId IS NULL 守衛）affected=1
    ];
    const r = await caller().adminConfirmManual({ drawId: 90 });
    expect(r).toMatchObject({ ok: true, orderId: 600 });
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    expect(drawUpd).toHaveLength(2);
    expect(drawUpd[0].set).toMatchObject({ status: "confirmed" }); // 先認領
    expect(drawUpd[1].set).toMatchObject({ orderId: 600 }); // 後綁單
    // claim 守衛 SQL：id＋status='pending'（雙擊/已取消 → affected=0）
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2'], [90, "pending"]);
    // 綁單守衛 SQL：id＋status='confirmed'＋orderId IS NULL（唔會綁到已取消/已綁嘅紀錄）
    expectWhere(drawUpd[1].where, ['"id" = $1', '"status" = $2', '"orderId" is null'], [90, "confirmed"]);
    const claimIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDraws);
    const ordInsIdx = h.state.ops.findIndex((o) => o.op === "insert" && o.table === orders);
    const itemInsIdx = h.state.ops.findIndex((o) => o.op === "insert" && o.table === orderItems);
    const bindIdx = h.state.ops.findIndex((o, i) => o.op === "update" && o.table === luckyDraws && i > claimIdx);
    expect(ordInsIdx).toBeGreaterThan(claimIdx); // 認領先於起單（同一 tx，cancel 穿唔入中間）
    expect(itemInsIdx).toBeGreaterThan(ordInsIdx);
    expect(bindIdx).toBeGreaterThan(itemInsIdx);
    const ordIns = insertsOf(orders);
    expect(ordIns).toHaveLength(1);
    expect(ordIns[0].values).toMatchObject({ total: 0, status: "payment_review", shippingFree: true, userId: 900 });
    expect(vi.mocked(forwardOrderToWms)).toHaveBeenCalledWith(600);
  });

  it("hardening：tx 內 claim affected=0（已處理/取消咗）→ CONFLICT，唔會起孤兒 0 元單", async () => {
    h.state.queue = [
      ...confirmQueueBase(),
      [], // claim returning 0 rows
    ];
    await expect(caller().adminConfirmManual({ drawId: 90 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(orders)).toHaveLength(0); // 認領失敗 → 根本唔起單
    expect(insertsOf(orderItems)).toHaveLength(0);
    expect(vi.mocked(forwardOrderToWms)).not.toHaveBeenCalled();
  });

  it("hardening：綁 orderId 守衛 affected=0（紀錄俾人改咗）→ CONFLICT（真 PG 會 rollback 全 tx），唔飛 WMS", async () => {
    h.state.queue = [
      ...confirmQueueBase(),
      [{ id: 90 }],
      [{ id: 600, orderNo: "RC202610240001" }],
      [],
      [], // bind returning 0 rows
    ];
    await expect(caller().adminConfirmManual({ drawId: 90 })).rejects.toMatchObject({ code: "CONFLICT" });
    // ⚠️ mock transaction 唔會真 rollback：呢度斷言錯誤點之後冇後續動作（唔飛 WMS）；
    // 真 PG 靠 DB rollback 唔會留孤兒單（需 integration test 覆蓋）
    expect(vi.mocked(forwardOrderToWms)).not.toHaveBeenCalled();
  });
});

describe("respondWin ship 認領＋起單同一 transaction", () => {
  const DRAW_R = { id: 95, prizeId: 9, winnerUserId: 42, winnerName: null, status: "pending", drawDate: "20261024", createdAt: new Date("2026-10-24T04:00:00Z"), orderId: null };
  const PRODUCT = { id: 30, sku: "SKU-A", name: "禮物A" };
  const respondQueueBase = () => [
    [DRAW_R], // 讀取中獎紀錄（id＋winnerUserId）
    [PRIZE],
    [{ id: 42, deliveryMethod: "address", pickupPoint: null, address: "香港九龍測試道1號" }], // me（preset 地址）
    [PRODUCT],
    [], // genOrderNo 重複檢查
  ];

  it("成功 ship：tx 內 claim → 起單 → 行項目 → 守衛綁 orderId", async () => {
    reset({ userId: 42, role: "member" });
    h.state.queue = [
      ...respondQueueBase(),
      [{ id: 95 }], // claim
      [{ id: 601, orderNo: "RC202610240002" }], // insert orders
      [], // insert orderItems
      [{ id: 95 }], // bind
    ];
    const r = await caller().respondWin({ drawId: 95, action: "ship", choice: "preset" });
    expect(r).toMatchObject({ ok: true, declined: false, orderId: 601 });
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    expect(drawUpd).toHaveLength(2);
    expect(drawUpd[0].set).toMatchObject({ status: "confirmed" });
    expect(drawUpd[1].set).toMatchObject({ orderId: 601 });
    // claim 守衛 SQL：id＋status='pending'；綁單守衛 SQL：id＋status='confirmed'＋orderId IS NULL
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2'], [95, "pending"]);
    expectWhere(drawUpd[1].where, ['"id" = $1', '"status" = $2', '"orderId" is null'], [95, "confirmed"]);
    const claimIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDraws);
    const ordInsIdx = h.state.ops.findIndex((o) => o.op === "insert" && o.table === orders);
    expect(ordInsIdx).toBeGreaterThan(claimIdx); // 認領先於起單
    const ordIns = insertsOf(orders);
    expect(ordIns).toHaveLength(1);
    expect(ordIns[0].values).toMatchObject({ total: 0, userId: 42, address: "香港九龍測試道1號", shippingFree: true });
  });

  it("hardening：claim affected=0（雙擊/已取消）→ CONFLICT，唔起單唔飛 WMS", async () => {
    reset({ userId: 42, role: "member" });
    h.state.queue = [...respondQueueBase(), []];
    await expect(caller().respondWin({ drawId: 95, action: "ship", choice: "preset" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(insertsOf(orders)).toHaveLength(0);
    expect(vi.mocked(forwardOrderToWms)).not.toHaveBeenCalled();
  });
});

// ───────────────────────── adminNotifyWin 原子認領（status='pending'＋notifiedAt IS NULL）─────────────────────────

describe("adminNotifyWin 原子認領＋already 分流", () => {
  const DRAW_N = { id: 96, prizeId: 9, winnerUserId: 42, winnerName: null, status: "pending", drawDate: "20261024", notifiedAt: null };
  const notifyQueueBase = () => [
    [DRAW_N],
    [{ id: 42, name: "王小虎", email: "w@example.com", phone: "91234567" }], // winner
    [PRIZE],
  ];

  it("成功認領 → 發 email＋推送（通知只喺成功 claim 後觸發）", async () => {
    h.state.queue = [...notifyQueueBase(), [{ id: 96 }]]; // claim affected=1
    const r = await caller().adminNotifyWin({ drawId: 96 });
    expect(r).toEqual({ ok: true, already: false });
    expect(vi.mocked(sendPrizeWinEmail)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPrizeWinPush)).toHaveBeenCalledTimes(1);
    const drawUpd = h.state.updates.filter((u) => u.table === luckyDraws);
    expect(drawUpd).toHaveLength(1);
    expect(drawUpd[0].set).toHaveProperty("notifiedAt");
    // 原子認領守衛 SQL：id＋status='pending'＋notifiedAt IS NULL（刪走任何一個都會令測試紅）
    expectWhere(drawUpd[0].where, ['"id" = $1', '"status" = $2', '"notifiedAt" is null'], [96, "pending"]);
  });

  it("claim 落空＋重讀仍 pending 但 notifiedAt 已有值 → already:true，唔重複發", async () => {
    h.state.queue = [...notifyQueueBase(), [], [{ status: "pending", notifiedAt: new Date() }]];
    const r = await caller().adminNotifyWin({ drawId: 96 });
    expect(r).toEqual({ ok: true, already: true });
    expect(vi.mocked(sendPrizeWinEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrizeWinPush)).not.toHaveBeenCalled();
  });

  it("claim 落空＋重讀已 cancelled → CONFLICT，唔准發通知", async () => {
    h.state.queue = [...notifyQueueBase(), [], [{ status: "cancelled", notifiedAt: null }]];
    await expect(caller().adminNotifyWin({ drawId: 96 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(vi.mocked(sendPrizeWinEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrizeWinPush)).not.toHaveBeenCalled();
  });

  it("claim 落空＋重讀已 declined → CONFLICT，唔准發通知", async () => {
    h.state.queue = [...notifyQueueBase(), [], [{ status: "declined", notifiedAt: null }]];
    await expect(caller().adminNotifyWin({ drawId: 96 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(vi.mocked(sendPrizeWinEmail)).not.toHaveBeenCalled();
    expect(vi.mocked(sendPrizeWinPush)).not.toHaveBeenCalled();
  });
});

// ───────────────────────── lucky draw insert FK 23503 → CONFLICT ─────────────────────────

describe("lucky draw insert FK 23503 → CONFLICT（唔好 raw 500）", () => {
  it("adminDraw insert 撞 FK 23503（PG error code 直出）→ 可見 CONFLICT", async () => {
    const fk = Object.assign(new Error("insert or update violates foreign key constraint"), { code: "23503" });
    h.state.queue = [
      [PRIZE], [{ id: 42 }], [], [], [],
      [{ id: 42, name: "王小虎", phone: "91234567", email: null }],
      [{ name: "Boss" }],
      {}, {},
      [{ n: 0 }],
      [{ c: 0 }],
      fk, // tx insert reject 23503（例如獎品俾人並發刪咗）
    ];
    await expect(caller().adminDraw({ prizeId: 9, filter: { allMembers: true } })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("DrizzleQueryError 收喺 cause.code 嘅 23503 一樣認（adminDrawManual）→ CONFLICT", async () => {
    const fk = Object.assign(new Error("Failed query: insert into lucky_draws"), { cause: { code: "23503" } });
    h.state.queue = [
      [PRIZE],
      [{ id: 5, name: "VIP場", names: ["陳小明"], memberIds: [], maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date() }],
      [], [], // name/id counts
      [], // shadow select miss
      [{ id: 900, name: "陳小明" }], // shadow insert
      [{ name: "Boss" }],
      {}, {},
      [{ n: 0 }],
      [{ c: 0 }],
      fk,
    ];
    await expect(caller().adminDrawManual({ prizeId: 9, listId: 5 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ───────────────────────── 影子帳號 phone key（長名 prefix＋穩定 hash，唔斷 surrogate）─────────────────────────

describe("影子帳號 phone key（向後相容短名、長名唔碰撞、唔斷 emoji）", () => {
  /** 用 adminDrawManual 行一次單名名單抽獎，回傳影子帳號 insert 嘅 phone（取最後一次，方便同名兩次斷言） */
  const drawWithName = async (name: string) => {
    h.state.queue = [
      [PRIZE],
      [{ id: 5, name: "VIP場", names: [name], memberIds: [], maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date() }],
      [], [], // name/id counts
      [], // shadow select miss
      [{ id: 900, name }], // shadow insert returning
      [{ name: "Boss" }],
      {}, {},
      [{ n: 0 }],
      [{ c: 0 }],
      [DRAW_ROW],
    ];
    await caller().adminDrawManual({ prizeId: 9, listId: 5 });
    const ins = insertsOf(users);
    return ins[ins.length - 1].values.phone as string;
  };

  it("短名向後相容：原樣 DRAW#名（同舊 slice(0,32) 對短名結果一致）", async () => {
    expect(await drawWithName("陳大文")).toBe("DRAW#陳大文");
  });

  it("兩個同 prefix 長名 → phone 唔同（hash 後綴），總長 ≤32 code points、DRAW# 前綴保留", async () => {
    const nameA = "阿".repeat(27) + "甲"; // 全 key 33 code points > 32 → 行 hash 路線
    const nameB = "阿".repeat(27) + "乙"; // 舊 slice(0,32) 會同 A 撞 key
    const phoneA = await drawWithName(nameA);
    const phoneB = await drawWithName(nameB);
    expect(phoneA).not.toBe(phoneB);
    expect(phoneA.startsWith("DRAW#")).toBe(true); // collectParticipantIds/通知守衛靠呢個前綴
    expect(phoneB.startsWith("DRAW#")).toBe(true);
    expect([...phoneA].length).toBeLessThanOrEqual(32);
    expect([...phoneB].length).toBeLessThanOrEqual(32);
  });

  it("同名重用：同一長名兩次砌出同一 key（createHash 穩定，冇秘密/隨機 salt）", async () => {
    const name = "阿".repeat(27) + "甲";
    expect(await drawWithName(name)).toBe(await drawWithName(name));
  });

  it("emoji 長名唔會切斷 surrogate pair，長度 ≤32 code points", async () => {
    const phone = await drawWithName("🎉".repeat(30)); // 全 key 35 code points／65 UTF-16 units
    expect([...phone].length).toBeLessThanOrEqual(32);
    // 冇孤立 surrogate：encodeURIComponent 遇到 lone surrogate 會 throw URIError（切半個 emoji 即中）
    expect(() => encodeURIComponent(phone)).not.toThrow();
  });

  it("23505 收喺 cause.code 都認得：影子帳號 insert 撞 unique → 重讀現有，抽獎照完成", async () => {
    const dup = Object.assign(new Error("Failed query: insert into users"), { cause: { code: "23505" } });
    h.state.queue = [
      [PRIZE],
      [{ id: 5, name: "VIP場", names: ["陳大文"], memberIds: [], maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date() }],
      [], [],
      [], // shadow select miss
      dup, // shadow insert reject（DrizzleQueryError 型態：code 喺 cause）
      [{ id: 951, name: "陳大文" }], // 重讀命中並發建立咗嘅影子帳號
      [{ name: "Boss" }],
      {}, {},
      [{ n: 0 }],
      [{ c: 0 }],
      [DRAW_ROW],
    ];
    const r = await caller().adminDrawManual({ prizeId: 9, listId: 5 });
    expect(r.winner.id).toBe(951); // 重用現有影子帳號
    expect(insertsOf(luckyDraws)).toHaveLength(1);
  });
});

// ───────────────────────── adminDeleteDraw／adminDeleteDrawsByDate（tx 內 DELETE RETURNING orderId）─────────────────────────

describe("adminDeleteDraw 硬刪（tx 內 DELETE RETURNING orderId 攞真實綁單）", () => {
  const DRAW_JOIN = (orderId: number | null) => ({
    draw: { id: 100, prizeId: 9, winnerUserId: 800, winnerName: "陳小明", status: "confirmed", drawDate: "20261024", orderId },
    winnerUserName: "陳小明",
    prizeName: "禮物A",
  });

  it("成功：tx 內刪 draw RETURNING orderId → 按真實綁單刪仔行＋張單（op 順序＋回傳依賴斷言）", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [DRAW_JOIN(555)], // 讀取紀錄（join users/luckyPrizes）
      [{ orderId: 555 }], // tx DELETE luckyDraws ... RETURNING orderId（行鎖內真實綁單）
      [{ orderNo: "RC202610240099" }], // tx 內攞單號做 audit
      [], // tx delete orderShipments
      [], // tx delete orderItems
      [], // tx delete paymentProofs
      [], // tx delete wmsSyncLog
      [{ id: 555 }], // tx delete orders returning
    ];
    const r = await caller().adminDeleteDraw({ drawId: 100 });
    expect(r).toEqual({ ok: true, orderDeleted: true });
    const dels = h.state.deletes;
    expect(dels.map((d) => d.table)).toEqual([luckyDraws, orderShipments, orderItems, paymentProofs, wmsSyncLog, orders]);
    // 一定要 DELETE ... RETURNING orderId（唔准用 transaction 外快照）
    expect(dels[0].returning).toHaveProperty("orderId");
    expect(dels[0].returning.orderId).toBe(luckyDraws.orderId);
    // 仔行／張單嘅刪除條件要用返 RETURNING 嘅 orderId（回傳依賴）——
    // 逐張表 orderId=555 斷言：唔會刪到其他單嘅 shipments/仔行
    expectWhere(dels[1].where, ['"orderId" = $1'], [555]); // orderShipments
    expectWhere(dels[2].where, ['"orderId" = $1'], [555]);
    expectWhere(dels[3].where, ['"orderId" = $1'], [555]);
    expectWhere(dels[4].where, ['"orderId" = $1'], [555]);
    expectWhere(dels[5].where, ['"id" = $1'], [555]);
    // 順序：luckyDraws 先（FK 指住 orders）→ 仔行（orderShipments 都係 FK 仔行，要喺 orders 前）→ orders 本行
    const ops = h.state.ops;
    const iDraw = ops.findIndex((o) => o.op === "delete" && o.table === luckyDraws);
    const iShipments = ops.findIndex((o) => o.op === "delete" && o.table === orderShipments);
    const iItems = ops.findIndex((o) => o.op === "delete" && o.table === orderItems);
    const iOrders = ops.findIndex((o) => o.op === "delete" && o.table === orders);
    expect(iShipments).toBeGreaterThan(iDraw);
    expect(iItems).toBeGreaterThan(iDraw);
    expect(iOrders).toBeGreaterThan(iShipments); // orderShipments 一定要早過 orders（唔係會 23503）
    expect(iOrders).toBeGreaterThan(iItems);
  });

  it("regression（M3）：外層快照 orderId=null 但 tx 內 RETURNING 有 orderId（並發 respondWin/confirmManual 先 commit）→ 刪到真實關聯單", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [DRAW_JOIN(null)], // transaction 外快照：仲未綁單
      [{ orderId: 777 }], // tx 行鎖內真實狀態：對方已綁咗單 777
      [{ orderNo: "RC202610240100" }],
      [], [], [], [],
      [{ id: 777 }],
    ];
    const r = await caller().adminDeleteDraw({ drawId: 100 });
    expect(r).toEqual({ ok: true, orderDeleted: true }); // 唔會留孤兒 0 元單
    const dels = h.state.deletes;
    expect(dels.map((d) => d.table)).toEqual([luckyDraws, orderShipments, orderItems, paymentProofs, wmsSyncLog, orders]);
    expectWhere(dels[1].where, ['"orderId" = $1'], [777]); // orderShipments 用 tx RETURNING 嘅真實 orderId，唔係快照 null
    expectWhere(dels[2].where, ['"orderId" = $1'], [777]);
    expectWhere(dels[5].where, ['"id" = $1'], [777]);
  });

  it("tx RETURNING orderId=null（真係冇綁單）→ 唔郁訂單，orderDeleted=false", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [DRAW_JOIN(null)],
      [{ orderId: null }], // 行鎖內都冇綁單
    ];
    const r = await caller().adminDeleteDraw({ drawId: 100 });
    expect(r).toEqual({ ok: true, orderDeleted: false });
    expect(h.state.deletes.map((d) => d.table)).toEqual([luckyDraws]); // 淨係刪 draw 本行
  });

  it("張單已唔存在（重複刪除）：仔行照清、orders delete 0 行 → orderDeleted=false，唔報錯", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [DRAW_JOIN(555)],
      [{ orderId: 555 }],
      [], // tx 內攞單號：張單已唔存在
      [], [], [], [],
      [], // orders delete returning 0 rows
    ];
    const r = await caller().adminDeleteDraw({ drawId: 100 });
    expect(r).toEqual({ ok: true, orderDeleted: false });
    expect(h.state.deletes.map((d) => d.table)).toEqual([luckyDraws, orderShipments, orderItems, paymentProofs, wmsSyncLog, orders]);
  });
});

describe("adminDeleteDrawsByDate 成日刪（以實際 deleted rows 嘅 orderId 集合作準）", () => {
  it("成功：tx 內 DELETE RETURNING orderId 集合 → 只刪實際刪除 draw 綁嘅單（零快照 select）", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [{ orderId: 500 }, { orderId: null }, { orderId: 501 }], // tx DELETE luckyDraws RETURNING（去重→[500,501]）
      [], // tx delete orderShipments
      [], // tx delete orderItems
      [], // tx delete paymentProofs
      [], // tx delete wmsSyncLog
      [{ id: 500 }, { id: 501 }], // tx delete orders returning
    ];
    const r = await caller().adminDeleteDrawsByDate({ drawDate: "20261024" });
    expect(r).toEqual({ ok: true, deleted: 3, ordersDeleted: 2 });
    // 唔准再有 transaction 外嘅 leftJoin 快照 select
    expect(h.state.selects.filter((s) => s.from !== users)).toHaveLength(0);
    const dels = h.state.deletes;
    expect(dels.map((d) => d.table)).toEqual([luckyDraws, orderShipments, orderItems, paymentProofs, wmsSyncLog, orders]);
    // 刪 draw 用 drawDate；RETURNING 一定要帶 orderId
    expectWhere(dels[0].where, ['"drawDate" = $1'], ["20261024"]);
    expect(dels[0].returning).toHaveProperty("orderId");
    expect(dels[0].returning.orderId).toBe(luckyDraws.orderId);
    // 仔行／orders 用實際 deleted rows 嘅 orderId 集合（inArray 參數斷言——唔會刪到其他單嘅 shipments）
    expectWhere(dels[1].where, [/"orderId" in \(/], [500, 501]); // orderShipments
    expectWhere(dels[2].where, [/"orderId" in \(/], [500, 501]);
    expectWhere(dels[5].where, [/"id" in \(/], [500, 501]);
    // orderShipments 要喺 orders 之前刪（FK 指住 orders，調轉會 23503）
    const ops = h.state.ops;
    const iShipments = ops.findIndex((o) => o.op === "delete" && o.table === orderShipments);
    const iOrders = ops.findIndex((o) => o.op === "delete" && o.table === orders);
    expect(iShipments).toBeGreaterThanOrEqual(0);
    expect(iOrders).toBeGreaterThan(iShipments);
  });

  it("實際刪除嘅 rows 全部冇綁單 → 唔郁訂單（唔會誤刪其他單）", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [
      [{ orderId: null }, { orderId: null }], // 實際刪到嘅 draw 都冇綁單
    ];
    const r = await caller().adminDeleteDrawsByDate({ drawDate: "20261024" });
    expect(r).toEqual({ ok: true, deleted: 2, ordersDeleted: 0 });
    expect(h.state.deletes.map((d) => d.table)).toEqual([luckyDraws]); // 淨係刪 draw
    expect(h.state.selects.filter((s) => s.from !== users)).toHaveLength(0);
  });

  it("嗰日冇紀錄 → deleted=0，零額外寫", async () => {
    reset({ userId: 1, role: "admin" });
    h.state.queue = [[]]; // DELETE RETURNING 0 rows
    const r = await caller().adminDeleteDrawsByDate({ drawDate: "20261024" });
    expect(r).toEqual({ ok: true, deleted: 0, ordersDeleted: 0 });
    expect(h.state.deletes.map((d) => d.table)).toEqual([luckyDraws]);
  });
});

// ───────────────────────── adminSetEventArchived（event 雙 key 鎖內重讀＋update）─────────────────────────

describe("adminSetEventArchived 歸檔／取消歸檔（DB transaction＋EVENT_LOCK_NS 鎖，同抽獎互斥）", () => {
  const EVENT = { id: 7, name: "週年慶", maxWinsPerPerson: 1, createdBy: null, createdByName: null, createdAt: new Date(), archivedAt: null, archivedByName: null };

  it("歸檔：transaction 內攞 pg_advisory_xact_lock(EVENT_LOCK_NS=845120, eventId) → 鎖內重讀 → update archivedAt/archivedByName", async () => {
    h.state.queue = [
      [EVENT], // transaction 外讀取（NOT_FOUND 守衛＋audit 用名）
      [{ name: "Boss" }], // actorName
      {}, // tx execute：event 雙 key lock
      [{ id: 7 }], // tx 鎖內重讀活動
      [], // tx update luckyDrawEvents
    ];
    const r = await caller().adminSetEventArchived({ eventId: 7, archived: true });
    expect(r).toEqual({ ok: true });
    expect(h.state.txCount).toBe(1); // 一定要行 DB transaction（唔准 bare auto-commit update）
    expect(h.state.executeCount).toBe(1); // 一道 event lock（冇 prize 參與）
    // 鎖 key/namespace 精確斷言：pg_advisory_xact_lock(845120, 7)——同 adminDrawEvent／event redraw／ticket commit 同一把
    const lock = pgDialect.sqlToQuery(h.state.executes[0]);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.params).toEqual([845120, 7]);
    const upd = h.state.updates.filter((u) => u.table === luckyDrawEvents);
    expect(upd).toHaveLength(1);
    expect(upd[0].set.archivedAt).toBeInstanceOf(Date);
    expect(upd[0].set.archivedByName).toBe("Boss"); // operator 名照寫
    expectWhere(upd[0].where, ['"id" = $1'], [7]);
    // 鎖先於 update，中間要有鎖內重讀 select（唔信 transaction 外快照）
    const lockIdx = h.state.ops.findIndex((o) => o.op === "execute");
    const updIdx = h.state.ops.findIndex((o) => o.op === "update" && o.table === luckyDrawEvents);
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updIdx).toBeGreaterThan(lockIdx);
    const rereads = h.state.ops.slice(lockIdx + 1, updIdx).filter((o) => o.op === "select").length;
    expect(rereads).toBeGreaterThanOrEqual(1);
  });

  it("取消歸檔：同一把 event 雙 key 鎖 → 鎖內重讀 → update set archivedAt:null＋archivedByName:null", async () => {
    h.state.queue = [
      [{ ...EVENT, archivedAt: new Date(), archivedByName: "Boss" }], // 已歸檔活動
      [{ name: "Boss" }],
      {}, // tx event lock
      [{ id: 7 }], // 鎖內重讀
      [], // tx update
    ];
    const r = await caller().adminSetEventArchived({ eventId: 7, archived: false });
    expect(r).toEqual({ ok: true });
    expect(h.state.txCount).toBe(1);
    const lock = pgDialect.sqlToQuery(h.state.executes[0]);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.params).toEqual([845120, 7]); // unarchive 都用同一把 EVENT_LOCK_NS 鎖（同歸檔/抽獎互鎖）
    const upd = h.state.updates.filter((u) => u.table === luckyDrawEvents);
    expect(upd).toHaveLength(1);
    expect(upd[0].set).toMatchObject({ archivedAt: null, archivedByName: null });
    expectWhere(upd[0].where, ['"id" = $1'], [7]);
  });

  it("活動唔存在 → NOT_FOUND（transaction 外擋，唔入鎖零寫）", async () => {
    h.state.queue = [[]];
    await expect(caller().adminSetEventArchived({ eventId: 7, archived: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.state.txCount).toBe(0);
    expect(h.state.executeCount).toBe(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("hardening：鎖內重讀發現活動啱啱俾人刪咗 → NOT_FOUND，唔 update", async () => {
    h.state.queue = [
      [EVENT], // transaction 外快照仲喺度
      [{ name: "Boss" }],
      {}, // tx event lock
      [], // 鎖內重讀：活動 row 冇咗
    ];
    await expect(caller().adminSetEventArchived({ eventId: 7, archived: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.state.executeCount).toBe(1); // 確實入咗鎖先重讀
    expect(h.state.updates.filter((u) => u.table === luckyDrawEvents)).toHaveLength(0);
  });
});

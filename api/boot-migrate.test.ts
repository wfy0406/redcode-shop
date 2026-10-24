/**
 * boot-migrate 開機 migration 順序／幂等測試——**唔掂真 DB**。
 *
 * 背景（2026-10-24 hardening）：
 * 1) 「ALTER TYPE role ADD VALUE 'supervisor'」原本喺 DDL 之前跑——fresh DB 上 role type
 *    仲未建，第一腳就炸，成段 boot migration 報銷。
 * 2) notifiedAt DO block 原本排喺 CREATE TABLE "luckyDraws" 之前——fresh DB 上 DO block
 *    嘅 ALTER TABLE 炸咗被 skip，之後 CREATE TABLE 建出嚟嘅表永遠缺 notifiedAt 欄。
 *
 * 做法：直接讀 boot-migrate.ts 源碼，抽出 DDL 同 POST_DDL_STATEMENTS，用
 * mock SQL executor 模擬 PostgreSQL 行為（表／enum／欄存在性檢查同窗等語義），
 * 覆蓋 fresh／existing（舊版 DB 升級）／repeat（重跑）三種流程。
 *
 * ⚠️ 限制：呢個係源碼順序＋mock 行為驗證，**未做真 PostgreSQL 驗證**；
 * 真庫驗證要喺部署前用 throwaway Postgres 跑 ensureDatabase()。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ── 由源碼抽出真實 migration 內容（唔 import module——pg 喺測試環境唔存在）──
const SRC = readFileSync(new URL("./boot-migrate.ts", import.meta.url), "utf8");

function extractConstTemplate(name: string): string {
  const m = SRC.match(new RegExp(`const ${name}[^=]*= \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`喺 boot-migrate.ts 搵唔到 ${name} template literal`);
  return m[1];
}

const DDL = extractConstTemplate("DDL");
// POST_DDL_STATEMENTS 係 string[]，入面每個元素係 template literal
const POST_ARR = SRC.match(/const POST_DDL_STATEMENTS[^=]*=\s*\[([\s\S]*?)\];/);
if (!POST_ARR) throw new Error("喺 boot-migrate.ts 搵唔到 POST_DDL_STATEMENTS");
const POST_DDL_STATEMENTS = [...POST_ARR[1].matchAll(/`([^`]*)`/g)].map((m) => m[1]);
if (POST_DDL_STATEMENTS.length === 0) throw new Error("POST_DDL_STATEMENTS 係空");

// 同 boot-migrate.ts 內 splitStatements 逐字對應（DO $$ 區塊嘅分號唔切；純註解語句過濾）
function splitStatements(sqlText: string): string[] {
  const stmts: string[] = [];
  let buf = "";
  let inDollar = false;
  for (let i = 0; i < sqlText.length; i++) {
    const two = sqlText.slice(i, i + 2);
    if (two === "$$") {
      inDollar = !inDollar;
      buf += two;
      i++;
      continue;
    }
    if (sqlText[i] === ";" && !inDollar) {
      stmts.push(buf);
      buf = "";
      continue;
    }
    buf += sqlText[i];
  }
  if (buf.trim()) stmts.push(buf);
  return stmts.filter((s) =>
    s.split("\n").some((l) => l.replace(/--.*$/, "").trim().length > 0),
  );
}

/** 等同 boot-migrate.ts buildMigrationStatements()：DDL 先，POST_DDL 後 */
function buildMigrationStatements(): string[] {
  return [...splitStatements(DDL), ...POST_DDL_STATEMENTS];
}

// ── Mock executor：模擬 PG 對存在性嘅檢查同窗等語義 ──────────────
type MockState = {
  types: Map<string, Set<string>>;
  tables: Map<string, Set<string>>;
  constraints: Set<string>;
  applied: string[]; // 實際執行咗嘅動作 marker（驗 backfill 次數用）
};

function newMockState(): MockState {
  return { types: new Map(), tables: new Map(), constraints: new Set(), applied: [] };
}

function needTable(st: MockState, t: string): Set<string> {
  const cols = st.tables.get(t);
  if (!cols) throw new Error(`relation "${t}" does not exist`);
  return cols;
}

/** CREATE TABLE body → 欄名集（top-level comma 切；每段第一個 token 係欄名） */
function parseColumns(body: string): Set<string> {
  const cols = new Set<string>();
  let depth = 0;
  let cur = "";
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const m = p.trim().match(/^"?([A-Za-z_]\w*)"?/);
    if (m && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) cols.add(m[1]);
  }
  return cols;
}

function execOne(stmt: string, st: MockState): void {
  // 剝走 -- 註解行先好 match（DDL 入面大量行首註解；DDL 冇 "--" 字串字面量）
  const s = stmt
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .trim();

  // DO $$ ... $$ 區塊
  if (/^DO\s+\$\$/i.test(s)) {
    // CREATE TYPE（duplicate_object → 已存在就 no-op）
    const ct = s.match(/CREATE TYPE (\w+) AS ENUM\s*\(([^)]*)\)/i);
    if (ct) {
      const [, tname, valsRaw] = ct;
      if (!st.types.has(tname)) {
        const vals = new Set(
          valsRaw.split(",").map((v) => v.trim().replace(/^'|'$/g, "")),
        );
        st.types.set(tname, vals);
        st.applied.push(`createtype:${tname}`);
      }
      return;
    }
    // information_schema.columns 條件加欄（notifiedAt backfill 模式）
    const guard = s.match(
      /IF NOT EXISTS \(\s*SELECT 1 FROM information_schema\.columns\s+WHERE table_name = '([^']+)' AND column_name = '([^']+)'\s*\)/i,
    );
    if (guard) {
      const [, tname, col] = guard;
      const cols = needTable(st, tname); // ⚠️ 表未建喺度炸——就係 fresh DB 缺欄 bug 嘅重現點
      if (!cols.has(col)) {
        const add = s.match(/ALTER TABLE "?\w+"? ADD COLUMN "?(\w+)"?/i);
        if (!add) throw new Error(`mock: DO block 入面搵唔到 ADD COLUMN`);
        cols.add(add[1]);
        st.applied.push(`addcol:${tname}.${col}`);
        if (new RegExp(`UPDATE "${tname}" SET "${col}"`, "i").test(s)) {
          st.applied.push(`backfill:${tname}.${col}`);
        }
      }
      return;
    }
    // pg_constraint 條件加 FK
    const cg = s.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = '([^']+)'\)/i);
    if (cg) {
      const at = s.match(/ALTER TABLE "(\w+)" ADD CONSTRAINT/i);
      if (!at) throw new Error("mock: DO block 入面搵唔到 ADD CONSTRAINT");
      needTable(st, at[1]);
      if (!st.constraints.has(cg[1])) {
        st.constraints.add(cg[1]);
        st.applied.push(`constraint:${cg[1]}`);
      }
      return;
    }
    throw new Error(`mock: 未識嘅 DO block: ${s.slice(0, 120)}`);
  }

  // CREATE TABLE IF NOT EXISTS
  const ctbl = s.match(/^CREATE TABLE IF NOT EXISTS "?(\w+)"?\s*\(([\s\S]*)\)\s*$/i);
  if (ctbl) {
    const [, tname, body] = ctbl;
    if (!st.tables.has(tname)) {
      st.tables.set(tname, parseColumns(body));
      st.applied.push(`createtable:${tname}`);
    }
    return;
  }

  // ALTER TYPE ... ADD VALUE IF NOT EXISTS（⚠️ type 未建喺度炸——fresh DB 順序 bug 重現點）
  const atv = s.match(/^ALTER TYPE (\w+) ADD VALUE IF NOT EXISTS '([^']+)'/i);
  if (atv) {
    const [, tname, val] = atv;
    const vals = st.types.get(tname);
    if (!vals) throw new Error(`type "${tname}" does not exist`);
    if (!vals.has(val)) {
      vals.add(val);
      st.applied.push(`addvalue:${tname}:${val}`);
    }
    return;
  }

  // ALTER TABLE
  const atbl = s.match(/^ALTER TABLE "?(\w+)"? /i);
  if (atbl) {
    const cols = needTable(st, atbl[1]);
    const addIf = s.match(/ADD COLUMN IF NOT EXISTS "?(\w+)"?/i);
    if (addIf) {
      if (!cols.has(addIf[1])) {
        cols.add(addIf[1]);
        st.applied.push(`addcol:${atbl[1]}.${addIf[1]}`);
      }
      return;
    }
    const dropNN = s.match(/ALTER COLUMN "(\w+)" DROP NOT NULL/i);
    if (dropNN) {
      if (!cols.has(dropNN[1])) {
        throw new Error(`column "${dropNN[1]}" of relation "${atbl[1]}" does not exist`);
      }
      return;
    }
    throw new Error(`mock: 未識嘅 ALTER TABLE: ${s.slice(0, 120)}`);
  }

  // CREATE INDEX（IF NOT EXISTS——index 名撞就 no-op；表必須存在）
  const cidx = s.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON\s+"?(\w+)"?/i);
  if (cidx) {
    needTable(st, cidx[2]);
    return;
  }

  // DROP INDEX IF EXISTS：index 唔存在都係 no-op
  if (/^DROP INDEX IF EXISTS \w+/i.test(s)) return;

  // INSERT INTO（可能有 SELECT ... FROM 第二張表）
  const ins = s.match(/^INSERT INTO "?(\w+)"?/i);
  if (ins) {
    needTable(st, ins[1]);
    const from = s.match(/\bFROM "?(\w+)"?/i);
    if (from) needTable(st, from[1]);
    return;
  }

  throw new Error(`mock: 未識嘅語句: ${s.slice(0, 160)}`);
}

function runMigration(st: MockState): void {
  for (const stmt of buildMigrationStatements()) execOne(stmt, st);
}

/** 剝走 -- 註解（行首註解會令 ^XXX regex match 唔到；DDL 冇 "--" 字串字面量） */
function stripComments(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .trim();
}

// ── 測試 ────────────────────────────────────────────────────────

describe("migration 語句順序（靜態斷言）", () => {
  it("ALTER TYPE role ADD VALUE 排喺 CREATE TYPE role 之後", () => {
    const stmts = buildMigrationStatements().map(stripComments);
    const iCreate = stmts.findIndex((s) => /CREATE TYPE role AS ENUM/i.test(s));
    const iAlter = stmts.findIndex((s) => /ALTER TYPE role ADD VALUE/i.test(s));
    expect(iCreate).toBeGreaterThanOrEqual(0);
    expect(iAlter).toBeGreaterThanOrEqual(0);
    expect(iAlter).toBeGreaterThan(iCreate);
  });

  it("CREATE TABLE luckyDraws 排喺 notifiedAt DO block 之前", () => {
    const stmts = buildMigrationStatements().map(stripComments);
    const iTable = stmts.findIndex((s) => /CREATE TABLE IF NOT EXISTS "luckyDraws"/i.test(s));
    const iDo = stmts.findIndex((s) => /notifiedAt/.test(s) && /^DO \$\$/i.test(s.trim()));
    expect(iTable).toBeGreaterThanOrEqual(0);
    expect(iDo).toBeGreaterThanOrEqual(0);
    expect(iDo).toBeGreaterThan(iTable);
  });

  it("通用依賴檢查：所有 ALTER/CREATE INDEX/INSERT/DO 引用嘅表都喺更早嘅位置建咗", () => {
    const stmts = buildMigrationStatements().map(stripComments);
    const createdAt = new Map<string, number>();
    stmts.forEach((s, i) => {
      const m = s.match(/CREATE TABLE IF NOT EXISTS "?(\w+)"?/i);
      if (m && !createdAt.has(m[1])) createdAt.set(m[1], i);
    });
    const offenders: string[] = [];
    stmts.forEach((s, i) => {
      const refs = new Set<string>();
      for (const m of s.matchAll(/ALTER TABLE "?(\w+)"?/gi)) refs.add(m[1]);
      for (const m of s.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON\s+"?(\w+)"?/gi)) refs.add(m[1]);
      for (const m of s.matchAll(/INSERT INTO "?(\w+)"?/gi)) refs.add(m[1]);
      for (const m of s.matchAll(/\bFROM "?(\w+)"?/gi)) refs.add(m[1]);
      for (const m of s.matchAll(/information_schema\.columns\s+WHERE table_name = '([^']+)'/gi)) refs.add(m[1]);
      for (const t of refs) {
        // 系統 catalog 唔係我哋建嘅表
        if (t === "information_schema" || t === "pg_constraint" || t === "pg_catalog") continue;
        const at = createdAt.get(t);
        if (at === undefined || at >= i) {
          offenders.push(`stmt#${i} 引用未建／遲建嘅表 "${t}": ${s.trim().slice(0, 80)}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("ensureDatabase 經 buildMigrationStatements() 順序跑，冇繞過嘅早期 ALTER TYPE", () => {
    // 函數體入面唔准再直接 await pool.query(`ALTER TYPE ...`)；ALTER TYPE 只可以住喺 POST_DDL_STATEMENTS
    const fnBody = SRC.slice(SRC.indexOf("export async function ensureDatabase"));
    expect(fnBody).toContain("buildMigrationStatements()");
    expect(fnBody).not.toMatch(/await pool\.query\(`ALTER TYPE/);
  });
});

describe("mock executor：fresh／existing／repeat", () => {
  it("fresh DB：全部語句順序執行零錯誤；role 有 supervisor；luckyDraws 有 notifiedAt", () => {
    const st = newMockState();
    expect(() => runMigration(st)).not.toThrow();
    expect([...st.types.get("role") ?? []].sort()).toEqual(["admin", "member", "staff", "supervisor"]);
    expect(st.tables.get("luckyDraws")?.has("notifiedAt")).toBe(true);
    // fresh 表空，backfill UPDATE 照跑（no-op）——標記有執行過
    expect(st.applied.filter((a) => a === "backfill:luckyDraws.notifiedAt")).toHaveLength(1);
  });

  it("existing 舊版 DB（冇 supervisor、冇 notifiedAt）：升級零錯誤，欄同 enum 值補返", () => {
    const st = newMockState();
    runMigration(st); // 先建立現代結構
    // 模擬舊版 DB：抽走 supervisor 同 notifiedAt（即 v2.2.57／三級制之前嘅庫）
    st.types.get("role")!.delete("supervisor");
    st.tables.get("luckyDraws")!.delete("notifiedAt");
    st.applied = [];
    expect(() => runMigration(st)).not.toThrow();
    expect(st.types.get("role")!.has("supervisor")).toBe(true);
    expect(st.tables.get("luckyDraws")!.has("notifiedAt")).toBe(true);
    // 第一次加欄 → backfill 跑咗一次（舊紀錄標已通知）
    expect(st.applied.filter((a) => a === "backfill:luckyDraws.notifiedAt")).toHaveLength(1);
  });

  it("repeat：重跑幂等——唔再 backfill、唔再加 enum、零錯誤", () => {
    const st = newMockState();
    runMigration(st);
    runMigration(st);
    const appliedAfterTwo = [...st.applied];
    expect(() => runMigration(st)).not.toThrow();
    expect(st.applied).toEqual(appliedAfterTwo); // 第三次完全冇新動作
    expect(st.applied.filter((a) => a === "backfill:luckyDraws.notifiedAt")).toHaveLength(1);
    expect(st.applied.filter((a) => a === "addvalue:role:supervisor")).toHaveLength(1);
  });
});

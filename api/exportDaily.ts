import type { Context } from "hono";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gte, lt, notInArray } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { orders, orderItems, products } from "@db/schema";
import { userFromAuthHeader, verifyToken } from "./auth";
import { readZipEntries, writeZipStore } from "./xlsxZip";

/**
 * GET /api/export/daily?date=YYYY-MM-DD
 * 每日營運數據導出（staff + admin）。auth 用 Authorization Bearer 或 ?token=
 * （<a download> 加唔到 header，所以兼容 query token）。
 *
 * 用 api/assets/ops-template.xlsx 做底，patch「資料填入」sheet（sheet9.xml）：
 * 模板本身預留咗第 2–1275 行空 data row（G 欄 =E-F、N 欄 VLOOKUP formula 已搭好），
 * 所以數據係**填落呢啲預留行**（保留 style 同 formula），多過 1274 條 line item
 * 先至喺 sentinel row（r=1048571）之前插新 row。
 * 每 order line item 一列：
 *   A 日期 = 商品 listedDate（Excel serial）｜B 場次 = 0｜C 產品 = SKU｜
 *   E 金額 = qty × (discountPrice ?? price)｜M 下單批次 = 第一批｜其餘欄留空
 * 排除 cancelled/rejected；冇數據照出（淨表頭模板）。
 */
const TEMPLATE_PATH = path.resolve(process.cwd(), "api/assets/ops-template.xlsx");
const SHEET_PATH = "xl/worksheets/sheet9.xml";
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30); // Excel serial day 0
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_DATA_ROWS = 1274; // 模板預留空行：row 2..1275

type ExportLine = { dateSerial: number; sku: string; amount: number };

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cellXml(ref: string, attrs: string, value: number | string): string {
  if (typeof value === "number") {
    return `<c r="${ref}"${attrs}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${attrs} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

/** 喺一段 row XML 入面 set 一個 cell（保留原有 style attr；cell 唔存在就插喺 N 欄前） */
function setCell(rowXml: string, rowNo: number, col: string, value: number | string): string {
  const ref = `${col}${rowNo}`;
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>.*?</c>)`);
  const m = rowXml.match(re);
  const attrs = (m?.[1] ?? "").replace(/ t="[^"]*"/, "");
  const cell = cellXml(ref, attrs, value);
  if (m) return rowXml.replace(re, cell);
  const anchor = `<c r="N${rowNo}"`;
  return rowXml.replace(anchor, cell + anchor);
}

function buildRow(rowNo: number, line: ExportLine): string {
  // 新插入嘅 row 冇預留 cell，直接砌完整 row（A/B/C/E/M，其餘欄留空即係唔寫）
  return (
    `<row r="${rowNo}">` +
    cellXml(`A${rowNo}`, "", line.dateSerial) +
    cellXml(`B${rowNo}`, "", 0) +
    cellXml(`C${rowNo}`, "", line.sku) +
    cellXml(`E${rowNo}`, "", line.amount) +
    cellXml(`M${rowNo}`, "", "第一批") +
    `</row>`
  );
}

export function patchSheet9(xml: string, lines: ExportLine[]): string {
  let out = xml;
  lines.forEach((line, i) => {
    const rowNo = i + 2; // row 1 係表頭
    if (rowNo - 2 < TEMPLATE_DATA_ROWS) {
      const rowRe = new RegExp(`<row r="${rowNo}"[^>]*>.*?</row>`);
      const m = out.match(rowRe);
      if (m && m.index !== undefined) {
        let rowXml = m[0];
        rowXml = setCell(rowXml, rowNo, "A", line.dateSerial);
        rowXml = setCell(rowXml, rowNo, "B", 0);
        rowXml = setCell(rowXml, rowNo, "C", line.sku);
        rowXml = setCell(rowXml, rowNo, "E", line.amount);
        rowXml = setCell(rowXml, rowNo, "M", "第一批");
        out = out.slice(0, m.index) + rowXml + out.slice(m.index + m[0].length);
        return;
      }
    }
    // 超出模板預留行 → 喺 sentinel row（r=1048571）前插新 row
    out = out.replace(`<row r="1048571"`, `${buildRow(rowNo, line)}<row r="1048571"`);
  });
  return out;
}

/**
 * 剝走模板嘅 pivot cache / pivot table parts：
 * 模板自帶嘅 pivotCacheRecords 有成 196MB（未壓縮），原裝檔案連 openpyxl
 * 都會 OOM 開唔到，所以導出時將成條 pivot 引用鏈清走（entries、content types、
 * workbook pivotCaches、workbook/worksheet rels、sheet 入面嘅 pivotSelection）。
 * 訂貨統計等 pivot sheet 會變返普通工作表，9 個 sheet 結構不變。
 */
export function stripPivotCaches(entries: Map<string, Buffer>): void {
  for (const name of [...entries.keys()]) {
    if (
      name.startsWith("xl/pivotCache/") ||
      name.startsWith("xl/pivotTables/") ||
      name === "xl/calcChain.xml"
    ) {
      entries.delete(name);
    }
  }
  const setText = (name: string, fn: (s: string) => string) => {
    const buf = entries.get(name);
    if (buf) entries.set(name, Buffer.from(fn(buf.toString("utf8")), "utf8"));
  };
  setText("[Content_Types].xml", (s) =>
    s
      .replace(/<Override[^>]*PartName="\/xl\/(?:pivotCache|pivotTables)\/[^"]*"[^>]*\/>/g, "")
      .replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, ""),
  );
  setText("xl/workbook.xml", (s) => s.replace(/<pivotCaches>.*?<\/pivotCaches>/s, ""));
  setText("xl/_rels/workbook.xml.rels", (s) =>
    s.replace(
      /<Relationship[^>]*relationships\/(?:pivotCacheDefinition|calcChain)"[^>]*\/>/g,
      "",
    ),
  );
  for (const name of [...entries.keys()]) {
    if (/^xl\/worksheets\/_rels\/.+\.rels$/.test(name)) {
      setText(name, (s) =>
        s.replace(/<Relationship[^>]*relationships\/pivotTable"[^>]*\/>/g, ""),
      );
    }
  }
  for (const name of [...entries.keys()]) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      setText(name, (s) =>
        s.includes("pivotSelection")
          ? s.replace(/<pivotSelection\b.*?<\/pivotSelection>/gs, "")
          : s,
      );
    }
  }
}

export async function buildDailyXlsx(date: string): Promise<Buffer> {
  const start = new Date(`${date}T00:00:00+08:00`); // HKT 日界
  const end = new Date(start.getTime() + DAY_MS);

  const db = getDb();
  const rows = await db
    .select({
      sku: orderItems.sku,
      quantity: orderItems.quantity,
      price: products.price,
      discountPrice: products.discountPrice,
      listedDate: products.listedDate,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(products, eq(orderItems.productId, products.id))
    .where(
      and(
        gte(orders.createdAt, start),
        lt(orders.createdAt, end),
        notInArray(orders.status, ["cancelled", "rejected"]),
      ),
    )
    .orderBy(asc(orders.id), asc(orderItems.id));

  const lines: ExportLine[] = rows.map((r) => ({
    dateSerial: Math.round((r.listedDate.getTime() - EXCEL_EPOCH_MS) / DAY_MS),
    sku: r.sku,
    amount: r.quantity * (r.discountPrice ?? r.price),
  }));

  const template = await readFile(TEMPLATE_PATH);
  const entries = readZipEntries(template);
  stripPivotCaches(entries);
  const sheet = entries.get(SHEET_PATH);
  if (!sheet) throw new Error(`template 入面搵唔到 ${SHEET_PATH}`);
  entries.set(SHEET_PATH, Buffer.from(patchSheet9(sheet.toString("utf8"), lines), "utf8"));
  return writeZipStore(entries);
}

export async function exportDaily(c: Context) {
  // auth：Authorization Bearer 優先，冇就用 ?token=（<a download> 加唔到 header）
  let user = await userFromAuthHeader(c.req.header("authorization"));
  if (!user) {
    const token = c.req.query("token");
    if (token) user = await verifyToken(token);
  }
  if (!user) return c.json({ error: "請先登入" }, 401);
  if (user.role !== "staff" && user.role !== "admin") {
    return c.json({ error: "需要管理員權限" }, 403);
  }

  const date = c.req.query("date") ?? "";
  const start = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00+08:00`)
    : null;
  if (!start || Number.isNaN(start.getTime())) {
    return c.json({ error: "日期格式要 YYYY-MM-DD（HKT）" }, 400);
  }

  const buf = await buildDailyXlsx(date);
  const filename = `RedCode-ops-${date}.xlsx`;
  const filenameStar = `RedCode-${encodeURIComponent("營運數據")}-${date}.xlsx`;
  // Hono c.body 要 Uint8Array<ArrayBuffer>；Buffer 係 ArrayBufferLike，copy 一份轉型
  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${filenameStar}`,
  });
}

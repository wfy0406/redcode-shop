/**
 * v2.5.6 抽獎 Excel 匯入／範本（零 dependency，用現有手寫 xlsxZip）
 * --------------------------------
 * 範本：buildTemplateXlsx 由零砌一個極簡 .xlsx（inlineStr，header only，唔放示例人名，
 *       免得誤匯入）；list 欄「姓名」、ticket 欄「姓名、抽獎劵數」。
 * 解析：parseXlsxRows 支援 sharedStrings（含富文本 <si><r><t> 多段）、inlineStr、
 *       數字 <v>；只支援本系統範本格式（xl/worksheets/sheet1.xml，第一個 sheet）。
 * 驗證：validateImportRows 逐行錯誤（錯欄／空名／非整數劵數／超上限／500+1 行）；
 *       planImport 處理重複（list 檔案內去重 skip；ticket duplicatePolicy=skip|merge，
 *       merge 加劵數，逐行報告，溢出檢查）。
 * 上限：原始檔 2MB（router 驗）、500 數據行、每劵數 1–10000、每活動總劵數 10,000,000（int32 安全）。
 * 純函數為主（掂 DB 嘅 existing map 由 caller 傳入），方便單元測試。
 */

import { readZipEntries, writeZipDeflate } from "./xlsxZip";
import { normalizeListName } from "./luckyDrawCore";

export type ImportKind = "list" | "ticket";
export type DuplicatePolicy = "skip" | "merge";

/** 原始 .xlsx 上限 2MB（base64 解碼後嘅 bytes） */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
/** 數據行上限（唔計 header）；第 501 行開始係錯誤 */
export const IMPORT_MAX_ROWS = 500;
/** 每人劵數 1–10000 */
export const MAX_TICKETS_PER_PERSON = 10000;
/** 每活動總劵數上限：遠低於 int32，加權 randomInt 同 merge 加法都唔會溢出 */
export const MAX_TOTAL_TICKETS = 10_000_000;
/** 名單姓名上限同 adminCreateList zod（max 64）一致；劵持有人同 DB 欄位 255 一致 */
export const LIST_NAME_MAX = 64;
export const HOLDER_NAME_MAX = 255;

/** 範本表頭（匯入時第一行必須完全一致，trim 後比） */
export function expectedHeaders(kind: ImportKind): string[] {
  return kind === "list" ? ["姓名"] : ["姓名", "抽獎劵數"];
}

// ───────────────────────── 範本生成 ─────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colLetter(idx: number): string {
  // 0 → A, 1 → B, …（範本最多兩欄，簡單實作夠用）
  return String.fromCharCode(65 + idx);
}

/** 由零砌極簡 .xlsx：Content_Types + rels + workbook + styles + sheet1（inlineStr，淨 header）。
 *  用 inlineStr 唔使 sharedStrings，檔案最細；Excel/LibreOffice/Google Sheets 都開到。 */
export function buildTemplateXlsx(kind: ImportKind): Buffer {
  const headers = expectedHeaders(kind);
  const cells = headers
    .map(
      (h, i) =>
        `<c r="${colLetter(i)}1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`,
    )
    .join("");
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData><row r="1">${cells}</row></sheetData></worksheet>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="匯入" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="1"><xf/></cellXfs></styleSheet>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const entries = new Map<string, Buffer>([
    ["[Content_Types].xml", Buffer.from(contentTypes, "utf8")],
    ["_rels/.rels", Buffer.from(rootRels, "utf8")],
    ["xl/workbook.xml", Buffer.from(workbook, "utf8")],
    ["xl/_rels/workbook.xml.rels", Buffer.from(workbookRels, "utf8")],
    ["xl/styles.xml", Buffer.from(styles, "utf8")],
    ["xl/worksheets/sheet1.xml", Buffer.from(sheet, "utf8")],
  ]);
  return writeZipDeflate(entries);
}

// ───────────────────────── 解析 ─────────────────────────

/** zip magic 檢查：PK\x03\x04（一般 zip）或 PK\x05\x06（空 zip，後面 readZipEntries 會再捉） */
export function hasPkMagic(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  return (buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** <si>…</si> 內所有 <t> 段串埋（富文本 <si><r><t>甲</t></r><r><t>乙</t></r></si> → 「甲乙」） */
function siText(siXml: string): string {
  let out = "";
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(siXml))) out += unescapeXml(m[1]);
  return out;
}

export type ParsedRow = { rowNo: number; cells: string[] };

function colIndex(ref: string): number {
  // "B12" → 1；只取開頭字母段
  let idx = 0;
  for (const ch of ref) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c < 65 || c > 90) break;
    idx = idx * 26 + (c - 64);
  }
  return idx - 1;
}

/** 解析 sheet1 全部行：cells 按欄位字母排（A=0）；空 cell 補 ""。
 *  壞 zip／搵唔到 sheet 會 throw（caller 包做檔案級錯誤）。
 *  安全：只解壓實際需要嘅兩個 entry（無關巨大 entry 完全唔解壓）；
 *  每 entry 8MB／總 16MB 解壓上限防 deflate bomb——真實上限內檔案
 *  （500 行 × 255 字姓名 + markup）唔使 1MB，8MB 已留 ~10× headroom；
 *  超出會 throw 明確錯誤，唔會靜默解析截斷 XML。 */
const XLSX_NEEDED_ENTRIES: ReadonlySet<string> = new Set([
  "xl/worksheets/sheet1.xml",
  "xl/sharedStrings.xml",
]);
export const XLSX_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const XLSX_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export function parseXlsxRows(buf: Buffer): ParsedRow[] {
  const entries = readZipEntries(buf, {
    only: XLSX_NEEDED_ENTRIES,
    maxEntryBytes: XLSX_MAX_ENTRY_BYTES,
    maxTotalBytes: XLSX_MAX_TOTAL_BYTES,
  });
  const sheetBuf = entries.get("xl/worksheets/sheet1.xml");
  if (!sheetBuf) throw new Error("搵唔到 xl/worksheets/sheet1.xml（只支援本系統範本格式）");
  const sheet = sheetBuf.toString("utf8");

  // sharedStrings 選填（inlineStr 範本冇）；逐個 <si> 抽文字
  const shared: string[] = [];
  const ssBuf = entries.get("xl/sharedStrings.xml");
  if (ssBuf) {
    const ss = ssBuf.toString("utf8");
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ss))) shared.push(siText(m[1]));
  }

  const rows: ParsedRow[] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm: RegExpExecArray | null;
  let seq = 0;
  while ((rm = rowRe.exec(sheet))) {
    seq += 1;
    const attrs = rm[1] ?? rm[3] ?? "";
    const inner = rm[2] ?? "";
    const rAttr = attrs.match(/\br="(\d+)"/);
    const rowNo = rAttr ? parseInt(rAttr[1], 10) : seq;
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    let cellSeq = 0;
    while ((cm = cellRe.exec(inner))) {
      const cAttrs = cm[1] ?? "";
      const cInner = cm[2] ?? "";
      const refM = cAttrs.match(/\br="([A-Za-z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : cellSeq;
      cellSeq = idx + 1;
      const tM = cAttrs.match(/\bt="([^"]+)"/);
      const t = tM?.[1] ?? "n";
      let value = "";
      if (t === "s") {
        const vM = cInner.match(/<v>([\s\S]*?)<\/v>/);
        const si = vM ? parseInt(vM[1], 10) : NaN;
        value = Number.isInteger(si) && si >= 0 && si < shared.length ? shared[si] : "";
      } else if (t === "inlineStr") {
        const isM = cInner.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
        value = isM ? siText(isM[1]) : "";
      } else {
        // 數字／str／b／e：直接用 <v> 原文（劵數驗證會再捉非整數）
        const vM = cInner.match(/<v>([\s\S]*?)<\/v>/);
        value = vM ? unescapeXml(vM[1]) : "";
      }
      while (cells.length < idx) cells.push("");
      cells[idx] = value;
    }
    rows.push({ rowNo, cells });
  }
  return rows;
}

// ───────────────────────── 驗證 ─────────────────────────

export type RowError = { row: number; field: string; message: string };
export type ValidRow = {
  rowNo: number;
  name: string;
  normalizedName: string;
  /** list 模式冇劵數欄，當 1 */
  ticketCount: number;
};

export type ValidateResult = { rows: ValidRow[]; errors: RowError[] };

/** 逐行驗證（唔寫 DB）：表頭錯 → 檔案級錯誤即刻返；數據行 trim／去空／限長／劵數整數範圍／
 *  總劵數溢出／500 行上限。全空行靜靜哋跳過（Excel 尾部成日有格式化空行）。 */
export function validateImportRows(kind: ImportKind, parsed: ParsedRow[]): ValidateResult {
  const errors: RowError[] = [];
  const rows: ValidRow[] = [];
  const headers = expectedHeaders(kind);
  const nameMax = kind === "list" ? LIST_NAME_MAX : HOLDER_NAME_MAX;

  if (parsed.length === 0) {
    return { rows, errors: [{ row: 1, field: "header", message: "檔案係空或者搵唔到表頭行" }] };
  }
  const head = parsed[0];
  for (let i = 0; i < headers.length; i++) {
    if ((head.cells[i] ?? "").trim() !== headers[i]) {
      return {
        rows,
        errors: [
          {
            row: 1,
            field: "header",
            message: `表頭唔啱：第 ${i + 1} 欄要係「${headers[i]}」（而家係「${(head.cells[i] ?? "").trim() || "空"}」）——請用系統範本`,
          },
        ],
      };
    }
  }

  let dataCount = 0;
  let totalTickets = 0;
  for (const r of parsed.slice(1)) {
    const rawName = (r.cells[0] ?? "").trim();
    const rawTickets = (r.cells[1] ?? "").trim();
    if (!rawName && !rawTickets) continue; // 全空行跳過
    dataCount += 1;
    if (dataCount > IMPORT_MAX_ROWS) {
      errors.push({
        row: r.rowNo,
        field: "rows",
        message: `最多 ${IMPORT_MAX_ROWS} 行數據（第 ${IMPORT_MAX_ROWS + 1} 行起唔受理）——請分拆檔案`,
      });
      break; // 唔再逐行報落去，一個錯已經夠阻 commit
    }
    if (!rawName) {
      errors.push({ row: r.rowNo, field: "姓名", message: "姓名唔准空" });
      continue;
    }
    if (rawName.length > nameMax) {
      errors.push({ row: r.rowNo, field: "姓名", message: `姓名太長（上限 ${nameMax} 字）` });
      continue;
    }
    let ticketCount = 1;
    if (kind === "ticket") {
      if (!/^\d+$/.test(rawTickets)) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `抽獎劵數要係正整數（而家係「${rawTickets || "空"}」）` });
        continue;
      }
      ticketCount = parseInt(rawTickets, 10);
      if (ticketCount < 1 || ticketCount > MAX_TICKETS_PER_PERSON) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `抽獎劵數要 1–${MAX_TICKETS_PER_PERSON}` });
        continue;
      }
      totalTickets += ticketCount;
      if (totalTickets > MAX_TOTAL_TICKETS) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `全檔總劵數超過上限 ${MAX_TOTAL_TICKETS}` });
        continue;
      }
    }
    rows.push({ rowNo: r.rowNo, name: rawName, normalizedName: normalizeListName(rawName), ticketCount });
  }
  return { rows, errors };
}

// ───────────────────────── 重複處理（preview/commit 共用）─────────────────────────

export type ExistingEntry = { id: number; holderName: string; ticketCount: number };
export type PlannedInsert = { name: string; normalizedName: string; ticketCount: number };
export type PlannedMerge = { entryId: number; holderName: string; addTickets: number };
export type DuplicateReport = { row: number; name: string; action: "skip" | "merge"; detail: string };

export type ImportPlan = {
  inserts: PlannedInsert[];
  merges: PlannedMerge[];
  duplicates: DuplicateReport[];
  errors: RowError[];
};

/** 重複處理計劃（純函數；existing 由 caller 喺 DB 讀，preview 都係咁做，保證 preview≡commit 結果）。
 *  list：檔案內同名（normalize 後）去重 skip，保留第一個原串；新名單唔會同 DB 撞（commit 開新 list），existing 傳空 Map。
 *  ticket：檔案內同名先按 policy 合併/skip；再同活動現有 entries 比——skip＝唔郁（逐行報告），
 *  merge＝加劵數（逐行報告；加完超每人/總數上限 → 逐行錯誤阻 commit）。 */
export function planImport(
  kind: ImportKind,
  rows: ValidRow[],
  existing: ReadonlyMap<string, ExistingEntry>,
  policy: DuplicatePolicy,
): ImportPlan {
  const inserts: PlannedInsert[] = [];
  const merges = new Map<number, PlannedMerge>();
  const duplicates: DuplicateReport[] = [];
  const errors: RowError[] = [];
  const plannedByName = new Map<string, PlannedInsert>();
  let mergedTicketTotal = 0;

  for (const r of rows) {
    const inFile = plannedByName.get(r.normalizedName);
    const inDb = existing.get(r.normalizedName);
    if (kind === "list") {
      // list：檔案內重複 → skip 去重（新名單，DB 冇得撞）
      if (inFile) {
        duplicates.push({ row: r.rowNo, name: r.name, action: "skip", detail: "檔案內重複姓名，已去重（保留第一個）" });
        continue;
      }
      const ins: PlannedInsert = { name: r.name, normalizedName: r.normalizedName, ticketCount: 1 };
      plannedByName.set(r.normalizedName, ins);
      inserts.push(ins);
      continue;
    }
    // ticket
    if (policy === "skip") {
      if (inFile) {
        duplicates.push({ row: r.rowNo, name: r.name, action: "skip", detail: "檔案內重複姓名，已略過" });
        continue;
      }
      if (inDb) {
        duplicates.push({ row: r.rowNo, name: r.name, action: "skip", detail: `活動已有「${inDb.holderName}」（${inDb.ticketCount} 張劵），已略過` });
        continue;
      }
      const ins: PlannedInsert = { name: r.name, normalizedName: r.normalizedName, ticketCount: r.ticketCount };
      plannedByName.set(r.normalizedName, ins);
      inserts.push(ins);
      continue;
    }
    // ticket + merge：檔案內同名疊加；DB 已有 → 加劵數
    if (inFile) {
      const after = inFile.ticketCount + r.ticketCount;
      if (after > MAX_TICKETS_PER_PERSON) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `合併後「${inFile.name}」共 ${after} 張，超過每人上限 ${MAX_TICKETS_PER_PERSON}` });
        continue;
      }
      inFile.ticketCount = after;
      duplicates.push({ row: r.rowNo, name: r.name, action: "merge", detail: `檔案內重複，劵數已加埋（共 ${after} 張）` });
      continue;
    }
    if (inDb) {
      const prev = merges.get(inDb.id);
      const alreadyAdded = prev?.addTickets ?? 0;
      const after = inDb.ticketCount + alreadyAdded + r.ticketCount;
      if (after > MAX_TICKETS_PER_PERSON) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `合併後「${inDb.holderName}」共 ${after} 張，超過每人上限 ${MAX_TICKETS_PER_PERSON}` });
        continue;
      }
      mergedTicketTotal += r.ticketCount;
      if (mergedTicketTotal > MAX_TOTAL_TICKETS) {
        errors.push({ row: r.rowNo, field: "抽獎劵數", message: `合併總劵數超過上限 ${MAX_TOTAL_TICKETS}` });
        continue;
      }
      if (prev) {
        prev.addTickets += r.ticketCount;
      } else {
        merges.set(inDb.id, { entryId: inDb.id, holderName: inDb.holderName, addTickets: r.ticketCount });
      }
      duplicates.push({ row: r.rowNo, name: r.name, action: "merge", detail: `活動已有「${inDb.holderName}」，劵數加 ${r.ticketCount}（變 ${after} 張）` });
      continue;
    }
    const ins: PlannedInsert = { name: r.name, normalizedName: r.normalizedName, ticketCount: r.ticketCount };
    plannedByName.set(r.normalizedName, ins);
    inserts.push(ins);
  }
  return { inserts, merges: [...merges.values()], duplicates, errors };
}

/**
 * xlsxZip 解壓安全測試（2026-10-24 hardening）——全部測試檔即場生成，零 binary fixture。
 * 覆蓋：round-trip 相容、範本可讀、每檔上限、總上限、高壓縮比炸彈（經 parseXlsxRows）、
 * 大小聲明與實際唔符、malformed record、path traversal、duplicate entry、
 * 無關巨大 entry 唔會被解壓、store（method 0）上限、multi-disk 拒絕。
 */
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ZIP_MAX_ENTRY_BYTES,
  ZIP_MAX_TOTAL_BYTES,
  crc32,
  readZipEntries,
  writeZipDeflate,
} from "./xlsxZip";
import { buildTemplateXlsx, parseXlsxRows } from "./luckyDrawXlsx";

// ── helpers ────────────────────────────────────────────────────

/** 砌一個 store（method 0，唔壓縮）格式嘅 zip——writeZipDeflate 只出 deflate，store 要手砌 */
function writeZipStored(entries: Map<string, Buffer>): Buffer {
  const chunks: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10); // method 0
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...centrals, eocd]);
}

/** 搵第 n 個 signature 嘅 offset（改 record 用） */
function findSig(buf: Buffer, sig: number, n = 0): number {
  let found = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === sig) {
      if (found === n) return i;
      found++;
    }
  }
  throw new Error("signature not found");
}

/** 高壓縮比 payload：唔同長度嘅大細（壓縮後極細） */
function bigZeros(mb: number): Buffer {
  return Buffer.alloc(mb * 1024 * 1024, 0x30);
}

/** 簡單合法 sheet1（header「姓名」+一行數據） */
const SIMPLE_SHEET = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>姓名</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>陳小明</t></is></c></row></sheetData></worksheet>`,
  "utf8",
);

// ── 相容性 ─────────────────────────────────────────────────────

describe("相容性（功能唔准受 hardening 影響）", () => {
  it("writeZipDeflate → readZipEntries round-trip，內容同順序保持", () => {
    const src = new Map<string, Buffer>([
      ["[Content_Types].xml", Buffer.from("<Types/>")],
      ["xl/workbook.xml", Buffer.from("<workbook/>")],
      ["xl/worksheets/sheet1.xml", SIMPLE_SHEET],
    ]);
    const out = readZipEntries(writeZipDeflate(src));
    expect([...out.keys()]).toEqual([...src.keys()]);
    for (const [k, v] of src) expect(out.get(k)!.equals(v)).toBe(true);
  });

  it("store（method 0）zip 照樣讀到", () => {
    const src = new Map([["a.txt", Buffer.from("hello store")]]);
    const out = readZipEntries(writeZipStored(src));
    expect(out.get("a.txt")!.toString()).toBe("hello store");
  });

  it("系統範本喺預設上限下讀得返（openpyxl 類結構：sharedStrings + 多 entry）", () => {
    // 模擬 openpyxl／Excel 產物：sharedStrings 引用 + docProps 等無關 entry
    const buf = writeZipDeflate(
      new Map<string, Buffer>([
        ["[Content_Types].xml", Buffer.from("<Types/>")],
        ["docProps/core.xml", Buffer.from("<core/>")],
        [
          "xl/sharedStrings.xml",
          Buffer.from(`<sst><si><t>姓名</t></si><si><t>陳小明</t></si></sst>`, "utf8"),
        ],
        [
          "xl/worksheets/sheet1.xml",
          Buffer.from(
            `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
              `<row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`,
            "utf8",
          ),
        ],
      ]),
    );
    const rows = parseXlsxRows(buf);
    expect(rows.map((r) => r.cells)).toEqual([["姓名"], ["陳小明"]]);
    // 官方範本都要過
    expect(parseXlsxRows(buildTemplateXlsx("list"))[0].cells).toEqual(["姓名"]);
  });
});

// ── 解壓上限 ───────────────────────────────────────────────────

describe("deflate bomb 防護", () => {
  it("超每檔上限 → throw 明確錯誤，唔會回傳截斷數據", () => {
    const buf = writeZipDeflate(new Map([["big.xml", bigZeros(1)]]));
    expect(() => readZipEntries(buf, { maxEntryBytes: 64 * 1024 })).toThrow(/超過每檔上限/);
  });

  it("預設每檔上限（32MB）都會截停更大嘅 bomb", () => {
    const buf = writeZipDeflate(new Map([["big.xml", bigZeros(ZIP_MAX_ENTRY_BYTES / 1024 / 1024 + 1)]]));
    expect(() => readZipEntries(buf)).toThrow(/超過每檔上限/);
  });

  it("store entry 超每檔上限 → throw（唔經 inflate）", () => {
    const buf = writeZipStored(new Map([["big.bin", bigZeros(1)]]));
    expect(() => readZipEntries(buf, { maxEntryBytes: 64 * 1024 })).toThrow(/超過每檔上限/);
  });

  it("逐檔唔超但夾埋超總上限 → throw", () => {
    const buf = writeZipDeflate(
      new Map<string, Buffer>([
        ["a.xml", bigZeros(1)],
        ["b.xml", bigZeros(1)],
      ]),
    );
    expect(() =>
      readZipEntries(buf, { maxEntryBytes: 2 * 1024 * 1024, maxTotalBytes: 1536 * 1024 }),
    ).toThrow(/總解壓大小超過上限/);
  });

  it("高壓縮比炸彈經 parseXlsxRows：壓縮得幾 KB、解壓 9MB+ → throw 上限錯誤（唔會靜默 parse 截斷 XML）", () => {
    // 超過 XLSX_MAX_ENTRY_BYTES（8MB）嘅 sheet，壓縮後得幾十 KB——典型 bomb 形狀
    const row = `<row r="1"><c r="A1" t="inlineStr"><is><t>陳小明陳小明陳小明</t></is></c></row>`;
    const sheetBody = row.repeat(Math.ceil((9 * 1024 * 1024) / row.length));
    const buf = writeZipDeflate(
      new Map([
        ["xl/worksheets/sheet1.xml", Buffer.from(`<worksheet><sheetData>${sheetBody}</sheetData></worksheet>`, "utf8")],
      ]),
    );
    expect(buf.length).toBeLessThan(1024 * 1024); // 確認真係高壓縮比
    expect(() => parseXlsxRows(buf)).toThrow(/超過每檔上限/);
  });

  it("無關巨大 entry 唔會被解壓：parseXlsxRows 只掂 sheet1/sharedStrings", () => {
    // 40MB bomb 藏喺無關 entry——超晒每檔同總上限；只要唔解壓佢就冇影響
    const buf = writeZipDeflate(
      new Map<string, Buffer>([
        ["xl/worksheets/sheet1.xml", SIMPLE_SHEET],
        ["xl/media/huge.png", bigZeros(40)],
      ]),
    );
    const rows = parseXlsxRows(buf);
    expect(rows.map((r) => r.cells)).toEqual([["姓名"], ["陳小明"]]);
    // readZipEntries 層面：only 過濾後結果唔包無關 entry
    const picked = readZipEntries(buf, { only: new Set(["xl/worksheets/sheet1.xml"]) });
    expect([...picked.keys()]).toEqual(["xl/worksheets/sheet1.xml"]);
  });
});

// ── 畸形／惡意 record fail-closed ──────────────────────────────

describe("malformed zip fail-closed", () => {
  it("central header 聲稱大小同實際唔符 → throw", () => {
    const buf = Buffer.from(writeZipDeflate(new Map([["a.xml", Buffer.from("hello")]])) );
    const cen = findSig(buf, 0x02014b50);
    buf.writeUInt32LE(999, cen + 24); // 改 uncompSize
    expect(() => readZipEntries(buf)).toThrow(/唔符/);
  });

  it("截斷檔案（data 唔夠位） → throw invalid zip", () => {
    const full = writeZipDeflate(new Map([["a.xml", Buffer.from("x".repeat(5000))]]));
    const truncated = full.subarray(0, full.length - 40); // 咬走 EOCD
    expect(() => readZipEntries(Buffer.from(truncated))).toThrow(/invalid zip/);
  });

  it("central directory signature 損毀 → throw invalid zip", () => {
    const buf = Buffer.from(writeZipDeflate(new Map([["a.xml", Buffer.from("hi")]])) );
    const cen = findSig(buf, 0x02014b50);
    buf.writeUInt32LE(0xdeadbeef, cen);
    expect(() => readZipEntries(buf)).toThrow(/corrupt central directory/);
  });

  it("local header offset 指出界 → throw invalid zip", () => {
    const buf = Buffer.from(writeZipDeflate(new Map([["a.xml", Buffer.from("hi")]])) );
    const cen = findSig(buf, 0x02014b50);
    buf.writeUInt32LE(buf.length + 1000, cen + 42); // local header offset 出界
    expect(() => readZipEntries(buf)).toThrow(/bad local header/);
  });

  it("path traversal（../ 同絕對路徑）→ throw unsafe entry path", () => {
    for (const evil of ["../evil.xml", "..\\evil.xml", "/etc/passwd", "C:/win.ini", "a/../../b"]) {
      const buf = writeZipDeflate(new Map([[evil, Buffer.from("x")]]));
      expect(() => readZipEntries(buf), evil).toThrow(/unsafe entry path/);
    }
  });

  it("duplicate entry 名 → throw（fail-closed，唔會靜默覆蓋）", () => {
    // writeZipDeflate 用 Map 整唔到同名——砌完之後將第二個 entry 改名撞第一個
    const buf = Buffer.from(
      writeZipDeflate(
        new Map<string, Buffer>([
          ["dupA.xml", Buffer.from("first")],
          ["dupB.xml", Buffer.from("second")],
        ]),
      ),
    );
    const from = Buffer.from("dupB.xml");
    let idx = buf.indexOf(from);
    while (idx !== -1) {
      Buffer.from("dupA.xml").copy(buf, idx);
      idx = buf.indexOf(from, idx + 1);
    }
    expect(() => readZipEntries(buf)).toThrow(/duplicate entry/);
  });

  it("multi-disk EOCD → throw（唔支援就 fail-closed）", () => {
    const buf = Buffer.from(writeZipDeflate(new Map([["a.xml", Buffer.from("hi")]])) );
    const eocd = findSig(buf, 0x06054b50);
    buf.writeUInt16LE(1, eocd + 4); // disk number = 1
    expect(() => readZipEntries(buf)).toThrow(/multi-disk/);
  });

  it(" unsupported compression method → throw", () => {
    const buf = Buffer.from(writeZipDeflate(new Map([["a.xml", Buffer.from("hi")]])) );
    const cen = findSig(buf, 0x02014b50);
    const loc = findSig(buf, 0x04034b50);
    buf.writeUInt16LE(99, cen + 10);
    buf.writeUInt16LE(99, loc + 8);
    expect(() => readZipEntries(buf)).toThrow(/unsupported zip compression method/);
  });
});

// ── 上限常數 sanity ────────────────────────────────────────────

describe("上限常數", () => {
  it("預設上限：每檔 32MB、總 64MB", () => {
    expect(ZIP_MAX_ENTRY_BYTES).toBe(32 * 1024 * 1024);
    expect(ZIP_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
  });

  it("deflateRawSync 產物可以被 maxOutputLength 截停（測試前提 sanity check）", () => {
    const comp = deflateRawSync(bigZeros(1));
    expect(comp.length).toBeLessThan(64 * 1024);
  });
});

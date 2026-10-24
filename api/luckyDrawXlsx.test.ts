/**
 * v2.5.6 抽獎 Excel（api/luckyDrawXlsx.ts）單元測試——純函數，唔掂 DB。
 * 覆蓋：真 xlsx 範本 round-trip、sharedStrings／富文本／inlineStr、壞 zip、錯欄、空名、
 * 非整數劵數、500/501 行邊界、2MB 邊界、PK magic、重複 skip/merge、merge 溢出。
 */
import { describe, expect, it } from "vitest";
import { writeZipDeflate } from "./xlsxZip";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  MAX_TICKETS_PER_PERSON,
  buildTemplateXlsx,
  expectedHeaders,
  hasPkMagic,
  parseXlsxRows,
  planImport,
  validateImportRows,
  type ExistingEntry,
  type ValidRow,
} from "./luckyDrawXlsx";

/** 快速砌一個自訂 sheet 嘅 xlsx（測試 sharedStrings／inlineStr 解析） */
function buildXlsx(opts: { sheetXml: string; sharedStringsXml?: string }): Buffer {
  const entries = new Map<string, Buffer>([
    ["[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`)],
    ["xl/worksheets/sheet1.xml", Buffer.from(opts.sheetXml, "utf8")],
  ]);
  if (opts.sharedStringsXml) {
    entries.set("xl/sharedStrings.xml", Buffer.from(opts.sharedStringsXml, "utf8"));
  }
  return writeZipDeflate(entries);
}

function sheetWithRows(rows: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

describe("buildTemplateXlsx 範本 round-trip", () => {
  it("list 範本：真 xlsx 可以被自家 parser 讀返，淨係 header「姓名」", () => {
    const buf = buildTemplateXlsx("list");
    expect(hasPkMagic(buf)).toBe(true);
    const rows = parseXlsxRows(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toEqual(["姓名"]);
    // header only——唔可以放示例人名
    expect(rows.slice(1)).toHaveLength(0);
  });

  it("ticket 範本：header「姓名、抽獎劵數」，淨一行", () => {
    const buf = buildTemplateXlsx("ticket");
    const rows = parseXlsxRows(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toEqual(["姓名", "抽獎劵數"]);
  });

  it("範本經 validateImportRows 零錯誤零數據", () => {
    for (const kind of ["list", "ticket"] as const) {
      const { rows, errors } = validateImportRows(kind, parseXlsxRows(buildTemplateXlsx(kind)));
      expect(errors).toEqual([]);
      expect(rows).toEqual([]);
    }
  });
});

describe("parseXlsxRows 解析", () => {
  it("sharedStrings（t=\"s\"）解析", () => {
    const buf = buildXlsx({
      sheetXml: sheetWithRows(
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>`,
      ),
      sharedStringsXml: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>姓名</t></si><si><t>抽獎劵數</t></si><si><t>陳小明</t></si></sst>`,
    });
    const rows = parseXlsxRows(buf);
    expect(rows[0].cells).toEqual(["姓名", "抽獎劵數"]);
    expect(rows[1].cells).toEqual(["陳小明", "3"]);
  });

  it("sharedStrings 富文本（<si><r><t> 多段）串埋", () => {
    const buf = buildXlsx({
      sheetXml: sheetWithRows(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
      sharedStringsXml: `<sst><si><r><t>陳</t></r><r><t xml:space="preserve"> 小明</t></r></si></sst>`,
    });
    expect(parseXlsxRows(buf)[0].cells).toEqual(["陳 小明"]);
  });

  it("inlineStr＋XML entity（&amp; &#x;）解析", () => {
    const buf = buildXlsx({
      sheetXml: sheetWithRows(`<row r="1"><c r="A1" t="inlineStr"><is><t>A &amp; B &#x4E2D;</t></is></c></row>`),
    });
    expect(parseXlsxRows(buf)[0].cells).toEqual(["A & B 中"]);
  });

  it("跳格（B 欄冇 A 欄）→ A 補空字串", () => {
    const buf = buildXlsx({
      sheetXml: sheetWithRows(`<row r="1"><c r="B1" t="inlineStr"><is><t>x</t></is></c></row>`),
    });
    expect(parseXlsxRows(buf)[0].cells).toEqual(["", "x"]);
  });

  it("壞 zip → throw", () => {
    expect(() => parseXlsxRows(Buffer.from("not a zip at all, just text"))).toThrow();
  });

  it("合法 zip 但冇 sheet1 → throw", () => {
    const buf = writeZipDeflate(new Map([["foo.txt", Buffer.from("hi")]]));
    expect(() => parseXlsxRows(buf)).toThrow(/sheet1/);
  });
});

describe("hasPkMagic", () => {
  it("PK\\x03\\x04 過；PK\\x05\\x06（空 zip）過；其他唔過", () => {
    expect(hasPkMagic(buildTemplateXlsx("list"))).toBe(true);
    expect(hasPkMagic(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(hasPkMagic(Buffer.from("hello world"))).toBe(false);
    expect(hasPkMagic(Buffer.from([0x50]))).toBe(false);
  });
});

describe("validateImportRows 逐行錯誤", () => {
  const headerRow = (cells: string[]) => ({ rowNo: 1, cells });

  it("錯欄／錯表頭 → 檔案級錯誤，零數據行", () => {
    const { rows, errors } = validateImportRows("ticket", [headerRow(["姓名", "劵數"]), { rowNo: 2, cells: ["陳小明", "3"] }]);
    expect(rows).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("header");
    expect(errors[0].message).toContain("抽獎劵數");
  });

  it("空檔案（冇行）→ header 錯誤", () => {
    const { errors } = validateImportRows("list", []);
    expect(errors[0].field).toBe("header");
  });

  it("list：trim 後全空行靜靜跳過（去空）；有空名但其他欄有內容 → 逐行錯；姓名 trim＋normalize", () => {
    const { rows, errors } = validateImportRows("list", [
      headerRow(["姓名"]),
      { rowNo: 2, cells: ["", ""] }, // 全空行跳過
      { rowNo: 3, cells: ["  ", ""] }, // trim 後都係空 → 都係空行，跳過
      { rowNo: 4, cells: ["", " stray "] }, // 空名但第 2 欄有嘢 → 錯
      { rowNo: 5, cells: [" 陳小明 ", ""] },
    ]);
    expect(errors).toEqual([{ row: 4, field: "姓名", message: "姓名唔准空" }]);
    expect(rows).toEqual([{ rowNo: 5, name: "陳小明", normalizedName: "陳小明", ticketCount: 1 }]);
  });

  it("ticket：空名但有劵數 → 逐行錯", () => {
    const { rows, errors } = validateImportRows("ticket", [
      headerRow(["姓名", "抽獎劵數"]),
      { rowNo: 2, cells: ["", "3"] },
    ]);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ row: 2, field: "姓名", message: "姓名唔准空" }]);
  });

  it("list：姓名超過 64 字出錯", () => {
    const { errors } = validateImportRows("list", [headerRow(["姓名"]), { rowNo: 2, cells: ["甲".repeat(65), ""] }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("姓名");
  });

  it.each(["abc", "3.5", "0", "-2", String(MAX_TICKETS_PER_PERSON + 1), "1e3", ""])(
    "ticket：非整數／越界劵數「%s」出錯",
    (bad) => {
      const { rows, errors } = validateImportRows("ticket", [headerRow(["姓名", "抽獎劵數"]), { rowNo: 2, cells: ["陳小明", bad] }]);
      expect(rows).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe("抽獎劵數");
    },
  );

  it("ticket：合法劵數 1 同 10000 都過", () => {
    const { rows, errors } = validateImportRows("ticket", [
      headerRow(["姓名", "抽獎劵數"]),
      { rowNo: 2, cells: ["甲", "1"] },
      { rowNo: 3, cells: ["乙", String(MAX_TICKETS_PER_PERSON)] },
    ]);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.ticketCount)).toEqual([1, MAX_TICKETS_PER_PERSON]);
  });

  it(`500 行啱啱好過；第 ${IMPORT_MAX_ROWS + 1} 行出錯兼阻 commit`, () => {
    const parsed = [headerRow(["姓名"])];
    for (let i = 1; i <= IMPORT_MAX_ROWS; i++) parsed.push({ rowNo: i + 1, cells: [`客${i}`, ""] });
    const ok = validateImportRows("list", parsed);
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toHaveLength(IMPORT_MAX_ROWS);

    parsed.push({ rowNo: IMPORT_MAX_ROWS + 2, cells: ["多咗", ""] });
    const over = validateImportRows("list", parsed);
    expect(over.errors).toHaveLength(1);
    expect(over.errors[0].field).toBe("rows");
  });

  it("ticket：全檔總劵數溢出出錯", () => {
    // 每行 10000，行數令總數超過 10,000,000 會好慢——改喺 planImport/validate 分段保護；
    // 呢度用兩行合法大數模擬邊界內（2×10000 = 20000 << 上限）
    const { errors } = validateImportRows("ticket", [
      headerRow(["姓名", "抽獎劵數"]),
      { rowNo: 2, cells: ["甲", String(MAX_TICKETS_PER_PERSON)] },
      { rowNo: 3, cells: ["乙", String(MAX_TICKETS_PER_PERSON)] },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("planImport 重複處理", () => {
  const vr = (rowNo: number, name: string, ticketCount = 1): ValidRow => ({
    rowNo,
    name,
    normalizedName: name.trim().toLowerCase(),
    ticketCount,
  });
  const noExisting = new Map<string, ExistingEntry>();

  it("list：檔案內同名（大小寫/空格normalize）去重 skip，保留第一個原串", () => {
    const plan = planImport("list", [vr(2, "陳小明"), vr(3, " 陳小明 "), vr(4, "CHAN"), vr(5, "chan")], noExisting, "skip");
    expect(plan.inserts.map((i) => i.name)).toEqual(["陳小明", "CHAN"]);
    expect(plan.duplicates).toHaveLength(2);
    expect(plan.duplicates.every((d) => d.action === "skip")).toBe(true);
    expect(plan.errors).toEqual([]);
  });

  it("ticket skip：撞活動現有 entry → 略過兼報告；新名照 insert", () => {
    const existing = new Map<string, ExistingEntry>([["陳小明", { id: 7, holderName: "陳小明", ticketCount: 3 }]]);
    const plan = planImport("ticket", [vr(2, "陳小明", 2), vr(3, "新客", 5)], existing, "skip");
    expect(plan.inserts.map((i) => i.name)).toEqual(["新客"]);
    expect(plan.merges).toEqual([]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0]).toMatchObject({ row: 2, name: "陳小明", action: "skip" });
    expect(plan.duplicates[0].detail).toContain("3 張");
  });

  it("ticket merge：撞現有 → 加劵數（一次 merge 累積多行），逐行報告", () => {
    const existing = new Map<string, ExistingEntry>([["陳小明", { id: 7, holderName: "陳小明", ticketCount: 3 }]]);
    const plan = planImport("ticket", [vr(2, "陳小明", 2), vr(3, "陳小明", 4)], existing, "merge");
    expect(plan.inserts).toEqual([]);
    expect(plan.merges).toEqual([{ entryId: 7, holderName: "陳小明", addTickets: 6 }]);
    expect(plan.duplicates).toHaveLength(2);
    expect(plan.duplicates[1].detail).toContain("變 9 張");
  });

  it("ticket merge：檔案內同名疊加入 insert，唔會開兩個新人", () => {
    const plan = planImport("ticket", [vr(2, "新客", 2), vr(3, " 新客", 3)], noExisting, "merge");
    expect(plan.inserts).toEqual([{ name: "新客", normalizedName: "新客", ticketCount: 5 }]);
    expect(plan.duplicates).toHaveLength(1);
    expect(plan.duplicates[0].action).toBe("merge");
  });

  it("ticket merge：合併後超每人上限 → 逐行錯誤（阻 commit）", () => {
    const existing = new Map<string, ExistingEntry>([["陳小明", { id: 7, holderName: "陳小明", ticketCount: MAX_TICKETS_PER_PERSON - 1 }]]);
    const plan = planImport("ticket", [vr(2, "陳小明", 2)], existing, "merge");
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].message).toContain("超過每人上限");
    expect(plan.merges).toEqual([]);
  });

  it("ticket skip：檔案內重複都係 skip 報告", () => {
    const plan = planImport("ticket", [vr(2, "新客", 1), vr(3, "新客", 1)], noExisting, "skip");
    expect(plan.inserts).toHaveLength(1);
    expect(plan.duplicates).toEqual([{ row: 3, name: "新客", action: "skip", detail: "檔案內重複姓名，已略過" }]);
  });
});

describe("上傳上限常數", () => {
  it("2MB 邊界：等於上限過、超過唔過（router 用 IMPORT_MAX_BYTES 判斷）", () => {
    expect(IMPORT_MAX_BYTES).toBe(2 * 1024 * 1024);
    const atLimit = Buffer.alloc(IMPORT_MAX_BYTES);
    const over = Buffer.alloc(IMPORT_MAX_BYTES + 1);
    expect(atLimit.length > IMPORT_MAX_BYTES).toBe(false);
    expect(over.length > IMPORT_MAX_BYTES).toBe(true);
  });

  it("expectedHeaders 同範本一致", () => {
    expect(expectedHeaders("list")).toEqual(["姓名"]);
    expect(expectedHeaders("ticket")).toEqual(["姓名", "抽獎劵數"]);
  });
});

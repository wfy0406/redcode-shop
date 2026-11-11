/**
 * AI 內容（WMS 推送合約 v2）純邏輯測試——**唔掂真 DB**。
 *
 * 覆蓋：
 * 1) approved 閘：帶 description／aiTags 就一定要 aiContentApproved===true＋reviewedBy 非空；
 *    未帶呢三件嘅舊批完全放行（向後相容）。
 * 2) 內容清理：NFC＋控制字元；唔做 HTML escape（& < > 原文入 DB）。
 * 3) 長度閘：描述 ≤500、tags ≤5 個每個 ≤12；超長／壞 tag 拒絕，空字串／空 array 合法。
 * 4) 公開 DTO：aiTagsEnabled=false 永遠 []；壞 JSON 當冇。
 * 5) disable 權限：products.disableAiTags 綁 supervisorProcedure（員工 staff 過唔到），
 *    而且冇任何 enable API（源碼級驗證，同 wmsListing suite 一個做法）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_DESCRIPTION_MAX,
  AI_TAG_MAX_COUNT,
  AI_TAG_MAX_LEN,
  aiContentGateError,
  aiTagsToJson,
  itemCarriesAiContent,
  parseAiTags,
  publicAiTags,
  sanitizeAiDescription,
  sanitizeAiTag,
  validateAiDescription,
  validateAiTags,
} from "./productAiContent";

describe("AI 內容清理（NFC／控制字元；唔做 HTML escape）", () => {
  it("NFC：分解嘅 é 會組合返；控制字元剝走；& < > 原文保留", () => {
    expect(sanitizeAiDescription("café 靚衫")).toBe("café 靚衫");
    expect(sanitizeAiDescription("A & <B>")).toBe("A & <B>"); // 唔准 HTML escape 入 DB
    expect(sanitizeAiDescription("  前後空白  ")).toBe("前後空白");
    // 描述保留換行／tab，其餘 C0 剝走
    expect(sanitizeAiDescription("第一行\n第二行\t齊")).toBe("第一行\n第二行\t齊");
  });

  it("tag 清理更嚴：換行都剝走", () => {
    expect(sanitizeAiTag(" 直播\n熱賣 ")).toBe("直播熱賣");
  });
});

describe("validateAiDescription", () => {
  it("空字串合法（清 AI 描述用）；500 字啱啱好；501 拒絕", () => {
    expect(validateAiDescription("")).toBeNull();
    expect(validateAiDescription("字".repeat(AI_DESCRIPTION_MAX))).toBeNull();
    expect(validateAiDescription("字".repeat(AI_DESCRIPTION_MAX + 1))).toContain("最長");
  });

  it("非字串拒絕；長度按清理後計", () => {
    expect(validateAiDescription(123)).toContain("字串");
    expect(validateAiDescription(undefined)).toContain("字串");
    // 控制字元唔計長度
    expect(validateAiDescription(`${"字".repeat(AI_DESCRIPTION_MAX)}`)).toBeNull();
  });
});

describe("validateAiTags", () => {
  it("空 array 合法；5 個上限；第 6 個拒絕", () => {
    expect(validateAiTags([])).toBeNull();
    expect(validateAiTags(Array.from({ length: AI_TAG_MAX_COUNT }, (_, i) => `tag${i}`))).toBeNull();
    expect(validateAiTags(Array.from({ length: AI_TAG_MAX_COUNT + 1 }, (_, i) => `tag${i}`))).toContain("最多");
  });

  it("每個 ≤12 字（清理後計）；超長拒絕", () => {
    expect(validateAiTags(["標".repeat(AI_TAG_MAX_LEN)])).toBeNull();
    expect(validateAiTags(["標".repeat(AI_TAG_MAX_LEN + 1)])).toContain("最長");
  });

  it("壞 tag 拒絕：非 array／非字串／清理後變空", () => {
    expect(validateAiTags("直播")).toContain("array");
    expect(validateAiTags([123])).toContain("字串");
    expect(validateAiTags([""])).toContain("空");
    expect(validateAiTags([""])).toContain("空");
    expect(validateAiTags(["   "])).toContain("空");
  });
});

describe("aiContentGateError — approved 閘", () => {
  const approvedItem = { description: "靚衫", aiContentApproved: true };

  it("帶 description／aiTags 但冇批准 → 拒絕", () => {
    expect(aiContentGateError({ description: "x" }, "主管")).toContain("aiContentApproved");
    expect(aiContentGateError({ description: "x", aiContentApproved: false }, "主管")).toContain("aiContentApproved");
    expect(aiContentGateError({ aiTags: [] }, "主管")).toContain("aiContentApproved");
  });

  it("空字串 description／空 array aiTags 都當「帶咗」— 一樣要批准", () => {
    expect(itemCarriesAiContent({ description: "" })).toBe(true);
    expect(itemCarriesAiContent({ aiTags: [] })).toBe(true);
    expect(aiContentGateError({ description: "" }, "主管")).toContain("aiContentApproved");
  });

  it("批准咗但批次冇 reviewedBy → 拒絕", () => {
    expect(aiContentGateError(approvedItem, undefined)).toContain("reviewedBy");
    expect(aiContentGateError(approvedItem, "")).toContain("reviewedBy");
    expect(aiContentGateError(approvedItem, "   ")).toContain("reviewedBy");
  });

  it("批准＋審批人齊 → 放行；舊批冇 AI 欄 → 完全放行（向後相容）", () => {
    expect(aiContentGateError(approvedItem, "主管")).toBeNull();
    expect(aiContentGateError({}, undefined)).toBeNull();
    expect(aiContentGateError({ aiContentApproved: false }, undefined)).toBeNull();
  });
});

describe("aiTagsToJson／parseAiTags／publicAiTags", () => {
  it("寫庫前清理＋JSON 化；parse 還原", () => {
    const json = aiTagsToJson([" 直播熱賣 ", "新品"]);
    expect(json).toBe('["直播熱賣","新品"]');
    expect(parseAiTags(json)).toEqual(["直播熱賣", "新品"]);
  });

  it("壞 JSON／非 array／壞 tag → []，唔會 throw", () => {
    expect(parseAiTags("唔係 JSON")).toEqual([]);
    expect(parseAiTags('"字串"')).toEqual([]);
    expect(parseAiTags(null)).toEqual([]);
    expect(parseAiTags(undefined)).toEqual([]);
    expect(parseAiTags('["ok",123,"","超長超長超長超長超長超長嘅標籤"]')).toEqual(["ok"]);
  });

  it("公開 DTO：enabled=true 先出 tags；disabled 內容存在都回 []", () => {
    const raw = '["直播熱賣","新品"]';
    expect(publicAiTags(raw, true)).toEqual(["直播熱賣", "新品"]);
    expect(publicAiTags(raw, false)).toEqual([]);
    expect(publicAiTags(null, true)).toEqual([]);
  });
});

describe("products.disableAiTags 權限同合約（源碼級）", () => {
  const SRC = readFileSync(new URL("./productsRouter.ts", import.meta.url), "utf8");

  it("disableAiTags 綁 supervisorProcedure（員工 staff 唔可以調用）", () => {
    expect(SRC).toContain("disableAiTags: supervisorProcedure");
  });

  it("淨係閂開關：update 淨 set aiTagsEnabled=false；冇任何 enable API", () => {
    expect(SRC).toContain(".set({ aiTagsEnabled: false })");
    expect(SRC).not.toContain("enableAiTags");
    expect(SRC).not.toContain("aiTagsEnabled: true");
  });

  it("audit 寫 actor／action／target／count", () => {
    expect(SRC).toContain('action: "product.disableAiTags"');
    expect(SRC).toContain("actorId: ctx.user.userId");
    expect(SRC).toContain("targetType: \"product\"");
    expect(SRC).toContain("updated.length");
  });

  it("公開查詢唔會漏內部 enabled flag：byId 經 publicProductRow 剝走 raw/enabled", () => {
    expect(SRC).toContain("return publicProductRow(product);");
    // byId 唔准再直接 dump 整列
    expect(SRC).not.toMatch(/byId[\s\S]{0,600}return product;/);
  });
});

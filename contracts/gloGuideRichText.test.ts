import { describe, expect, it } from "vitest";
import {
  gloGuideHeadingText,
  gloGuideRichTextPlain,
  parseGloGuideRichText,
  renderGloGuideBodyHtml,
  renderGloGuideInlineHtml,
  wrapGloGuideSelection,
} from "./gloGuideRichText";

describe("gloGuideRichText", () => {
  it("舊純文字完全不變", () => {
    const body = "今日返工咁襯。\n\n第二段照樣係純文字 <script>alert(1)</script>。";
    expect(parseGloGuideRichText(body)).toMatchObject({ plainText: body, error: null, highlights: [] });
    expect(gloGuideRichTextPlain(body)).toBe(body);
  });

  it("粗體、顏色、重點標籤可巢狀，markup 唔入 plain text", () => {
    const parsed = parseGloGuideRichText("呢件[b][gold]粉色外套[/gold][/b]襯[tag]返工必備[/tag]。");
    expect(parsed.error).toBeNull();
    expect(parsed.plainText).toBe("呢件粉色外套襯返工必備。");
    expect(parsed.highlights).toEqual(["返工必備"]);
    expect(parsed.segments).toContainEqual({ text: "粉色外套", bold: true, color: "gold", tag: false });
  });

  it("HTML／event handler 永遠 escape，唔會變可執行 markup", () => {
    const html = renderGloGuideInlineHtml('[b]<img src=x onerror="alert(1)">[/b]');
    expect(html).toBe("<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</strong>");
    expect(html).not.toContain("<img");
  });

  it("輸出只產生 whitelist HTML", () => {
    expect(renderGloGuideInlineHtml("[gold]金色[/gold] [pink]粉色[/pink] [tag]重點[/tag]")).toBe(
      '<span class="gg-text-gold">金色</span> <span class="gg-text-pink">粉色</span> <mark class="gg-key-tag">重點</mark>',
    );
  });

  it("body renderer 保留段落及安全重點", () => {
    expect(renderGloGuideBodyHtml("第一段[tag]重點[/tag]\n\n第二段[b]粗體[/b]")).toBe(
      '<p>第一段<mark class="gg-key-tag">重點</mark></p><p>第二段<strong>粗體</strong></p>',
    );
  });

  it("副標題輸出真正 h2，標記唔入純文字，HTML 照樣 escape", () => {
    const body = "開頭答案。\n\n[h2]返工 <點襯>[/h2]\n第二段[b]重點[/b]";
    expect(gloGuideHeadingText("[h2]返工點襯[/h2]")).toBe("返工點襯");
    expect(gloGuideHeadingText("前半[h2]返工[/h2]")).toBeNull();
    expect(gloGuideHeadingText("[h2][b]返工[/b][/h2]")).toBeNull();
    expect(gloGuideRichTextPlain(body)).toBe("開頭答案。\n\n返工 <點襯>\n第二段重點");
    expect(renderGloGuideBodyHtml(body)).toBe(
      "<p>開頭答案。</p><h2>返工 &lt;點襯&gt;</h2><p>第二段<strong>重點</strong></p>",
    );
  });

  it.each([
    ["[b]未閉合", "未閉合"],
    ["[b]交叉[gold]標記[/b][/gold]", "不對稱"],
    ["[tag]跨行\n標籤[/tag]", "唔可以跨段落"],
  ])("malformed markup 有明確錯誤：%s", (body, message) => {
    expect(parseGloGuideRichText(body).error).toContain(message);
  });

  it("未知 tag 保留做文字，唔會靜默刪內容", () => {
    expect(parseGloGuideRichText("[url]https://example.com[/url]").plainText).toBe(
      "[url]https://example.com[/url]",
    );
  });

  it("toolbar 只包已選單行文字", () => {
    expect(wrapGloGuideSelection("今日咁襯", 2, 4, "tag")).toEqual({
      value: "今日[tag]咁襯[/tag]",
      selectionStart: 7,
      selectionEnd: 9,
    });
    expect(wrapGloGuideSelection("第一段\n第二段", 0, 8, "b").value).toBe("第一段\n第二段");
    expect(wrapGloGuideSelection("不變", 1, 1, "b").value).toBe("不變");
  });
});

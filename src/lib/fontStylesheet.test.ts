// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { activatePreloadedFontStylesheet, REDCODE_FONT_STYLESHEET_ID } from "./fontStylesheet";

describe("品牌字體 CSS 非阻塞啟用", () => {
  it("重用已 preload 嘅同一條 link；URL 不變、唔會新增第二份 stylesheet", () => {
    const link = document.createElement("link");
    link.id = REDCODE_FONT_STYLESHEET_ID;
    link.rel = "preload";
    link.as = "style";
    link.href = "data:text/css,body%7Bcolor%3Awhite%7D";
    document.head.append(link);

    activatePreloadedFontStylesheet(document);
    activatePreloadedFontStylesheet(document);

    const matches = document.head.querySelectorAll(`#${REDCODE_FONT_STYLESHEET_ID}`);
    expect(matches).toHaveLength(1);
    expect(link.rel).toBe("stylesheet");
    expect(link.getAttribute("as")).toBeNull();
    expect(link.href).toBe("data:text/css,body%7Bcolor%3Awhite%7D");
    link.remove();
  });

  it("缺少 link 或標記唔啱時安全 no-op", () => {
    expect(() => activatePreloadedFontStylesheet(document)).not.toThrow();
    const div = document.createElement("div");
    div.id = REDCODE_FONT_STYLESHEET_ID;
    document.body.append(div);
    expect(() => activatePreloadedFontStylesheet(document)).not.toThrow();
    expect(div.isConnected).toBe(true);
    div.remove();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  injectPublicSeoContent,
  PUBLIC_PAGES,
  renderPublicContent,
  SITEMAP_STATIC_PATHS,
  stripPublicSeoContent,
} from "./publicSeo";
import { injectRouteMeta } from "./og";

describe("公開頁 SEO／AEO／GEO 內容", () => {
  it("sitemap 只包含存在嘅公開 canonical 頁，並補齊 FAQ、AI 試穿及中獎公告", () => {
    expect(SITEMAP_STATIC_PATHS).toContain("/faq");
    expect(SITEMAP_STATIC_PATHS).toContain("/try-on");
    expect(SITEMAP_STATIC_PATHS).toContain("/lucky-results");
    expect(SITEMAP_STATIC_PATHS).toContain("/web-design");
    expect(new Set(SITEMAP_STATIC_PATHS).size).toBe(SITEMAP_STATIC_PATHS.length);
    for (const path of SITEMAP_STATIC_PATHS) {
      expect(PUBLIC_PAGES[path], path).toBeDefined();
      expect(path.startsWith("/try-on/shared/")).toBe(false);
      expect(["/cart", "/checkout", "/account", "/admin"]).not.toContain(path);
    }
  });

  it("index.html 自帶同資料來源一致嘅首頁真 HTML 摘要，#root 保持空", () => {
    const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    expect(indexHtml).toContain(renderPublicContent("/"));
    expect(indexHtml).toContain('<link rel="describedby" type="text/plain" href="/llms.txt" />');
    expect(indexHtml).toContain('<div id="root"></div>');
    expect(indexHtml).not.toContain("<noscript");
    expect(indexHtml).toContain('"alternateName": ["RedCode", "Red Code HK直播台", "redcodexhk"]');
    const appSource = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");
    expect(appSource).toContain("useEffect(() => {");
    expect(appSource).toContain("document.querySelectorAll('[data-redcode-prerender]')");
  });

  it("公開頁 title 同 description 各自唯一", () => {
    const pages = Object.values(PUBLIC_PAGES);
    expect(new Set(pages.map((page) => page.title)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.description)).size).toBe(pages.length);
  });

  it("FAQ 首口內容有晒 19 條可見問題、直接答案同內部連結", () => {
    const page = PUBLIC_PAGES["/faq"];
    expect(page.sections).toHaveLength(19);
    const faqSource = readFileSync(new URL("../../src/pages/Faq.tsx", import.meta.url), "utf8");
    for (const section of page.sections ?? []) {
      expect(faqSource).toContain(section.heading);
      expect(section.text.length).toBeGreaterThan(20);
    }
    const html = renderPublicContent("/faq");
    expect(html).toContain("AI 試穿點玩？");
    expect(html).toContain("唔代表尺碼、鬆緊、合身程度");
    expect(html).toContain('<a href="/try-on">AI 試穿</a>');
    expect(html).toContain('<a href="/returns">退換貨政策</a>');
  });

  it("AI 試穿頁答案先置，並清楚講明視覺預覽唔等於尺碼建議", () => {
    const html = renderPublicContent("/try-on");
    expect(html).toContain("<h1>RedCode AI 試穿</h1>");
    expect(html).toContain("登入會員後");
    expect(html).toContain("唔代表實際尺碼、鬆緊、合身程度或舒適度");
    expect(html).toContain('href="/faq#ai-tryon-tutorial"');
  });

  it("退換貨首口內容同公開政策一致", () => {
    const html = renderPublicContent("/returns");
    expect(html).toContain("收到貨 7 天內");
    expect(html).toContain("未經穿著或使用、吊牌未剪、原包裝完整");
    expect(html).toContain("附上訂單編號同貨品相片");
  });

  it("網站設計首口 HTML 有專屬 OG 圖、Service JSON-LD 同真內容，唔寫排名保證", () => {
    const page = PUBLIC_PAGES["/web-design"];
    const template = `<html><head><title>舊標題</title><meta property="og:image" content="https://redcode.red/old.png" /><meta name="twitter:image" content="https://redcode.red/old.png" /></head><body><div id="root"></div></body></html>`;
    const html = injectRouteMeta(template, { ...page, path: "/web-design" });
    expect(html).toContain('<meta property="og:image" content="https://redcode.red/web-design/suit-poster.webp" />');
    expect(html).toContain('<meta name="twitter:image" content="https://redcode.red/web-design/suit-poster.webp" />');
    expect(html).toContain('data-redcode-route-schema');
    expect(html).toContain('"@type":"Service"');
    expect(html).toContain('"name":"RedCode HK Limited"');
    expect(html).not.toContain('保證搜尋排名');
    const content = renderPublicContent("/web-design");
    expect(content).toContain("只要前台");
    expect(content).toContain("前台＋後台");
    expect(content).toContain("唔會保證搜尋排名");
    expect(content).toContain("服務訂單同一般商品訂單分開");
  });

  it("注入只發生一次；未知路徑同冇 </body> 嘅 HTML 原樣返回", () => {
    const template = "<html><body><div id=\"root\"></div></body></html>";
    const once = injectPublicSeoContent(template, "/");
    const twice = injectPublicSeoContent(once, "/");
    expect(once).toContain('id="redcode-public-seo"');
    expect(once).toContain("data-redcode-prerender");
    expect(once).not.toContain("<noscript");
    expect(twice).toBe(once);
    expect(twice.match(/id="redcode-public-seo"/g)).toHaveLength(1);
    expect(stripPublicSeoContent(once)).not.toContain('id="redcode-public-seo"');
    expect(injectPublicSeoContent(template, "/private")).toBe(template);
    expect(injectPublicSeoContent("<html></html>", "/")).toBe("<html></html>");
  });
});

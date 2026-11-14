import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  faqPageStructuredData,
  injectPublicSeoContent,
  PUBLIC_PAGES,
  publicLuckyEventSitemapPaths,
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

  it("單場公告 sitemap 路徑去重及擋無效 ID，唔包含私人查劵路徑", () => {
    expect(publicLuckyEventSitemapPaths([7, 12, 7, 0, -1, 1.5, Number.NaN])).toEqual([
      "/lucky-results/7",
      "/lucky-results/12",
    ]);
    expect(publicLuckyEventSitemapPaths([7]).join()).not.toContain("/lucky-tickets/");
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
    expect(html).toContain("24 小時效果連結同公開商品資料");
    expect(html).toContain("主要分享按鈕會直接傳出 PNG 效果圖");
    expect(html).toContain("30 分鐘付款時限只適用於官網訪客訂單；會員可於 48 小時內支付，以完成下單流程。");
    expect(html).toContain("按官網付款資料轉帳或支付，再上傳截圖供人工審核；或者使用 Airwallex 即時支付工具直接付款。");
    expect(html).toContain("正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。");
    expect(html).not.toContain("私人試穿結果唔會自動附加");
    expect(faqSource).toContain("24 小時效果連結同公開商品資料");
    expect(faqSource).toContain("已下載或已傳出嘅 PNG 無法撤回");
  });

  it("FAQPage JSON-LD 同 19 條可見 Q&A 同源，答案唔會另一套", () => {
    const schema = faqPageStructuredData();
    expect(schema["@type"]).toBe("FAQPage");
    expect(schema.url).toBe("https://redcode.red/faq");
    const questions = schema.mainEntity as {
      "@type": string;
      name: string;
      acceptedAnswer: { "@type": string; text: string };
    }[];
    expect(questions).toHaveLength(19);
    expect(questions.map((q) => q.name)).toEqual(
      (PUBLIC_PAGES["/faq"].sections ?? []).map((section) => section.heading),
    );
    expect(questions.map((q) => q.acceptedAnswer.text)).toEqual(
      (PUBLIC_PAGES["/faq"].sections ?? []).map((section) => section.text),
    );
    expect(JSON.stringify(schema)).not.toContain("保證搜尋排名");
  });

  it("AI 試穿頁答案先置，並清楚講明視覺預覽唔等於尺碼建議", () => {
    const html = renderPublicContent("/try-on");
    expect(html).toContain("<h1>RedCode AI 試穿</h1>");
    expect(html).toContain("登入會員後");
    expect(html).toContain("唔代表實際尺碼、鬆緊、合身程度或舒適度");
    expect(html).toContain('href="/faq#ai-tryon-tutorial"');
    expect(html).toContain("300 × 300 像素");
    expect(html).toContain("JPEG、PNG 或 WebP");
    expect(html).toContain("私人原相及結果預設保留 24 小時");
    expect(html).toContain('href="/privacy"');
  });

  it("退換貨首口內容同公開政策一致", () => {
    const html = renderPublicContent("/returns");
    expect(html).toContain("收到貨 7 天內");
    expect(html).toContain("正常情況下，訂單確認後約 7–10 個工作天寄出，惟部分商品可能需要更久。");
    expect(html).toContain("呢個係寄出時間，唔係保證送達時間，亦唔係收貨後 7 天嘅退換申請期限。");
    expect(html).toContain("未經穿著或使用、吊牌未剪、原包裝完整");
    expect(html).toContain("附上訂單編號同貨品相片");
  });

  it("網站設計首口 HTML 有專屬 OG 圖、Service JSON-LD 同真內容，唔寫排名保證", () => {
    const page = PUBLIC_PAGES["/web-design"];
    // v2026.11.09.1：SEO 六項合併做套票，title 唔再「逐項 SEO」
    expect(page.title).toBe("香港網站設計｜前台、後台及 SEO 套票｜RedCode");
    expect(page.title).not.toContain("逐項 SEO");
    const template = `<html><head><title>舊標題</title><meta property="og:image" content="https://redcode.red/old.png" /><meta name="twitter:image" content="https://redcode.red/old.png" /></head><body><div id="root"></div></body></html>`;
    const html = injectRouteMeta(template, { ...page, path: "/web-design" });
    expect(html).toContain("<title>香港網站設計｜前台、後台及 SEO 套票｜RedCode</title>");
    expect(html).toContain('<meta property="og:image" content="https://redcode.red/web-design/web-design-og.webp" />');
    expect(html).toContain('<meta name="twitter:image" content="https://redcode.red/web-design/web-design-og.webp" />');
    expect(html).toContain('data-redcode-route-schema="/web-design"');
    expect(html.match(/"@type":"Service"/g)).toHaveLength(1);
    expect(html).toContain('"provider":{"@id":"https://redcode.red/#org"}');
    expect(html).not.toContain('#organization');
    expect(html).toContain(`<meta name="twitter:title" content="${page.title}" />`);
    expect(html).toContain(`<meta name="twitter:description" content="${page.description}" />`);
    expect(html).toContain(`<meta property="og:image:alt" content="${page.title}" />`);
    expect(html).not.toContain('保證搜尋排名');
    const webDesignSource = readFileSync(new URL("../../src/pages/WebDesignPage.tsx", import.meta.url), "utf8");
    const visibleH1 = webDesignSource
      .match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]
      .replace(/<br\s*\/>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "");
    expect(visibleH1).toBe(page.heading);
    expect(webDesignSource).not.toContain("dangerouslySetInnerHTML={{ __html: jsonLd }}");
    const content = renderPublicContent("/web-design");
    expect(content).toContain("只要前台");
    expect(content).toContain("前台＋後台");
    expect(content).toContain("唔會保證搜尋排名");
    expect(content).toContain("服務訂單同一般商品訂單分開");
  });

  it("公開事實 regression：/live 同 /products 唔再無條件承諾直播優惠，以商品頁為準", () => {
    // 證據：客人可見嘅 /live 頁（src/pages/Live.tsx）只講部分場次有限時快閃價；
    // 商品真描述（contracts/types.ts productSeoDescription）用真 discountPrice/price＋庫存，
    // 佢嘅測試明確禁止「直播優惠價發售，順豐站自取」呢句無條件承諾。
    const live = PUBLIC_PAGES["/live"];
    expect(live.description).not.toContain("直播優惠繼續生效");
    expect(live.description).not.toContain("直播優惠價發售");
    expect(live.description).toContain("以商品頁為準");
    const products = PUBLIC_PAGES["/products"];
    expect(products.description).not.toContain("直播優惠價發售");
    expect(products.description).toContain("以各商品頁為準");
    // 仍然如實講自取方式（FAQ 可見頁一致）
    expect(products.description).toContain("順豐站/自提點/智能櫃自取");
    // 全站任何公開頁文案都唔准有排名承諾或假評價
    for (const page of Object.values(PUBLIC_PAGES)) {
      expect(page.description).not.toMatch(/保證|排名第一|第一名|好評|評分/);
    }
  });

  it("直播付款、不定期優惠及寄出政策喺 React 同首口 HTML 同步", () => {
    const liveSource = readFileSync(new URL("../../src/pages/Live.tsx", import.meta.url), "utf8");
    const aboutSource = readFileSync(new URL("../../src/pages/About.tsx", import.meta.url), "utf8");
    const returnsSource = readFileSync(new URL("../../src/pages/Returns.tsx", import.meta.url), "utf8");
    const productSource = readFileSync(new URL("../../src/pages/ProductDetail.tsx", import.meta.url), "utf8");
    expect(liveSource).toContain("PUBLIC_PAYMENT_POLICY.liveText");
    expect(liveSource).toContain("PUBLIC_PAYMENT_POLICY.methodsText");
    expect(liveSource).not.toContain("every night");
    expect(liveSource).not.toContain("今晚，直播間見");
    expect(aboutSource).toContain("PUBLIC_OFFER_POLICY_TEXT");
    for (const stale of ["3件再包郵", "即日入數全單減 $15", "外地滿 $450 包郵", "全單再減 $10"]) {
      expect(aboutSource).not.toContain(stale);
    }
    expect(returnsSource).toContain("PUBLIC_DISPATCH_POLICY.visibleText");
    expect(returnsSource).toContain("PUBLIC_RETURN_POLICY.applicationDays");
    expect(productSource).toContain("PUBLIC_DISPATCH_POLICY.visibleText");
    const liveHtml = renderPublicContent("/live");
    expect(liveHtml).toContain("直播出單及收款");
    expect(liveHtml).toContain("30 分鐘付款時限只適用於官網訪客訂單；會員可於 48 小時內支付");
    const aboutHtml = renderPublicContent("/about");
    expect(aboutHtml).toContain("不定期推出優惠");
    expect(aboutHtml).not.toContain("全單再減 $10");
  });

  it("條款、FAQ、首頁、頁腳及 PWA 都唔再殘留舊寄出或固定每晚承諾", () => {
    const paths = [
      "../../src/pages/Terms.tsx",
      "../../src/pages/Faq.tsx",
      "../../src/pages/Home.tsx",
      "../../src/components/Footer.tsx",
      "../../public/manifest.webmanifest",
      "../../index.html",
    ] as const;
    for (const path of paths) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source, path).not.toContain("每晚");
      expect(source, path).not.toContain("7-10 個工作天</b>內寄出");
      expect(source, path).not.toContain("7–10 個工作天內");
    }
    const terms = readFileSync(new URL("../../src/pages/Terms.tsx", import.meta.url), "utf8");
    expect(terms).toContain("PUBLIC_DISPATCH_POLICY.visibleText");
    expect(terms).toContain("PUBLIC_DISPATCH_POLICY.clarificationText");
    const faq = readFileSync(new URL("../../src/pages/Faq.tsx", import.meta.url), "utf8");
    expect(faq).toContain("PUBLIC_PAYMENT_POLICY.guestMethodText");
    expect(renderPublicContent("/faq")).toContain("訪客快速結帳只使用 Airwallex 即時支付");
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

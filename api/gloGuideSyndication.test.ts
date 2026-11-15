/**
 * Glo Guide sitemap／RSS syndication helper 測試（純函數＋DI，唔掂 DB）：
 * ─ XML escape 五字元；站內 path 白名單（外部／protocol-relative／控制字元拒絕）；
 * ─ 合法／非法 lastmod（非法唔出假日期）；
 * ─ RSS 全文／圖片／商品／AI 披露；特殊字元 escape；]]> CDATA 安全；
 * ─ 空列表；loadPublishedGuideFeed 用注入假查詢，中途變非 published 會略過。
 */
import { describe, expect, it } from "vitest";
import type { GuideDetail, GuideImage, GuideProduct } from "@contracts/gloGuide";
import {
  GUIDE_IMAGE_DISCLOSURE,
  GLO_GUIDE_FEED_PATH,
  cdata,
  escapeXml,
  gloGuideSitemapEntries,
  loadPublishedGuideFeed,
  renderGloGuideRss,
  renderSitemapIndex,
  renderSitemapUrlset,
  toCanonicalUrl,
  validLastmod,
} from "./gloGuideSyndication";

const NOW = new Date("2026-03-01T04:00:00.000Z");

const product = (id: number): GuideProduct => ({
  id,
  name: `冷衫<特別版> & "暖"`,
  image: `/uploads/p${id}.jpg`,
  photos: [`/uploads/p${id}.jpg`],
  price: 268,
  discountPrice: 228,
  category: "top",
  stock: 3,
  sizeEnabled: true,
  sizes: ["S", "M"],
  aiTags: ["顯瘦"],
  isActive: true,
  liveDate: "20260220",
  liveSession: "2",
});

const image = (id: number, over: Partial<GuideImage> = {}): GuideImage => ({
  id,
  path: `/uploads/glo-guide/img-${id}.png`,
  alt: `配搭圖 ${id}`,
  width: 1024,
  height: 1536,
  position: id,
  productId: null,
  ...over,
});

const detail = (slug: string, over: Partial<GuideDetail> = {}): GuideDetail => ({
  id: 1,
  slug,
  title: `春季配搭 <指南> & "精選"`,
  excerpt: `excerpt with <tag> & 'quote' ]]> tail`,
  theme: "轉季",
  publishedAt: "2026-02-20T10:00:00.000Z",
  updatedAt: "2026-02-21T10:00:00.000Z",
  coverImage: image(1),
  products: [product(7)],
  body: "第一段介紹。\n\n第二段有 ]]> 同 <b>標籤</b> & 符號。",
  images: [image(1), image(2)],
  modelImage: null,
  ...over,
});

describe("escapeXml", () => {
  it("五個字元全部 escape，& 唔會雙重 escape", () => {
    expect(escapeXml(`a & b <c> "d" 'e'`)).toBe(
      "a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;",
    );
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });
});

describe("toCanonicalUrl 站內 path 白名單", () => {
  it("合法站內 path 加 canonical origin", () => {
    expect(toCanonicalUrl("/glo-guide/abc")).toBe("https://redcode.red/glo-guide/abc");
    expect(toCanonicalUrl("/")).toBe("https://redcode.red/");
  });
  it("拒絕外部 URL、protocol-relative、scheme、相對路徑", () => {
    expect(toCanonicalUrl("https://evil.com/x")).toBeNull();
    expect(toCanonicalUrl("http://redcode.red.evil.com")).toBeNull();
    expect(toCanonicalUrl("//evil.com/x")).toBeNull();
    expect(toCanonicalUrl("javascript:alert(1)")).toBeNull();
    expect(toCanonicalUrl("glo-guide/abc")).toBeNull();
    expect(toCanonicalUrl("")).toBeNull();
  });
  it("拒絕 // 任何位置、控制字元、空白、反斜線", () => {
    expect(toCanonicalUrl("/a//b")).toBeNull();
    expect(toCanonicalUrl("/a\nb")).toBeNull();
    expect(toCanonicalUrl("/a\tb")).toBeNull();
    expect(toCanonicalUrl("/a b")).toBeNull();
    expect(toCanonicalUrl("/a\\b")).toBeNull();
  });
});

describe("lastmod", () => {
  it("合法日期輸出 ISO；無效日期回 null（唔出假日期）", () => {
    expect(validLastmod("2026-02-20T10:00:00.000Z")).toBe("2026-02-20T10:00:00.000Z");
    expect(validLastmod("2026-02-20")).toBe("2026-02-20T00:00:00.000Z");
    expect(validLastmod("not-a-date")).toBeNull();
    expect(validLastmod("2026-13-99")).toBeNull();
    expect(validLastmod(null)).toBeNull();
    expect(validLastmod(undefined)).toBeNull();
    expect(validLastmod("")).toBeNull();
  });
});

describe("renderSitemapUrlset", () => {
  it("輸出合法 entry＋lastmod，非法 path 略過，loc 去重", () => {
    const xml = renderSitemapUrlset([
      { path: "/glo-guide", changefreq: "weekly", priority: 0.6 },
      { path: "/glo-guide/a", lastmod: "2026-02-21T10:00:00.000Z" },
      { path: "/glo-guide/a", lastmod: "2026-02-22T10:00:00.000Z" }, // 重複 → 只出一次
      { path: "https://evil.com/x" },
      { path: "//evil.com/x" },
    ]);
    expect(xml).toContain("<urlset xmlns=");
    expect(xml).toContain("<loc>https://redcode.red/glo-guide</loc>");
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.6</priority>");
    expect(xml).toContain("<lastmod>2026-02-21T10:00:00.000Z</lastmod>");
    expect(xml.match(/\/glo-guide\/a/g)?.length).toBe(1);
    expect(xml).not.toContain("evil.com");
    expect(xml).not.toContain("2026-02-22");
  });
  it("無效 lastmod 唔輸出 lastmod 標籤", () => {
    const xml = renderSitemapUrlset([{ path: "/glo-guide/a", lastmod: "garbage" }]);
    expect(xml).toContain("<loc>https://redcode.red/glo-guide/a</loc>");
    expect(xml).not.toContain("<lastmod>");
  });
  it("空列表照出合法空 urlset", () => {
    const xml = renderSitemapUrlset([]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
  });
});

describe("renderSitemapIndex", () => {
  it("sitemap index 用同一套 path／lastmod 規矩", () => {
    const xml = renderSitemapIndex([
      { path: "/sitemap.xml", lastmod: "2026-02-20T10:00:00.000Z" },
      { path: "https://evil.com/sitemap.xml" },
      { path: "/glo-guide/feed.xml", lastmod: "bad" },
    ]);
    expect(xml).toContain("<sitemapindex xmlns=");
    expect(xml).toContain("<loc>https://redcode.red/sitemap.xml</loc>");
    expect(xml).toContain("<lastmod>2026-02-20T10:00:00.000Z</lastmod>");
    expect(xml).toContain("<loc>https://redcode.red/glo-guide/feed.xml</loc>");
    expect(xml).not.toContain("evil.com");
    // 壞 lastmod 嗰條唔出 lastmod
    const feedRow = xml.split("\n").find((l) => l.includes("feed.xml")) ?? "";
    expect(feedRow).not.toContain("lastmod");
  });
});

describe("gloGuideSitemapEntries", () => {
  it("總覽＋每篇指南，lastmod 用真 updatedAt", () => {
    const entries = gloGuideSitemapEntries([detail("spring-guide")]);
    expect(entries[0].path).toBe("/glo-guide");
    expect(entries[1].path).toBe("/glo-guide/spring-guide");
    expect(entries[1].lastmod).toBe("2026-02-21T10:00:00.000Z");
  });
});

describe("loadPublishedGuideFeed（DI，唔掂 DB）", () => {
  it("逐篇用 bySlug 攞公開詳情；中途變非 published（null）就略過", async () => {
    const slugs = ["a", "b", "c"];
    const bySlugCalls: string[] = [];
    const details = await loadPublishedGuideFeed(10, {
      listPublished: async (limit) => {
        expect(limit).toBe(10);
        return slugs.map((slug) => detail(slug));
      },
      getBySlug: async (slug) => {
        bySlugCalls.push(slug);
        return slug === "b" ? null : detail(slug); // b 中途被撤回
      },
    });
    expect(bySlugCalls).toEqual(slugs);
    expect(details.map((d) => d.slug)).toEqual(["a", "c"]);
  });
  it("limit clamp 1..50，預設 20", async () => {
    const seen: number[] = [];
    const listPublished = async (limit: number) => {
      seen.push(limit);
      return [];
    };
    const getBySlug = async () => null;
    await loadPublishedGuideFeed(0, { listPublished, getBySlug });
    await loadPublishedGuideFeed(999, { listPublished, getBySlug });
    await loadPublishedGuideFeed(undefined as unknown as number, { listPublished, getBySlug });
    expect(seen).toEqual([1, 50, 20]);
  });
  it("空列表回空陣列", async () => {
    const details = await loadPublishedGuideFeed(5, {
      listPublished: async () => [],
      getBySlug: async () => {
        throw new Error("唔應該被叫");
      },
    });
    expect(details).toEqual([]);
  });
});

describe("renderGloGuideRss", () => {
  it("channel 有 title/link/description/language/atom:self/lastBuildDate", () => {
    const xml = renderGloGuideRss([detail("spring-guide")], { now: NOW });
    expect(xml).toContain("<rss version=\"2.0\"");
    expect(xml).toContain("xmlns:content=");
    expect(xml).toContain("xmlns:dc=");
    expect(xml).toContain("xmlns:atom=");
    expect(xml).toContain("<title>Glo Glo 精選配搭指南｜RedCode Fashion Design</title>");
    expect(xml).toContain("<link>https://redcode.red/glo-guide</link>");
    expect(xml).toContain(
      `<atom:link href="https://redcode.red${GLO_GUIDE_FEED_PATH}" rel="self" type="application/rss+xml" />`,
    );
    expect(xml).toContain("<language>zh-Hant-HK</language>");
    expect(xml).toContain(`<lastBuildDate>${NOW.toUTCString()}</lastBuildDate>`);
  });

  it("item 有真 title/link/guid isPermaLink/pubDate/dc:creator/description", () => {
    const xml = renderGloGuideRss([detail("spring-guide")], { now: NOW });
    expect(xml).toContain(
      "<title>春季配搭 &lt;指南&gt; &amp; &quot;精選&quot;</title>",
    );
    expect(xml).toContain("<link>https://redcode.red/glo-guide/spring-guide</link>");
    expect(xml).toContain(
      '<guid isPermaLink="true">https://redcode.red/glo-guide/spring-guide</guid>',
    );
    expect(xml).toContain(
      `<pubDate>${new Date("2026-02-20T10:00:00.000Z").toUTCString()}</pubDate>`,
    );
    expect(xml).toContain("<dc:creator>Glo Glo</dc:creator>");
    // description 係 excerpt（escaped），唔會有未 escape 嘅 <tag>
    expect(xml).toContain(
      "<description>excerpt with &lt;tag&gt; &amp; &apos;quote&apos; ]]&gt; tail</description>",
    );
  });

  it("content:encoded 有完整 body、全部公開圖、商品真名/價錢/連結、AI 披露", () => {
    const xml = renderGloGuideRss([detail("spring-guide")], { now: NOW });
    expect(xml).toContain("<content:encoded><![CDATA[");
    // 完整 body 兩段（HTML escape 後）
    expect(xml).toContain("<p>第一段介紹。</p>");
    expect(xml).toContain("&lt;b&gt;標籤&lt;/b&gt; &amp; 符號");
    // 全部 DTO 圖片（絕對站內 URL）
    expect(xml).toContain('src="https://redcode.red/uploads/glo-guide/img-1.png"');
    expect(xml).toContain('src="https://redcode.red/uploads/glo-guide/img-2.png"');
    expect(xml).toContain('alt="配搭圖 2"');
    // 商品真名／真價錢（折後＋原價）／真連結
    expect(xml).toContain('href="https://redcode.red/products/7"');
    expect(xml).toContain("冷衫&lt;特別版&gt; &amp; &quot;暖&quot;");
    expect(xml).toContain("HK$228（原價 HK$268）");
    // 必填披露；唔准真人實穿字眼
    expect(xml).toContain(GUIDE_IMAGE_DISCLOSURE);
    expect(xml).not.toContain("實穿");
    expect(xml).not.toContain("真人");
  });

  it("]]> 安全：cdata() 防禦性拆開；RSS payload 內唔會有未處理嘅 ]]>", () => {
    // cdata 單元層面：萬一 payload 有 raw ]]> 都會拆開，唔會提早終止 CDATA
    expect(cdata("a]]>b")).toBe("<![CDATA[a]]]]><![CDATA[>b]]>");
    // RSS 層面：所有 user text 已 HTML escape（> → &gt;），payload 內唔可能存在 raw ]]>
    const xml = renderGloGuideRss([detail("spring-guide")], { now: NOW });
    const m = xml.match(/<content:encoded>([\s\S]*?)<\/content:encoded>/);
    expect(m).toBeTruthy();
    const payload = m![1];
    expect(payload.startsWith("<![CDATA[")).toBe(true);
    expect(payload.endsWith("]]>")).toBe(true);
    expect(payload.slice(9, -3)).not.toContain("]]>");
    expect(xml).not.toContain("]]> 同");
  });

  it("特殊字元會 escape：title/body 唔會有 raw <tag>", () => {
    const xml = renderGloGuideRss([detail("spring-guide")], { now: NOW });
    expect(xml).not.toContain("<指南>");
    expect(xml).not.toContain("<b>標籤</b>");
  });

  it("非站內圖片 path 會略過，唔反射外部 URL", () => {
    const evil = detail("evil-img", {
      images: [image(1), image(9, { path: "https://evil.com/x.png" })],
    });
    const xml = renderGloGuideRss([evil], { now: NOW });
    expect(xml).not.toContain("evil.com");
    expect(xml).toContain('src="https://redcode.red/uploads/glo-guide/img-1.png"');
  });

  it("空列表照出合法 channel，冇 item", () => {
    const xml = renderGloGuideRss([], { now: NOW });
    expect(xml).toContain("<channel>");
    expect(xml).toContain("</channel>");
    expect(xml).not.toContain("<item>");
    expect(xml).toContain(`<lastBuildDate>${NOW.toUTCString()}</lastBuildDate>`);
  });

  it("成份 feed 淨係 redcode.red URL，冇任何外部反射", () => {
    const xml = renderGloGuideRss(
      [detail("spring-guide"), detail("第二篇", { slug: "second" })],
      { now: NOW },
    );
    const urls = xml.match(/https?:\/\/[^\s"'<]+/g) ?? [];
    const pageUrls = urls.filter(
      (u) =>
        !u.startsWith("https://redcode.red") &&
        !u.startsWith("http://purl.org") &&
        !u.startsWith("http://www.w3.org"),
    );
    expect(pageUrls).toEqual([]);
  });
});

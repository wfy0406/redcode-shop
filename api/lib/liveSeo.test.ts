/**
 * 直播節目頁 SEO helper 測試（v2026.10.28.2）——純函數，唔掂 DB、唔掂 fs。
 * 覆蓋：真實日曆日期／數字場次驗證、全日／單場 title/description 分別、
 * canonical path 編碼、無效輸入回 null（絕不反射）。
 * v2026.11.11 補強：真空場次 emptyLiveRouteMeta（noindex、唔扮有貨）、
 * sitemap 直播 URL 去重＋非法 DB 值過濾、文案唔再無條件承諾直播優惠價。
 */
import { describe, expect, it } from "vitest";
import {
  emptyLivePublicCopy,
  liveEra,
  liveFactsSentence,
  livePublicDescription,
  summarizeLiveProducts,
} from "@contracts/livePublicSummary";
import {
  emptyLiveRouteMeta,
  formatLiveDateLabel,
  injectPublicLiveIndex,
  isValidLiveDate,
  isValidLiveSession,
  liveDescription,
  liveFactDescription,
  liveFactRouteMeta,
  livePath,
  liveRouteMeta,
  liveSitemapPaths,
  liveTitle,
  parseLiveQuery,
  renderPublicLiveIndex,
} from "./liveSeo";

describe("isValidLiveDate — 真實日曆日期", () => {
  it("正常日期過（閏年 2/29 都過）", () => {
    expect(isValidLiveDate("20261028")).toBe(true);
    expect(isValidLiveDate("20240229")).toBe(true);
  });
  it("假日曆日期唔過", () => {
    expect(isValidLiveDate("20230229")).toBe(false);
    expect(isValidLiveDate("20261301")).toBe(false);
    expect(isValidLiveDate("20260230")).toBe(false);
    expect(isValidLiveDate("20260001")).toBe(false);
  });
  it("格式／注入字串唔過", () => {
    expect(isValidLiveDate("")).toBe(false);
    expect(isValidLiveDate("2026-10-28")).toBe(false);
    expect(isValidLiveDate('20261028"><script>')).toBe(false);
  });
});

describe("isValidLiveSession — 正整數場次", () => {
  it("正整數過；零／前導零／負數／小數／注入唔過", () => {
    expect(isValidLiveSession("1")).toBe(true);
    expect(isValidLiveSession("23")).toBe(true);
    for (const bad of ["", "0", "01", "-1", "1.5", "abc", '1"><img']) {
      expect(isValidLiveSession(bad)).toBe(false);
    }
  });
});

describe("parseLiveQuery — 無效輸入回 null", () => {
  it("冇 liveDate → null（通用 /products，唔係錯）", () => {
    expect(parseLiveQuery(null, null)).toBeNull();
    expect(parseLiveQuery("", null)).toBeNull();
  });
  it("有效全日／單場", () => {
    expect(parseLiveQuery("20261028", null)).toEqual({
      liveDate: "20261028",
      liveSession: null,
    });
    expect(parseLiveQuery("20261028", "3")).toEqual({
      liveDate: "20261028",
      liveSession: "3",
    });
  });
  it("無效日期／場次 → null（絕不反射）", () => {
    expect(parseLiveQuery("20261340", null)).toBeNull();
    expect(parseLiveQuery("20261028", "abc")).toBeNull();
    expect(parseLiveQuery('20261028"><script>', null)).toBeNull();
  });
});

describe("live meta — 全日／單場文案有分別", () => {
  it("日期格式化", () => {
    expect(formatLiveDateLabel("20261028")).toBe("2026年10月28日");
  });
  it("全日：title/description 强调全部場次；path 淨 liveDate", () => {
    const f = { liveDate: "20261028", liveSession: null };
    expect(liveTitle(f)).toBe("2026年10月28日 全日直播商品｜RedCode Fashion Design");
    expect(liveDescription(f)).toContain("全部場次");
    expect(livePath(f)).toBe("/products?liveDate=20261028");
  });
  it("單場：title/description 强调指定場次＋即睇直播商品；path 加 liveSession", () => {
    const f = { liveDate: "20261028", liveSession: "2" };
    expect(liveTitle(f)).toBe("2026年10月28日 第2場直播商品｜RedCode Fashion Design");
    expect(liveDescription(f)).toContain("第2場");
    expect(liveDescription(f)).toContain("即睇直播商品");
    expect(livePath(f)).toBe("/products?liveDate=20261028&liveSession=2");
  });
});

describe("live meta — 公開事實文案 regression", () => {
  it("唔再無條件承諾「直播優惠價發售」；品名／價錢／庫存以商品頁為準", () => {
    for (const f of [
      { liveDate: "20261028", liveSession: null },
      { liveDate: "20261028", liveSession: "2" },
    ]) {
      const d = liveDescription(f);
      expect(d).not.toContain("直播優惠價發售");
      expect(d).not.toContain("優惠繼續生效");
      expect(d).toContain("以商品頁為準");
    }
  });
});

describe("emptyLiveRouteMeta — 真空場次唔准扮有貨", () => {
  it("全日空場次：noindex＋移除 self canonical＋如實文案", () => {
    const meta = emptyLiveRouteMeta({ liveDate: "20261028", liveSession: null });
    expect(meta.noindex).toBe(true);
    expect(meta.canonical).toBeNull();
    expect(meta.path).toBeUndefined();
    expect(meta.title).toBe("2026年10月28日 直播暫未有公開商品｜RedCode Fashion Design");
    expect(meta.description).toContain("冇公開商品");
    expect(meta.description).toContain("以商品頁為準");
    expect(meta.description).not.toContain("直播優惠");
  });
  it("單場空場次帶場次號；合法日期先會出現喺文案", () => {
    const meta = emptyLiveRouteMeta({ liveDate: "20261111", liveSession: "3" });
    expect(meta.title).toContain("第3場");
    expect(meta.title).toContain("2026年11月11日");
    expect(meta.noindex).toBe(true);
    expect(meta.canonical).toBeNull();
  });
  it("文案同 client 共用 emptyLivePublicCopy，前後端一字唔差", () => {
    for (const f of [
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "3" },
    ]) {
      const copy = emptyLivePublicCopy(f);
      const meta = emptyLiveRouteMeta(f);
      expect(meta.title).toBe(copy?.title);
      expect(meta.description).toBe(copy?.description);
    }
  });
});

describe("liveSitemapPaths — sitemap 直播 URL", () => {
  it("合法全日／單場出 URL，同一 URL 去重", () => {
    const paths = liveSitemapPaths([
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261111", liveSession: "1" }, // 重複場次
      { liveDate: "20261111", liveSession: null }, // 重複全日
      { liveDate: "20261111", liveSession: "2" },
    ]);
    expect(paths).toEqual([
      "/products?liveDate=20261111",
      "/products?liveDate=20261111&liveSession=1",
      "/products?liveDate=20261111&liveSession=2",
    ]);
  });
  it("DB 落嚟嘅非法值（假日曆日期／非數字場次／null）一律唔入 sitemap", () => {
    const paths = liveSitemapPaths([
      { liveDate: "20261340", liveSession: null },
      { liveDate: "20261111", liveSession: "abc" },
      { liveDate: "20261111", liveSession: "0" },
      { liveDate: '20261111"><script>', liveSession: null },
      null,
      undefined,
      { liveDate: "20261111", liveSession: "1" },
    ]);
    expect(paths).toEqual(["/products?liveDate=20261111&liveSession=1"]);
  });
});

describe("/live 首口真節目索引", () => {
  it("最新日期排先、同日出全日及場次真內鏈；非法 DB 值唔反射", () => {
    const html = renderPublicLiveIndex([
      { liveDate: "20261103", liveSession: "2" },
      { liveDate: "20261111", liveSession: "2" },
      { liveDate: "20261111", liveSession: null },
      { liveDate: "20261111", liveSession: "1" },
      { liveDate: "20261340", liveSession: null },
      { liveDate: '20261111"><script>', liveSession: null },
    ]);
    expect(html).toContain('id="redcode-live-index-seo"');
    expect(html.indexOf("2026年11月11日 全日直播商品")).toBeLessThan(
      html.indexOf("2026年11月11日 第1場直播商品"),
    );
    expect(html.indexOf("2026年11月11日 第1場直播商品")).toBeLessThan(
      html.indexOf("2026年11月11日 第2場直播商品"),
    );
    expect(html).toContain('<a href="/products?liveDate=20261111&amp;liveSession=2">');
    expect(html.indexOf("2026年11月11日")).toBeLessThan(html.indexOf("2026年11月3日"));
    expect(html).not.toContain("2026年13月40日");
    expect(html).not.toContain("<script>");
  });

  it("注入單次、冇場次時原樣；非法 limit 都有界", () => {
    const template = '<main><nav aria-label="相關公開頁面"></nav></main>';
    const once = injectPublicLiveIndex(template, [{ liveDate: "20261111", liveSession: "1" }]);
    expect(once).toContain('id="redcode-live-index-seo"');
    expect(injectPublicLiveIndex(once, [{ liveDate: "20261111", liveSession: "1" }])).toBe(once);
    expect(injectPublicLiveIndex(template, [])).toBe(template);
    const many = Array.from({ length: 60 }, (_, i) => ({
      liveDate: `2026${String(Math.floor(i / 28) + 1).padStart(2, "0")}${String((i % 28) + 1).padStart(2, "0")}`,
      liveSession: null,
    }));
    expect((renderPublicLiveIndex(many, 999).match(/<li>/g) ?? [])).toHaveLength(48);
  });
});

describe("liveRouteMeta — 俾 injectRouteMeta 用", () => {
  it("有效輸入出 title/description/path", () => {
    const meta = liveRouteMeta("20261028", "2");
    expect(meta).toEqual({
      title: "2026年10月28日 第2場直播商品｜RedCode Fashion Design",
      description: expect.stringContaining("第2場"),
      path: "/products?liveDate=20261028&liveSession=2",
    });
  });
  it("無效／冇參數 → null（通用 fallback）", () => {
    expect(liveRouteMeta(null, null)).toBeNull();
    expect(liveRouteMeta("20261340", null)).toBeNull();
    expect(liveRouteMeta("20261028", "0")).toBeNull();
  });
});

// 同一批真公開商品行（無 description 欄——證明摘要不依賴舊商品有冇描述）
const FACT_ROWS = [
  { id: 11, name: "星空閃石上衣", category: "top" },
  { id: 12, name: "高腰闊腳褲", category: "pants" },
  { id: 13, name: "碎花長裙", category: "dress" },
  { id: 14, name: "針織短上衣", category: "top" },
];
const FACT_SUMMARY = summarizeLiveProducts(FACT_ROWS);

describe("liveFactDescription — 真資料摘要（v2026.11.11.2）", () => {
  it("單場同全日摘要一定唔同（場次號 vs 全日全部場次）", () => {
    const day = liveFactDescription({ liveDate: "20261111", liveSession: null }, FACT_SUMMARY, "20261111");
    const session = liveFactDescription({ liveDate: "20261111", liveSession: "2" }, FACT_SUMMARY, "20261111");
    expect(day).not.toBe(session);
    expect(day).toContain("全日全部場次直播商品");
    expect(session).toContain("第2場直播商品");
  });

  it("包含真日期、公開商品實數、真分類組成、代表商品名", () => {
    const d = liveFactDescription({ liveDate: "20261111", liveSession: "2" }, FACT_SUMMARY, "20261111");
    expect(d).toContain("2026年11月11日");
    expect(d).toContain("共 4 件公開商品");
    expect(d).toContain("上衣 2 件");
    expect(d).toContain("褲 1 件");
    expect(d).toContain("裙 1 件");
    expect(d).toContain("代表商品：星空閃石上衣、高腰闊腳褲、碎花長裙");
    expect(d).toContain("以商品頁為準");
  });

  it("過往場次用中性「場次商品記錄」；唔聲稱舊優惠仍有效、唔斷言已完結、冇編開播時間", () => {
    const d = liveFactDescription({ liveDate: "20200101", liveSession: "1" }, FACT_SUMMARY, "20261111");
    expect(d).toContain("場次商品記錄");
    expect(d).toContain("以商品頁而家顯示為準");
    expect(d).not.toContain("優惠價發售");
    expect(d).not.toContain("優惠繼續生效");
    expect(d).not.toContain("已完結");
    expect(d).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("冇真商品（空 summary）跌返舊版直播文案，唔出「0 件」假摘要", () => {
    const empty = summarizeLiveProducts([]);
    const f = { liveDate: "20261111", liveSession: "2" };
    expect(liveFactDescription(f, empty, "20261111")).toBe(liveDescription(f));
  });
});

describe("liveFactRouteMeta — meta＋CollectionPage/ItemList JSON-LD", () => {
  const f = { liveDate: "20261111", liveSession: "2" };
  const meta = liveFactRouteMeta(f, FACT_SUMMARY, "20261111", FACT_ROWS);

  it("title 同 liveTitle 一致；path 係 self canonical", () => {
    expect(meta.title).toBe(liveTitle(f));
    expect(meta.path).toBe("/products?liveDate=20261111&liveSession=2");
    expect(meta.noindex).toBeUndefined();
  });

  it("structured data 只含真資料：CollectionPage＋ItemList，無 BroadcastEvent／VideoObject／FAQ", () => {
    const sd = meta.structuredData as Record<string, unknown>;
    expect(sd["@type"]).toBe("CollectionPage");
    expect(sd.url).toBe("https://redcode.red/products?liveDate=20261111&liveSession=2");
    const json = JSON.stringify(sd);
    expect(json).not.toContain("BroadcastEvent");
    expect(json).not.toContain("VideoObject");
    expect(json).not.toContain("FAQPage");
    expect(json).not.toContain("startDate"); // 冇真開播時間，唔准編
    const list = sd.mainEntity as {
      "@type": string;
      numberOfItems: number;
      itemListElement: { "@type": string; position: number; url: string; name: string }[];
    };
    expect(list["@type"]).toBe("ItemList");
    expect(list.numberOfItems).toBe(4);
    expect(list.itemListElement[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      url: "https://redcode.red/products/11",
      name: "星空閃石上衣",
    });
    expect(list.itemListElement.map((e) => e.url)).toEqual(
      FACT_ROWS.map((p) => `https://redcode.red/products/${p.id}`),
    );
  });

  it("首口 description／JSON-LD／React 可見場次區對同一 fixture 一致（同一份事實邏輯）", () => {
    // React（Products.tsx）逐字 render liveFactsSentence(summary, era)；
    // server description 同 JSON-LD description 都要包住同一句，crawler 同用戶唔會兩套。
    const era = liveEra(f.liveDate, "20261111");
    const reactSentence = liveFactsSentence(FACT_SUMMARY, era);
    const desc = liveFactDescription(f, FACT_SUMMARY, "20261111");
    expect(desc).toContain(reactSentence);
    const sd = meta.structuredData as { description: string };
    expect(sd.description).toBe(desc);
    // React 用 includeHighlights:false 嗰版都要係同一句嘅子集（件數＋分類一致）
    const reactNoNames = liveFactsSentence(FACT_SUMMARY, era, { includeHighlights: false });
    expect(desc).toContain("共 4 件公開商品");
    expect(reactNoNames).toContain("共 4 件公開商品");
  });

  it("前後端一致：server liveFactDescription === React 用嘅 livePublicDescription（同一 builder）", () => {
    // Products.tsx 喺全場摘要到位後，用 livePublicDescription 覆寫 document meta
    // description；server 首口一定要同佢一字唔差（全日／單場、過往／未來都試）。
    for (const [filter, today] of [
      [{ liveDate: "20261111", liveSession: null }, "20261111"],
      [{ liveDate: "20261111", liveSession: "2" }, "20261111"],
      [{ liveDate: "20200101", liveSession: "1" }, "20261111"],
      [{ liveDate: "20990101", liveSession: null }, "20261111"],
    ] as const) {
      const clientDesc = livePublicDescription(filter, FACT_SUMMARY, today);
      expect(clientDesc).not.toBeNull();
      expect(liveFactDescription(filter, FACT_SUMMARY, today)).toBe(clientDesc);
    }
  });
});

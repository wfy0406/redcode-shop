import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRows: unknown[] = [];
let seenWhere: unknown = null;
// v2026.11.11.2：對外公告總開關 mock——null＝設定唔存在（預設關閉）；Error＝DB 讀取失敗
let mockAnnouncement: { value: string } | Error | null = { value: "true" };
let selectCalls = 0;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          selectCalls += 1;
          seenWhere = where;
          return {
            limit: () => Promise.resolve(mockRows),
            orderBy: () => ({ limit: () => Promise.resolve(mockRows) }),
          };
        },
      }),
    }),
    query: {
      siteSettings: {
        findFirst: () =>
          mockAnnouncement instanceof Error
            ? Promise.reject(mockAnnouncement)
            : Promise.resolve(mockAnnouncement),
      },
    },
  }),
}));

import {
  getPublicLuckyEventSeo,
  injectLuckyEventIndexContent,
  injectLuckyEventSeoContent,
  listPublicLuckyEventSeo,
  luckyEventRouteMeta,
  luckyEventSeoVisible,
} from "./luckyEventSeo";
import { resetLuckyAnnouncementPublicCache } from "./luckyAnnouncementVisibility";

const event = { id: 12, name: "雙十一．壓軸狂歡", scheduledDrawDate: "20261111" };

beforeEach(() => {
  mockRows = [];
  seenWhere = null;
  mockAnnouncement = { value: "true" };
  selectCalls = 0;
  resetLuckyAnnouncementPublicCache();
});

describe("公開單場中獎公告 SEO", () => {
  it("SQL 同時要求 event id 同 winnersPublic=true；零行回 null", async () => {
    mockRows = [event];
    await expect(getPublicLuckyEventSeo(12)).resolves.toEqual(event);
    const query = new PgDialect().sqlToQuery(seenWhere as never);
    expect(query.params).toEqual([12, true]);
    expect(query.sql).toMatch(/"id" = \$1/);
    expect(query.sql).toMatch(/"winnersPublic" = \$2/);
    mockRows = [];
    await expect(getPublicLuckyEventSeo(999)).resolves.toBeNull();
  });

  it("活動名進入獨立 title／description／首口 H1，唔放任何 winner 資料", () => {
    const meta = luckyEventRouteMeta(event);
    expect(meta.title).toBe("《雙十一．壓軸狂歡》中獎名單｜RedCode Fashion Design");
    expect(meta.path).toBe("/lucky-results/12");
    const html = injectLuckyEventSeoContent('<html><body><div id="root"></div></body></html>', event);
    expect(html).toContain("<h1>《雙十一．壓軸狂歡》中獎公告</h1>");
    expect(html).toContain("預定抽獎日：2026-11-11");
    expect(html).not.toMatch(/winnerName|holderName|ticketCount/i);
  });

  it("活動名特殊字元正確 escape", () => {
    const html = injectLuckyEventSeoContent("<html><body></body></html>", {
      ...event,
      name: 'A"B & <C>',
    });
    expect(html).toContain("《A&quot;B &amp; &lt;C&gt;》");
    expect(html).not.toContain("<C>");
  });

  it("公告總頁列出真公開活動連結；空名單唔放假內容", async () => {
    mockRows = [event];
    await expect(listPublicLuckyEventSeo()).resolves.toEqual([event]);
    const template = '<main id="redcode-public-seo"><nav aria-label="相關公開頁面"></nav></main>';
    const html = injectLuckyEventIndexContent(template, [event]);
    expect(html).toContain('<a href="/lucky-results/12">《雙十一．壓軸狂歡》中獎公告</a>');
    expect(html).toContain("預定抽獎日 2026-11-11");
    expect(injectLuckyEventIndexContent(template, [])).toBe(template);
  });

  it("server 同 client 嘅公開／404 title 同 description 模板保持一致", () => {
    const clientSource = readFileSync(new URL("../../src/pages/LuckyResults.tsx", import.meta.url), "utf8");
    expect(clientSource).toContain('document.title = `《${data.event.name}》中獎名單｜RedCode Fashion Design`;');
    expect(clientSource).toContain('`RedCode《${data.event.name}》直播抽獎公告——查閱公開活動資料、預定抽獎日同已公佈嘅真實中獎結果。`');
    expect(clientSource).toContain("中獎公告未公開或唔存在｜RedCode Fashion Design");
    expect(clientSource).toContain("呢場中獎公告未公開、已移除或唔存在，請返回中獎公告總頁睇最新公開活動。");
  });
});

describe("v2026.11.11.2 對外公告總開關（luckyEventSeo gate）", () => {
  it("預設關閉（設定唔存在）：單場回 null、總覽回 []，兼唔查活動表", async () => {
    mockAnnouncement = null;
    resetLuckyAnnouncementPublicCache();
    mockRows = [event]; // 即使活動 winnersPublic=true 都唔准出
    await expect(getPublicLuckyEventSeo(12)).resolves.toBeNull();
    await expect(listPublicLuckyEventSeo()).resolves.toEqual([]);
    expect(selectCalls).toBe(0);
  });

  it("明確 false／垃圾值一律當關閉", async () => {
    for (const v of ["false", "yes", "1", "TRUE", ""]) {
      mockAnnouncement = { value: v };
      resetLuckyAnnouncementPublicCache();
      mockRows = [event];
      await expect(getPublicLuckyEventSeo(12)).resolves.toBeNull();
      await expect(listPublicLuckyEventSeo()).resolves.toEqual([]);
    }
    expect(selectCalls).toBe(0);
  });

  it("總開關設定讀取失敗 → throw（交 caller 通用 200，唔好誤報 404／關閉）", async () => {
    mockAnnouncement = new Error("settings down");
    resetLuckyAnnouncementPublicCache();
    await expect(getPublicLuckyEventSeo(12)).rejects.toThrow("settings down");
    await expect(listPublicLuckyEventSeo()).rejects.toThrow("settings down");
    expect(selectCalls).toBe(0);
  });

  it("對外可見＝總開 AND 該場 winnersPublic（luckyEventSeoVisible 鎖口径）", () => {
    expect(luckyEventSeoVisible(true, true)).toBe(true);
    expect(luckyEventSeoVisible(true, false)).toBe(false);
    expect(luckyEventSeoVisible(false, true)).toBe(false);
    expect(luckyEventSeoVisible(false, false)).toBe(false);
  });
});

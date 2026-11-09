import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRows: unknown[] = [];
let seenWhere: unknown = null;

vi.mock("../queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          seenWhere = where;
          return {
            limit: () => Promise.resolve(mockRows),
            orderBy: () => ({ limit: () => Promise.resolve(mockRows) }),
          };
        },
      }),
    }),
  }),
}));

import {
  getPublicLuckyEventSeo,
  injectLuckyEventIndexContent,
  injectLuckyEventSeoContent,
  listPublicLuckyEventSeo,
  luckyEventRouteMeta,
} from "./luckyEventSeo";

const event = { id: 12, name: "雙十一．壓軸狂歡", scheduledDrawDate: "20261111" };

beforeEach(() => {
  mockRows = [];
  seenWhere = null;
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

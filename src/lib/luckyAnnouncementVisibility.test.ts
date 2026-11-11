/**
 * src/lib/luckyAnnouncementVisibility.ts（對外公告總開關前端 helper）focused tests。
 *
 * 覆蓋：
 * 1. luckyAnnouncementGateOpen——只有精確 true 開（undefined／false 關）。
 * 2. luckyAnnouncementStatusFresh——「當次 fresh success」閘：舊快取 true 喺背景重查
 *    （isRefetching）／重查失敗（isError，TanStack v5 會保留舊 data）期間一律關。
 * 3. resetLuckyAnnouncementPublicQueries——用**真 QueryClient＋真 tRPC query utils**
 *    （createTRPCQueryUtils，同 app 同一套 key 規則）實證：publicEventResults.reset() 唔帶
 *    input 會清晒**全部 eventId** 嘅單場快取（唔只係當前場），publicEvents 連舊 data 清走，
 *    publicAnnouncementStatus 係 invalidate（標髒等緊接著嘅重查，唔係刪 data）。
 * 4. holdClosedAnnouncementSeo／applyClosedAnnouncementSeo——fake doc＋fake MutationObserver：
 *    關閉五項（title/description/robots/canonical/og:url）即刻寫；SeoManager 翻轉任何一項
 *    都被 observer 即刻還原；寫入前檢查現值，無 drift 時回調零寫入（唔會 observer loop）。
 *
 * 界限：fake doc/observer 只驗 helper 邏輯（寫邊幾項、還原、防 loop）；真 DOM
 * MutationObserver 嘅觸發時機（microtask）靠瀏覽器本身保證，冇 jsdom 依賴所以唔喺度驗。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCQueryUtils } from '@trpc/react-query';
import superjson from 'superjson';
import type { AppRouter } from '../../api/router';
import {
  applyClosedAnnouncementSeo,
  holdClosedAnnouncementSeo,
  luckyAnnouncementGateOpen,
  luckyAnnouncementStatusFresh,
  resetLuckyAnnouncementPublicQueries,
  LUCKY_ANNOUNCEMENT_CLOSED_DESCRIPTION,
  LUCKY_ANNOUNCEMENT_CLOSED_TITLE,
  LUCKY_ANNOUNCEMENT_NOINDEX,
} from './luckyAnnouncementVisibility';

describe('luckyAnnouncementGateOpen（只有精確 true 開）', () => {
  it('true → 開；false／undefined → 關', () => {
    expect(luckyAnnouncementGateOpen(true)).toBe(true);
    expect(luckyAnnouncementGateOpen(false)).toBe(false);
    expect(luckyAnnouncementGateOpen(undefined)).toBe(false);
  });
});

describe('luckyAnnouncementStatusFresh（舊快取 true 待重查／重查失敗都唔算數）', () => {
  it('fresh success（isSuccess＋冇重查＋冇錯）→ 開閘條件成立', () => {
    expect(luckyAnnouncementStatusFresh({ isSuccess: true, isError: false, isRefetching: false })).toBe(true);
  });

  it('舊 data 保留但背景重查緊（refetchOnMount:always／30s interval）→ 關', () => {
    // TanStack v5：背景重查時 status 仍係 success、data 係舊值、isRefetching=true
    expect(luckyAnnouncementStatusFresh({ isSuccess: true, isError: false, isRefetching: true })).toBe(false);
  });

  it('重查失敗（isError，TanStack 保留舊 data）→ 關', () => {
    expect(luckyAnnouncementStatusFresh({ isSuccess: false, isError: true, isRefetching: false })).toBe(false);
    // 極端組合：error 同時仲有 background fetch
    expect(luckyAnnouncementStatusFresh({ isSuccess: false, isError: true, isRefetching: true })).toBe(false);
  });

  it('初次 loading（isSuccess 未成立）→ 關', () => {
    expect(luckyAnnouncementStatusFresh({ isSuccess: false, isError: false, isRefetching: false })).toBe(false);
  });
});

describe('resetLuckyAnnouncementPublicQueries（真 QueryClient＋真 tRPC utils）', () => {
  const RESULT_7 = {
    event: { id: 7, name: '週年慶', createdAt: new Date(0), scheduledDrawDate: '20261201', maxWinsPerPerson: 1, winnersPublic: true as const },
    winners: [{ id: 51, name: '陳小明', prizeName: '禮物A', drawDate: '20261201', drawnAt: new Date(0) }],
  };
  const RESULT_8 = {
    event: { id: 8, name: '壓軸狂歡', createdAt: new Date(0), scheduledDrawDate: null, maxWinsPerPerson: 2, winnersPublic: true as const },
    winners: [],
  };

  function makeUtils() {
    const queryClient = new QueryClient();
    const client = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: 'http://test.local/api/trpc', transformer: superjson })],
    });
    const utils = createTRPCQueryUtils<AppRouter>({ queryClient, client });
    return { queryClient, utils };
  }

  it('reset 清晒全部 eventId 嘅 publicEventResults（唔只當前場）＋ publicEvents 連 data 清走', () => {
    const { queryClient, utils } = makeUtils();
    // 模擬客人睇過兩場公告＋總覽＋status（同 LuckyResults/Navbar 實際寫入嘅 key 一樣）
    utils.luckyDraw.publicEventResults.setData({ eventId: 7 }, RESULT_7);
    utils.luckyDraw.publicEventResults.setData({ eventId: 8 }, RESULT_8);
    utils.luckyDraw.publicEvents.setData(undefined, [
      { id: 7, name: '週年慶', createdAt: new Date(0), scheduledDrawDate: '20261201', winnerCount: 1 },
    ]);
    utils.luckyDraw.publicAnnouncementStatus.setData(undefined, { enabled: true });
    expect(utils.luckyDraw.publicEventResults.getData({ eventId: 7 })).toBeDefined();
    expect(utils.luckyDraw.publicEventResults.getData({ eventId: 8 })).toBeDefined();

    resetLuckyAnnouncementPublicQueries(utils);

    // 唔帶 input 嘅 reset()＝procedure 前綴 partial match：eventId 7 **同** 8 都清
    expect(utils.luckyDraw.publicEventResults.getData({ eventId: 7 })).toBeUndefined();
    expect(utils.luckyDraw.publicEventResults.getData({ eventId: 8 })).toBeUndefined();
    // 總覽連舊 data 都清（唔止 invalidate）——Navbar/總頁即刻唔可以重播舊活動名
    expect(utils.luckyDraw.publicEvents.getData(undefined)).toBeUndefined();
    // status 係 invalidate（標髒重查）：data 仲喺度但已標 invalidated。
    // utils proxy 冇 getQueryKey（v11 query utils 唔包佢），改用真 QueryClient
    // queryCache 按 tRPC key 前綴搵返嗰條 query 斷言（唔係齋信 helper 內部呼叫）。
    const statusEntry = queryClient
      .getQueryCache()
      .getAll()
      .find(
        (q) =>
          Array.isArray(q.queryKey[0]) &&
          (q.queryKey[0] as unknown[]).length === 2 &&
          (q.queryKey[0] as unknown[])[0] === 'luckyDraw' &&
          (q.queryKey[0] as unknown[])[1] === 'publicAnnouncementStatus',
      );
    expect(statusEntry).toBeDefined();
    expect(queryClient.getQueryData(statusEntry!.queryKey)).toEqual({ enabled: true });
    expect(statusEntry!.state.isInvalidated).toBe(true);
  });

  it('查劵 query 完全唔喺 reset 範圍（publicTicketEvent data 原封不動）', () => {
    const { utils } = makeUtils();
    const ticketEvent = {
      event: { id: 7, name: '週年慶', scheduledDrawDate: '20261201', maxWinsPerPerson: 2, winnersPublic: false },
    };
    utils.luckyDraw.publicTicketEvent.setData({ eventId: 7 }, ticketEvent);
    utils.luckyDraw.publicEventResults.setData({ eventId: 7 }, RESULT_7);

    resetLuckyAnnouncementPublicQueries(utils);

    expect(utils.luckyDraw.publicEventResults.getData({ eventId: 7 })).toBeUndefined();
    // 查劵路徑唔受公告總開關影響——cache 都唔准順手清
    expect(utils.luckyDraw.publicTicketEvent.getData({ eventId: 7 })).toBeDefined();
  });
});

// ───────────────────────── holdClosedAnnouncementSeo（fake doc＋fake observer）─────────────────────────

type FakeEl = {
  attrs: Record<string, string>;
  removed: boolean;
  setCount: number;
  removeCount: number;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
};

function fakeEl(): FakeEl {
  return {
    attrs: {},
    removed: false,
    setCount: 0,
    removeCount: 0,
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.setCount += 1;
      this.attrs[name] = value;
    },
    remove() {
      this.removeCount += 1;
      this.removed = true;
    },
  };
}

function makeFakeDoc(withHead = true) {
  const els = new Map<string, FakeEl>();
  const doc = {
    title: '原本頁面標題',
    head: withHead ? ({ fakeHead: true } as const) : undefined,
    querySelector(selector: string): FakeEl | null {
      const el = els.get(selector);
      return el && !el.removed ? el : null;
    },
    /** 模擬 SeoManager／index.html 加（或加返）元素 */
    _add(selector: string): FakeEl {
      const el = fakeEl();
      els.set(selector, el);
      return el;
    },
    _get(selector: string): FakeEl | undefined {
      return els.get(selector);
    },
  };
  return doc;
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  cb: () => void;
  target: unknown;
  options: Record<string, unknown> | undefined;
  disconnected = false;
  constructor(cb: () => void) {
    this.cb = cb;
    FakeObserver.instances.push(this);
  }
  observe(target: unknown, options: Record<string, unknown>) {
    this.target = target;
    this.options = options;
  }
  disconnect() {
    this.disconnected = true;
  }
  /** 模擬瀏覽器 batch 咗 mutations 之後叫 callback */
  trigger() {
    if (!this.disconnected) this.cb();
  }
}

describe('holdClosedAnnouncementSeo（守住完整 title/description/robots/canonical/og:url）', () => {
  beforeEach(() => {
    FakeObserver.instances = [];
  });

  it('即刻寫齊五項：title/description/robots=noindex＋移除 canonical＋移除 og:url', () => {
    const doc = makeFakeDoc();
    const description = doc._add('meta[name="description"]');
    const robots = doc._add('meta[name="robots"]');
    const canonical = doc._add('link[rel="canonical"]');
    const ogUrl = doc._add('meta[property="og:url"]');

    const stop = holdClosedAnnouncementSeo(doc, FakeObserver);

    expect(doc.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE);
    expect(description.attrs.content).toBe(LUCKY_ANNOUNCEMENT_CLOSED_DESCRIPTION);
    expect(robots.attrs.content).toBe(LUCKY_ANNOUNCEMENT_NOINDEX);
    expect(canonical.removed).toBe(true);
    expect(ogUrl.removed).toBe(true);
    // observer 守成個 head：attributes（content/href）＋childList＋characterData＋subtree
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0].target).toBe(doc.head);
    expect(FakeObserver.instances[0].options).toMatchObject({
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['content', 'href'],
    });
    stop();
  });

  it('SeoManager 翻轉任何一項（路由／search 改變後）都即刻還原', () => {
    const doc = makeFakeDoc();
    doc._add('meta[name="description"]');
    doc._add('meta[name="robots"]');
    holdClosedAnnouncementSeo(doc, FakeObserver);
    const observer = FakeObserver.instances[0];

    // 模擬 SeoManager effect（同一路由 search 變化都會重跑）：
    // 寫返公開版 title/description/robots，加返 canonical＋og:url
    doc.title = '中獎公告｜RedCode Fashion Design';
    doc._get('meta[name="description"]')!.setAttribute('content', '公開活動描述');
    doc._get('meta[name="robots"]')!.setAttribute('content', 'index, follow');
    const canonical = doc._add('link[rel="canonical"]');
    canonical.attrs.href = 'https://redcode.red/lucky-results';
    const ogUrl = doc._add('meta[property="og:url"]');
    ogUrl.attrs.content = 'https://redcode.red/lucky-results';

    observer.trigger();

    expect(doc.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE);
    expect(doc._get('meta[name="description"]')!.attrs.content).toBe(LUCKY_ANNOUNCEMENT_CLOSED_DESCRIPTION);
    expect(doc._get('meta[name="robots"]')!.attrs.content).toBe(LUCKY_ANNOUNCEMENT_NOINDEX);
    expect(canonical.removed).toBe(true);
    expect(ogUrl.removed).toBe(true);
  });

  it('防 observer loop：無 drift 時回調零寫入（setAttribute/remove 次數唔再增加）', () => {
    const doc = makeFakeDoc();
    const description = doc._add('meta[name="description"]');
    const robots = doc._add('meta[name="robots"]');
    holdClosedAnnouncementSeo(doc, FakeObserver);
    const observer = FakeObserver.instances[0];
    const writesAfterHold = description.setCount + robots.setCount;

    // 我哋自己嘅寫入／移除都會觸發 observer——值啱就唔准再寫，否則無限 loop
    observer.trigger();
    observer.trigger();

    expect(description.setCount + robots.setCount).toBe(writesAfterHold);
    expect(doc.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE);
  });

  it('stop() 之後唔再還原（組件 unmount／總開關重開）', () => {
    const doc = makeFakeDoc();
    doc._add('meta[name="robots"]');
    const stop = holdClosedAnnouncementSeo(doc, FakeObserver);
    const observer = FakeObserver.instances[0];

    stop();
    expect(observer.disconnected).toBe(true);

    doc._get('meta[name="robots"]')!.setAttribute('content', 'index, follow');
    observer.trigger(); // disconnected：trigger 唔應再翻轉
    expect(doc._get('meta[name="robots"]')!.attrs.content).toBe('index, follow');
  });

  it('冇 head／冇 MutationObserver（SSR／舊環境）：淨係 apply 一次，回傳 noop', () => {
    const noHead = makeFakeDoc(false);
    noHead._add('meta[name="robots"]');
    const stopA = holdClosedAnnouncementSeo(noHead, FakeObserver);
    expect(noHead.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE); // apply 咗一次
    expect(FakeObserver.instances).toHaveLength(0); // 冇 head 唔 observe
    expect(() => stopA()).not.toThrow();

    const withHead = makeFakeDoc();
    withHead._add('meta[name="robots"]');
    const stopB = holdClosedAnnouncementSeo(withHead, undefined);
    expect(withHead.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE);
    expect(FakeObserver.instances).toHaveLength(0);
    expect(() => stopB()).not.toThrow();

    // SSR：連 doc 都冇 → 完全 noop
    expect(() => holdClosedAnnouncementSeo(undefined, undefined)()).not.toThrow();
  });

  it('applyClosedAnnouncementSeo 單用：冇 description/robots 元素都唔會炸（可選鏈）', () => {
    const doc = makeFakeDoc();
    expect(() => applyClosedAnnouncementSeo(doc)).not.toThrow();
    expect(doc.title).toBe(LUCKY_ANNOUNCEMENT_CLOSED_TITLE);
  });
});

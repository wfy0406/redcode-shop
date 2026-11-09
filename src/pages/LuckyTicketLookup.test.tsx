import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFacebookShareUrl } from '@/components/lucky/LuckyPublicActions';
import { isNoIndexPath, PAGE_SEO, resolveSeo } from '@/lib/seo';
import LuckyTicketLookup, {
  formatLuckyDrawDate,
  normalizeTicketHolderName,
  parseLuckyTicketEventId,
} from './LuckyTicketLookup';

const mocks = vi.hoisted(() => ({
  eventQuery: {
    data: null as null | {
      event: {
        id: number;
        name: string;
        scheduledDrawDate: string | null;
        maxWinsPerPerson: number;
        winnersPublic: boolean;
      };
    },
    error: null as null | { message: string },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  lookupMutation: {
    data: null as null | { found: false } | { found: true; ticketCount: number },
    isPending: false,
    isError: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  },
  pushStatusQuery: {
    data: null as null | { optIn: boolean; activeDevices: number },
  },
  utils: {
    push: { myPushStatus: { invalidate: vi.fn() } },
    auth: { me: { invalidate: vi.fn() } },
  },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    useUtils: () => mocks.utils,
    push: {
      myPushStatus: { useQuery: () => mocks.pushStatusQuery },
    },
    luckyDraw: {
      publicTicketEvent: { useQuery: () => mocks.eventQuery },
      publicLookupEventTicket: { useMutation: () => mocks.lookupMutation },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: null }),
}));

vi.mock('@/components/push/PushPermissionGuide', () => ({
  default: () => null,
}));

function setTicketEvent(winnersPublic: boolean) {
  mocks.eventQuery.data = {
    event: {
      id: 12,
      name: '星願直播抽獎之夜',
      scheduledDrawDate: '20261224',
      maxWinsPerPerson: 2,
      winnersPublic,
    },
  };
  mocks.eventQuery.error = null;
  mocks.eventQuery.isLoading = false;
  mocks.eventQuery.isError = false;
}

function stripReactComments(html: string): string {
  return html.replace(/<!--.*?-->/g, '');
}

function renderLookupPage(entry = '/lucky-tickets/12') {
  return renderToString(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/lucky-tickets/:eventId" element={<LuckyTicketLookup />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LuckyTicketLookup helpers 同 SEO', () => {
  it('eventId 只接受正整數；壞 route 唔會打 API', () => {
    expect(parseLuckyTicketEventId('12')).toBe(12);
    expect(parseLuckyTicketEventId('0012')).toBe(12);
    for (const raw of [undefined, '', '0', '-1', '1.5', 'abc', '12abc']) {
      expect(parseLuckyTicketEventId(raw), raw).toBeNull();
    }
  });

  it('預定抽獎日：YYYYMMDD 格式化；null 如實顯示待公佈', () => {
    expect(formatLuckyDrawDate('20261224')).toBe('2026-12-24');
    expect(formatLuckyDrawDate(null)).toBe('待公佈');
  });

  it('完整姓名只 trim 頭尾空白，前端唔改寫內容或大小寫', () => {
    expect(normalizeTicketHolderName('  Chan Tai Man  ')).toBe('Chan Tai Man');
    expect(normalizeTicketHolderName('  陳 小明  ')).toBe('陳 小明');
  });

  it('lucky-tickets 動態 route 有獨立 title/description，而且 noindex', () => {
    expect(resolveSeo('/lucky-tickets/12')).toEqual(PAGE_SEO['/lucky-tickets/:eventId']);
    expect(isNoIndexPath('/lucky-tickets/12')).toBe(true);
  });
});

describe('LuckyTicketLookup 公開頁行為', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    setTicketEvent(true);
    mocks.lookupMutation.data = null;
    mocks.lookupMutation.isPending = false;
    mocks.lookupMutation.isError = false;
    mocks.lookupMutation.mutate.mockReset();
    mocks.lookupMutation.reset.mockReset();
  });

  it('顯示活動全名、日期、限中次數、精確查詢表單及劵數結果；winnersPublic=true 先有公告入口', () => {
    vi.stubGlobal('window', {
      location: { href: 'https://redcode.example/lucky-tickets/12' },
    });
    mocks.lookupMutation.data = { found: true, ticketCount: 3 };

    const html = renderLookupPage();
    const text = stripReactComments(html);

    expect(text).toContain('星願直播抽獎之夜');
    expect(text).toContain('2026-12-24');
    expect(text).toContain('2 次');
    expect(html).toContain('完整姓名');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('maxLength="255"');
    expect(text).toContain('3');
    expect(text).toContain('張抽獎劵');
    expect(html).toContain('/lucky-results/12');
    expect(html).toContain('返回該場中獎名單');
    expect(html).toContain(encodeURIComponent('https://redcode.example/lucky-tickets/12'));
    expect(html).toContain('複製查劵連結');
  });

  it('winnersPublic=false：保留查劵，但完全冇該場中獎名單入口；錯名用通用搵唔到訊息', () => {
    setTicketEvent(false);
    mocks.lookupMutation.data = { found: false };

    const html = renderLookupPage();

    expect(html).toContain('星願直播抽獎之夜');
    expect(html).toContain('搵唔到呢個完整姓名嘅抽獎劵');
    expect(html).not.toContain('/lucky-results/12');
    expect(html).not.toContain('返回該場中獎名單');
    expect(html).not.toContain('查看該場中獎名單');
  });

  it('route／公告連結／私隱邊界源碼回歸：lazy route、指定句子正下方查劵、唔預載或儲存名單', () => {
    const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const resultsSrc = readFileSync(new URL('./LuckyResults.tsx', import.meta.url), 'utf8');
    const lookupSrc = readFileSync(new URL('./LuckyTicketLookup.tsx', import.meta.url), 'utf8');

    expect(appSrc).toContain("lazy(() => import('@/pages/LuckyTicketLookup'))");
    expect(appSrc).toContain('path="lucky-tickets/:eventId"');

    const pendingSentence = resultsSrc.indexOf('呢場仲未開獎');
    const lookupLink = resultsSrc.indexOf('🔍查看睇睇自己有幾張抽獎劵');
    expect(pendingSentence).toBeGreaterThanOrEqual(0);
    expect(lookupLink).toBeGreaterThan(pendingSentence);
    expect(lookupLink - pendingSentence).toBeLessThan(300);
    expect(resultsSrc).toContain('to={`/lucky-tickets/${data.event.id}`}');

    expect(lookupSrc).not.toContain('localStorage');
    expect(lookupSrc).not.toContain('<datalist');
    expect(lookupSrc).toContain('publicLookupEventTicket.useMutation');
    expect(lookupSrc).toContain('autoComplete="off"');
  });

  it('共用分享 CTA 使用當前查劵 URL，唔會改寫做公告 URL', () => {
    const ticketUrl = 'https://redcode.example/lucky-tickets/12?utm_source=test';
    expect(buildFacebookShareUrl(ticketUrl)).toBe(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(ticketUrl)}`,
    );
  });
});

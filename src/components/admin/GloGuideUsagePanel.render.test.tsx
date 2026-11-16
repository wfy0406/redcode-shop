// @vitest-environment happy-dom
/**
 * GloGuideUsagePanel 真互動測試（happy-dom＋真 React render；trpc 全 mock）：
 * ─ 摺疊閘：預設收埋，admin 撳開先出內容，query 要開咗先應該被用（enabled: open）；
 * ─ 權限閘：GloGuidePanel 冇 isAdmin → 用量區完全唔掛載，admin-only query 唔會被 call；
 * ─ 今日／今月／今年卡、免責聲明（估算成本＋歷史生成數）、最近工作表；
 * ─ 成本表單：HK$ 字串→仙、留空＝未知（null）、0＝明確免費、壞輸入擋落嚟；
 * ─ loading／error／empty state。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function kindBucket(over: Record<string, number> = {}) {
  return {
    total: 0,
    completed: 0,
    failed: 0,
    active: 0,
    finishedCostCents: 0,
    reservedCostCents: 0,
    unknownCostJobs: 0,
    ...over,
  };
}

const h = vi.hoisted(() => {
  const state = {
    settings: { imageCostCents: 30, textCostCents: 120 } as {
      imageCostCents: number | null;
      textCostCents: number | null;
    },
    stats: {
      periods: { date: '2026-06-15', month: '2026-06', year: '2026' },
      today: {
        article: kindBucket({ total: 2, completed: 1, failed: 1, finishedCostCents: 240 }),
        regenerate: kindBucket({ total: 1, active: 1, reservedCostCents: 120 }),
        image: kindBucket({
          total: 5,
          completed: 3,
          failed: 1,
          active: 1,
          finishedCostCents: 90,
          reservedCostCents: 30,
          unknownCostJobs: 1,
        }),
      },
      month: {
        article: kindBucket({ total: 8 }),
        regenerate: kindBucket({ total: 2 }),
        image: kindBucket({ total: 20, completed: 18 }),
      },
      year: {
        article: kindBucket({ total: 40 }),
        regenerate: kindBucket({ total: 9 }),
        image: kindBucket({ total: 100, completed: 95 }),
      },
      recentJobs: [
        {
          publicId: 'job-1',
          kind: 'image',
          status: 'failed',
          articleTitle: '夏日 layering 精選',
          error: 'PROVIDER_TIMEOUT: boom',
          estimatedCostCents: 30,
          createdAt: '2026-06-15T03:00:00.000Z',
        },
        {
          publicId: 'job-2',
          kind: 'full',
          status: 'completed',
          articleTitle: '舊文章（冇 snapshot）',
          error: null,
          estimatedCostCents: null,
          createdAt: '2026-06-14T03:00:00.000Z',
        },
      ],
    },
    // 狀態切換用
    settingsLoading: false,
    statsLoading: false,
    statsError: null as string | null,
    saveMut: { mutateAsync: vi.fn(async () => ({ ok: true })), isPending: false },
    usageSettingsCalls: 0,
    usageStatsCalls: 0,
  };
  return state;
});

vi.mock('@/providers/trpc', () => {
  const query = (
    data: unknown,
    opts: { isLoading?: boolean; error?: string | null } = {},
    counter?: 'settings' | 'stats',
  ) => {
    if (counter === 'settings') h.usageSettingsCalls++;
    if (counter === 'stats') h.usageStatsCalls++;
    return {
      data: opts.error ? undefined : data,
      isLoading: opts.isLoading ?? false,
      isError: Boolean(opts.error),
      error: opts.error ? { message: opts.error } : null,
      isFetching: false,
      refetch: vi.fn(async () => ({})),
    };
  };
  return {
    trpc: {
      gloGuideAdmin: {
        // GloGuidePanel 主體需要嘅（articles 列表）
        articles: { useQuery: () => query({ items: [] }) },
        productSources: { useQuery: () => query({ weeks: [], dates: [], sessions: [] }) },
        usageSettings: {
          useQuery: (_input: undefined, options?: { enabled?: boolean }) => {
            const enabled = options?.enabled !== false;
            return query(
              enabled ? h.settings : undefined,
              { isLoading: enabled && h.settingsLoading },
              enabled ? 'settings' : undefined,
            );
          },
        },
        usageStats: {
          useQuery: (_input: undefined, options?: { enabled?: boolean }) => {
            const enabled = options?.enabled !== false;
            return query(
              enabled ? h.stats : undefined,
              { isLoading: enabled && h.statsLoading, error: enabled ? h.statsError : null },
              enabled ? 'stats' : undefined,
            );
          },
        },
        setUsageSettings: { useMutation: () => h.saveMut },
      },
      useUtils: () => ({
        gloGuideAdmin: {
          articles: { invalidate: vi.fn(async () => ({})) },
          usageSettings: { invalidate: vi.fn(async () => ({})) },
          usageStats: { invalidate: vi.fn(async () => ({})) },
        },
      }),
    },
  };
});

import GloGuideUsagePanel, { fmtCents, parseHkdCostField } from './GloGuideUsagePanel';
import GloGuidePanel from './GloGuidePanel';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const toastMock = vi.fn();

async function renderUsage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<GloGuideUsagePanel toast={toastMock} />);
  });
  return container;
}

async function renderMainPanel(isAdmin: boolean | undefined) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      isAdmin === undefined ? (
        <GloGuidePanel toast={toastMock} canReview={true} />
      ) : (
        <GloGuidePanel toast={toastMock} canReview={true} isAdmin={isAdmin} />
      ),
    );
  });
  return container;
}

function btnWith(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`搵唔到按鈕：${text}`);
  return found;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

beforeEach(() => {
  h.settings = { imageCostCents: 30, textCostCents: 120 };
  h.settingsLoading = false;
  h.statsLoading = false;
  h.statsError = null;
  h.usageSettingsCalls = 0;
  h.usageStatsCalls = 0;
  h.saveMut.mutateAsync.mockClear();
  toastMock.mockClear();
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe('純邏輯', () => {
  it('parseHkdCostField：空＝未知（null）；0＝明確免費；正常金額→仙；壞輸入→ok:false', () => {
    expect(parseHkdCostField('')).toEqual({ ok: true, cents: null });
    expect(parseHkdCostField('   ')).toEqual({ ok: true, cents: null });
    expect(parseHkdCostField('0')).toEqual({ ok: true, cents: 0 });
    expect(parseHkdCostField('0.30')).toEqual({ ok: true, cents: 30 });
    expect(parseHkdCostField('1.2')).toEqual({ ok: true, cents: 120 });
    expect(parseHkdCostField('1000')).toEqual({ ok: true, cents: 100000 });
    expect(parseHkdCostField('-1')).toEqual({ ok: false });
    expect(parseHkdCostField('abc')).toEqual({ ok: false });
    expect(parseHkdCostField('1000.01')).toEqual({ ok: false });
  });
  it('fmtCents：null 顯示「未知」（唔准當 HK$0）；0 顯示 HK$0.00', () => {
    expect(fmtCents(null)).toBe('未知');
    expect(fmtCents(0)).toBe('HK$0.00');
    expect(fmtCents(30)).toBe('HK$0.30');
  });
});

describe('用量及估算成本區', () => {
  it('預設收埋：撳「用量及估算成本」先展開，展開先會用 admin query', async () => {
    await renderUsage();
    expect(h.usageSettingsCalls).toBe(0);
    expect(h.usageStatsCalls).toBe(0);
    const toggle = btnWith('用量及估算成本');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle.click();
    });
    expect(btnWith('用量及估算成本').getAttribute('aria-expanded')).toBe('true');
    expect(h.usageSettingsCalls).toBeGreaterThan(0);
    expect(h.usageStatsCalls).toBeGreaterThan(0);
  });

  it('展開後：今日／今月／今年卡＋每類工作數＋免責聲明＋最近工作', async () => {
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    const text = container!.textContent ?? '';
    for (const t of ['今日', '今月', '今年', '完整文章', '文字重生', '配搭圖']) {
      expect(text).toContain(t);
    }
    // 免責聲明：估算成本唔係實收；圖生成數係歷史工作
    expect(text).toContain('實際收費以供應商帳單為準');
    expect(text).toContain('唔等於而家現存圖數');
    // 今日卡數字（image：總數 5／成功 3／失敗 1／生成中 1／未知 1）
    expect(text).toContain('HK$0.90'); // finishedCostCents 90
    // 最近工作表：標題／類型／狀態／成本；舊 job 冇 snapshot → 未知
    expect(text).toContain('夏日 layering 精選');
    expect(text).toContain('文字重生');
    expect(text).toContain('PROVIDER_TIMEOUT: boom');
    expect(text).toContain('未知');
    // 唔會顯示 payload 內容
    expect(text).not.toContain('parentJob');
  });

  it('表單：單價由 API 帶入（30 仙→0.3）；留空儲存＝null；0＝明確免費', async () => {
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    const imgInput = container!.querySelector<HTMLInputElement>('#ggu-image-cost')!;
    const txtInput = container!.querySelector<HTMLInputElement>('#ggu-text-cost')!;
    expect(imgInput.value).toBe('0.3');
    expect(txtInput.value).toBe('1.2');
    // 留空文字價＝未知（null）；圖價改 0.35
    await act(async () => {
      setInputValue(imgInput, '0.35');
      setInputValue(txtInput, '');
    });
    await act(async () => {
      container!.querySelector('form.ggu-form')!.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(h.saveMut.mutateAsync).toHaveBeenCalledWith({ imageCostCents: 35, textCostCents: null });
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('已儲存'), 'success');
  });

  it('壞輸入（負數／超上限／非數字）→ 表單錯誤，mutation 唔會發出', async () => {
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    const imgInput = container!.querySelector<HTMLInputElement>('#ggu-image-cost')!;
    await act(async () => {
      setInputValue(imgInput, '-5');
    });
    await act(async () => {
      container!.querySelector('form.ggu-form')!.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(h.saveMut.mutateAsync).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('留空代表未知');
  });

  it('loading／error／empty state', async () => {
    // loading
    h.statsLoading = true;
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    expect(container!.textContent).toContain('載入用量中');
    await act(async () => root!.unmount());
    container?.remove();
    // error
    h.statsLoading = false;
    h.statsError = 'INTERNAL_SERVER_ERROR: db down';
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    expect(container!.textContent).toContain('載入用量失敗');
    await act(async () => root!.unmount());
    container?.remove();
    // empty：recent 冇工作
    h.statsError = null;
    h.stats = { ...h.stats, recentJobs: [] };
    await renderUsage();
    await act(async () => {
      btnWith('用量及估算成本').click();
    });
    expect(container!.textContent).toContain('暫時未有生成工作紀錄');
  });
});

describe('權限閘（非 admin 唔掛載、唔呼叫）', () => {
  it('GloGuidePanel 冇 isAdmin（或 false）→ 冇用量區，admin query 零呼叫', async () => {
    await renderMainPanel(undefined);
    expect(container!.textContent).not.toContain('用量及估算成本');
    await act(async () => root!.unmount());
    container?.remove();
    await renderMainPanel(false);
    expect(container!.textContent).not.toContain('用量及估算成本');
    expect(h.usageSettingsCalls).toBe(0);
    expect(h.usageStatsCalls).toBe(0);
  });
  it('isAdmin → 用量區摺疊掣出現（預設收埋，唔會自動 call）', async () => {
    await renderMainPanel(true);
    expect(container!.textContent).toContain('用量及估算成本');
    expect(h.usageSettingsCalls).toBe(0);
    expect(h.usageStatsCalls).toBe(0);
  });
});

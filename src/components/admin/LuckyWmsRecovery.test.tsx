// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LuckyWmsRecovery from './LuckyWmsRecovery';

const mocks = vi.hoisted(() => ({
  recover: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
}));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    luckyDraw: {
      adminRecoverWms: { useMutation: () => mocks.recover },
    },
  },
}));

const preview = {
  dryRun: true as const,
  canApply: true,
  reason: null,
  orderId: 101,
  orderNo: 'RC202611110101',
  drawId: 900,
  sync: null,
};

const applied = {
  ...preview,
  dryRun: false as const,
  result: { status: 'sent' as const, lineCount: 1, okCount: 1, lastError: null },
};

let container: HTMLDivElement;
let root: Root;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.recover.isPending = false;
  mocks.recover.mutateAsync.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderRecovery(onRecovered = vi.fn()) {
  await act(async () => {
    root.render(<LuckyWmsRecovery orderId={101} onRecovered={onRecovered} />);
  });
  return onRecovered;
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes(text));
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LuckyWmsRecovery 原位乾跑／確認補送', () => {
  it('第一次撳核查只送 dry-run payload，顯示官網單號，唔會直接補送', async () => {
    mocks.recover.mutateAsync.mockResolvedValueOnce(preview);
    await renderRecovery();

    await click(button('核查 WMS')!);

    expect(mocks.recover.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.recover.mutateAsync).toHaveBeenCalledWith({ orderId: 101, apply: false, confirmWmsAbsent: false });
    expect(container.textContent).toContain('RC202611110101');
    expect(container.textContent).toContain('乾跑唔會改資料');
    expect(button('確認補送呢張單')?.disabled).toBe(true);
  });

  it('未勾 WMS 全無紀錄確認唔可 apply；勾選後 payload 正確，成功只刷新一次', async () => {
    mocks.recover.mutateAsync.mockResolvedValueOnce(preview).mockResolvedValueOnce(applied);
    const onRecovered = await renderRecovery();
    await click(button('核查 WMS')!);

    const applyButton = button('確認補送呢張單')!;
    expect(applyButton.disabled).toBe(true);
    await click(applyButton);
    expect(mocks.recover.mutateAsync).toHaveBeenCalledTimes(1);

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(button('確認補送呢張單')!.disabled).toBe(false);
    await click(button('確認補送呢張單')!);

    expect(mocks.recover.mutateAsync).toHaveBeenNthCalledWith(2, { orderId: 101, apply: true, confirmWmsAbsent: true });
    expect(container.textContent).toContain('補送結果：sent（1/1 件）');
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('blocked preview 顯示原因，完全冇 checkbox 或補送入口', async () => {
    mocks.recover.mutateAsync.mockResolvedValueOnce({
      ...preview,
      canApply: false,
      reason: '已有成功 WMS 收單 ID：請人手對數，唔好重送',
      sync: {
        status: 'partial', lineCount: 2, okCount: 1, attempts: 1,
        lastError: '[wms-auto:v1] HTTP 500', webhookOrderIds: [777], updatedAt: null,
      },
    });
    await renderRecovery();
    await click(button('核查 WMS')!);

    expect(container.textContent).toContain('已有成功 WMS 收單 ID');
    expect(container.textContent).toContain('777');
    expect(button('確認補送呢張單')).toBeUndefined();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(mocks.recover.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('重新乾跑 API error 可見，並即時收起舊 preview 嘅補送入口', async () => {
    mocks.recover.mutateAsync.mockResolvedValueOnce(preview);
    await renderRecovery();
    await click(button('核查 WMS')!);
    expect(button('確認補送呢張單')).toBeDefined();

    mocks.recover.mutateAsync.mockRejectedValueOnce(new Error('同步狀態暫時讀取失敗'));
    await click(button('重新乾跑')!);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('同步狀態暫時讀取失敗');
    expect(button('確認補送呢張單')).toBeUndefined();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(mocks.recover.mutateAsync).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LuckyPrizePicker from './LuckyPrizePicker';
import { displayRemainingOf, remainingOf, type Prize } from '@/lib/luckyPrizeStock';

const prize = (id: number, quantity: number, takenCount: number, active = true): Prize => ({
  id,
  name: `獎品 ${id}`,
  sku: `SKU-${id}`,
  price: id * 100,
  imagePath: null,
  session: '',
  active,
  quantity,
  takenCount,
  drawCount: takenCount,
  takenBy: null,
});

let container: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPicker(onSelect = vi.fn(), locked = false) {
  const rows = [prize(1, 5, 2), prize(2, 2, 2), prize(3, 1, 0), prize(4, 9, 0, false)];
  await act(async () => {
    root.render(
      <LuckyPrizePicker
        prizes={rows}
        prizeNos={new Map(rows.map((row, index) => [row.id, index + 1]))}
        selectedPrizeId={1}
        locked={locked}
        onSelect={onSelect}
      />,
    );
  });
  return onSelect;
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('LuckyPrizePicker 逐款真實庫存', () => {
  it('每款顯示剩餘件數；已抽晒留低但停用，下架款唔出現', async () => {
    const onSelect = await renderPicker();
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons).toHaveLength(3);
    expect(container.textContent).toContain('剩 3 件');
    expect(container.textContent).toContain('剩 0 件');
    expect(container.textContent).toContain('剩 1 件');
    expect(container.textContent).toContain('已抽晒');
    expect(container.textContent).not.toContain('獎品 4');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].disabled).toBe(true);

    await click(buttons[1]);
    expect(onSelect).not.toHaveBeenCalled();
    await click(buttons[2]);
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('開獎中鎖住全部款，唔會途中轉獎', async () => {
    const onSelect = await renderPicker(vi.fn(), true);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await click(buttons[0]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('舊 server 冇新欄位時沿用一件制，負數只顯示 0', () => {
    const old = prize(9, 1, 0);
    // 模擬舊 API 回應欠缺 quantity／takenCount。
    // @ts-expect-error 刻意模擬舊 server payload
    delete old.quantity;
    // @ts-expect-error 刻意模擬舊 server payload
    delete old.takenCount;
    expect(remainingOf(old)).toBe(1);
    expect(remainingOf(prize(10, 1, 3))).toBe(-2);
    expect(displayRemainingOf(prize(10, 1, 3))).toBe(0);
  });
});

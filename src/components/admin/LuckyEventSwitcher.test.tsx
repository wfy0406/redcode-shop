// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LuckyEventSwitcher, { type DrawEvent } from './LuckyEventSwitcher';

const event = (id: number, archived = false): DrawEvent => ({
  id,
  name: `抽獎活動 ${id}`,
  maxWinsPerPerson: 1,
  scheduledDrawDate: '20261111',
  winnersPublic: id % 2 === 0,
  entryCount: id * 10,
  totalTickets: id * 20,
  drawnCount: id,
  archivedAt: archived ? '2026-11-11T12:00:00Z' : null,
  archivedByName: null,
  createdAt: '2026-11-01T12:00:00Z',
  createdByName: null,
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

async function renderSwitcher(selectedEventId: number | null, onSelectEvent = vi.fn()) {
  const events = Array.from({ length: 12 }, (_, index) => event(index + 1, index === 10));
  await act(async () => {
    root.render(<LuckyEventSwitcher events={events} selectedEventId={selectedEventId} onSelectEvent={onSelectEvent} />);
  });
  return { events, onSelectEvent };
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.textContent?.includes(text));
}

describe('LuckyEventSwitcher 目前活動摘要＋原位展開', () => {
  it('12 個活動預設只顯示目前一場；展開可揀另一場，揀完即收', async () => {
    const { onSelectEvent } = await renderSwitcher(1);
    expect(container.textContent).toContain('抽獎活動 1');
    expect(container.textContent).not.toContain('抽獎活動 2');
    expect(container.querySelector('[role="group"]')).toBeNull();

    const toggle = button('揀活動（12）')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(container.querySelectorAll('[role="group"] button')).toHaveLength(12);
    expect(container.textContent).toContain('抽獎活動 2');
    expect(container.textContent).toContain('[已歸檔]');

    await click(button('抽獎活動 7')!);
    expect(onSelectEvent).toHaveBeenCalledWith(7);
    expect(container.querySelector('[role="group"]')).toBeNull();

    // controlled 合約：父層跟返新 id，摘要即轉第 7 場。
    const events = Array.from({ length: 12 }, (_, index) => event(index + 1, index === 10));
    await act(async () => {
      root.render(<LuckyEventSwitcher events={events} selectedEventId={7} onSelectEvent={onSelectEvent} />);
    });
    expect(container.textContent).toContain('抽獎活動 7');
    expect(container.textContent).not.toContain('抽獎活動 2');
  });

  it('未揀活動時直接展開索引，所有選項都係可聚焦原生按鈕', async () => {
    await renderSwitcher(null);
    const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button'));
    expect(options).toHaveLength(12);
    expect(options.every((option) => option.type === 'button')).toBe(true);
    expect(container.querySelector('[aria-controls]')?.getAttribute('aria-expanded')).toBe('true');
  });
});

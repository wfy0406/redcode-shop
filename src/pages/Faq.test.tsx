// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Faq from './Faq';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderFaq(initialEntry: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Faq />
      </MemoryRouter>,
    );
  });
  const target = document.getElementById('app-install') as HTMLElement | null;
  expect(target).not.toBeNull();
  const scrollIntoView = vi.fn();
  target!.scrollIntoView = scrollIntoView;
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  return { target: target!, scrollIntoView };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('常見問題 — APP 安裝短網址落點', () => {
  it('/faq#app-install 自動捲到現有安裝區', async () => {
    const { target, scrollIntoView } = await renderFaq('/faq#app-install');
    expect(target.id).toBe('app-install');
    expect(target.textContent).toContain('RedCode APP');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  });

  it('一般 /faq 唔會無故捲走訪客', async () => {
    const { scrollIntoView } = await renderFaq('/faq');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

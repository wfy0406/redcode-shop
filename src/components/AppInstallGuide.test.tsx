// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import AppInstallGuide from './AppInstallGuide';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro) AppleWebKit/537.36 Chrome/142.0.0.0 Mobile Safari/537.36';
const SAMSUNG_INTERNET =
  'Mozilla/5.0 (Linux; Android 16; SM-S9280) AppleWebKit/537.36 SamsungBrowser/29.0 Chrome/130.0.0.0 Mobile Safari/537.36';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
}

async function renderGuide(userAgent: string) {
  setUserAgent(userAgent);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AppInstallGuide />);
  });
}

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('常見問題 — Android Chrome-only 安裝入口', () => {
  it('Chrome Android 直接顯示安裝按鈕，唔會繞去 intent', async () => {
    await renderGuide(CHROME_ANDROID);
    const button = Array.from(container!.querySelectorAll('button')).find((node) =>
      node.textContent?.includes('安裝 RedCode APP'),
    );
    expect(button).toBeDefined();
    expect(container!.querySelector('a[href^="intent://"]')).toBeNull();
    expect(container!.textContent).toContain('Android 必須使用最新版 Chrome 安裝');
    expect(container!.textContent).toContain('可能要幾分鐘');
  });

  it('非 Chrome Android 顯示固定 Chrome intent，去 RedCode 安裝頁', async () => {
    await renderGuide(SAMSUNG_INTERNET);
    const link = container!.querySelector<HTMLAnchorElement>('a[href^="intent://"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain('用 Chrome 開啟並安裝');
    expect(link!.href).toContain('intent://redcode.red/app#Intent');
    expect(link!.href).toContain('package=com.android.chrome');
    expect(link!.href).toContain('S.browser_fallback_url=https%3A%2F%2Fredcode.red%2Fapp');
    expect(container!.textContent).toContain('Samsung Internet／其他瀏覽器');
    expect(container!.textContent).toContain('如果按鈕冇反應');
    expect(container!.textContent).toContain('redcode.red/app');
    expect(container!.textContent).toContain('會直接去到安裝位置');
  });
});

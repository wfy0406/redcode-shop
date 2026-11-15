/**
 * App 路由級 Suspense 測試（v2026.11.16 公開 QA CLS 修正）：
 *
 * 背景：直開 /glo-guide/:slug 時 lazy chunk 未返，外層共用 Suspense 接管，
 * 成個 Layout（Navbar/Footer）被 PageLoading 取代再還原 → CLS 0.55 desktop／0.48 mobile。
 * 修正：淨係 glo-guide list/detail 兩條 route 用 route-level Suspense 包住 lazy element，
 * chunk 載入時只有 outlet 內容落 fallback，Layout/Footer 保持 mounted。
 * 第二部：fallback 係 GuideRouteLoading（PageLoading 外面包 minHeight:100dvh），
 * loading 期間 outlet 撐足一屏，Footer 由一開始就喺首屏以下，唔會先出現再被推走。
 *
 * 行為測試（happy-dom＋createRoot，mock Layout/Home/seo＋永遠 suspend 嘅 guide 頁）：
 * - 直開 /glo-guide/:slug：chunk 未返 Layout＋Footer 仍然在場，fallback 有 100dvh 撐高
 * - 直開 /glo-guide：同上
 *
 * 源碼守衛（防回歸／防越界）：
 * - 只有 glo-guide 兩條 route 有 route-level Suspense；其他 routes 維持外層共用 Suspense
 * - GuideRouteLoading 定義保留 minHeight:'100dvh'＋原樣重用 PageLoading
 */

// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Outlet } from 'react-router';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 永遠 pending：模擬 guide chunk 仲載入緊（throw thenable ＝ suspend）
const NEVER = new Promise<never>(() => {});
const suspending = () => {
  throw NEVER;
};

vi.mock('@/components/Layout', () => ({
  default: () => (
    <div data-testid="layout">
      <header data-testid="navbar">NAV</header>
      <Outlet />
      <footer data-testid="footer">FOOTER</footer>
    </div>
  ),
}));
vi.mock('@/lib/seo', () => ({ SeoManager: () => null }));
vi.mock('@/pages/Home', () => ({ default: () => <div>HOME</div> }));
vi.mock('@/pages/GloGuideList', () => ({ default: suspending }));
vi.mock('@/pages/GloGuideDetail', () => ({ default: suspending }));

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderAt(url: string): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <App />
      </MemoryRouter>,
    );
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('App：glo-guide route-level Suspense（CLS 修正）', () => {
  it('直開 /glo-guide/:slug：chunk 未返時 Layout＋Footer 唔卸走，fallback 有 100dvh 撐高 outlet', async () => {
    const container = await renderAt('/glo-guide/test-slug');
    // 修正前：外層 Suspense 接管 → 呢兩個會消失
    expect(container.querySelector('[data-testid="layout"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="navbar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="footer"]')).toBeTruthy();
    // route-level fallback 照樣有（用戶有載入回饋）
    const loading = container.querySelector('[role="status"]');
    expect(loading?.getAttribute('aria-label')).toBe('頁面載入中');
    // PageLoading 外面包住 100dvh 撐高層：loading 時 Footer 由一開始就喺首屏以下
    const wrapper = loading?.parentElement;
    expect(wrapper?.style.minHeight).toBe('100dvh');
  });

  it('直開 /glo-guide：chunk 未返時 Layout＋Footer 同樣保持 mounted，fallback 有 100dvh', async () => {
    const container = await renderAt('/glo-guide');
    expect(container.querySelector('[data-testid="layout"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="footer"]')).toBeTruthy();
    const loading = container.querySelector('[role="status"]');
    expect(loading?.getAttribute('aria-label')).toBe('頁面載入中');
    expect(loading?.parentElement?.style.minHeight).toBe('100dvh');
  });

  it('源碼守衛：只有 glo-guide 兩條 route 有 route-level Suspense，外層共用 Suspense 不變', () => {
    const src = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'App.tsx'), 'utf8');
    // 外層共用 Suspense 仍然包住全部 Routes（其他 routes 行為不變）
    expect(src).toContain('<Suspense fallback={<PageLoading />}>\n        <Routes>');
    // glo-guide 兩條 route 明確包住 lazy element，fallback 用 GuideRouteLoading（100dvh 撐高）
    expect(src).toContain('path="glo-guide" element={<Suspense fallback={<GuideRouteLoading />}><GloGuideList /></Suspense>}');
    expect(src).toContain('path="glo-guide/:slug" element={<Suspense fallback={<GuideRouteLoading />}><GloGuideDetail /></Suspense>}');
    // 全檔 Suspense 邊界總數 ＝ 外層 1 ＋ route-level 2（唔准偷偷包其他 route）
    expect(src.split('<Suspense').length - 1).toBe(3);
    // GuideRouteLoading 定義：minHeight:'100dvh' 撐高層＋原樣重用 PageLoading（唔准改薄）
    const def = src.slice(src.indexOf('function GuideRouteLoading'), src.indexOf('/**\n * Routing contract'));
    expect(def).toContain("minHeight: '100dvh'");
    expect(def).toContain('<PageLoading />');
  });
});

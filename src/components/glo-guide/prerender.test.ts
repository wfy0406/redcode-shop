/**
 * Glo Guide prerender 生命周期測試（2026-11-19 R01）。
 *
 * 重現嘅問題：舊流程 App mount 即移除首口文章區塊（慢網絡下全版文章消失，
 * CLS ≈1.0），兼靠 inline <script> 首次繪畫前收起（CSP script-src 白名單以外，
 * 被擋兼報 violation）。
 *
 * 驗證嘅修復：
 * ─ App mount 只清非 glo-guide 注入；glo-guide 文章區塊保持可見（唔加 display:none）；
 * ─ pending 期間區塊可搬入 outlet 原位（adopt），重複呼叫安全；
 * ─ 容器 unmount 後節點由模組 hold 住，下個 pending 容器可原樣再領養（圖唔重新下載）；
 * ─ 真資料 commit／NOT_FOUND／轉頁後 discard 永久移除（幂等，包括被領養中嘅節點）。
 */

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptGloGuidePrerender,
  discardGloGuidePrerender,
  findGloGuidePrerender,
  hasGloGuidePrerender,
  removeNonGuidePrerenderBlocks,
} from './prerender';

function injectBlocks() {
  document.body.innerHTML = [
    '<div id="root"></div>',
    '<main id="redcode-glo-guide-seo" data-redcode-prerender="glo-guide"><h1>真文章標題</h1><img src="/uploads/glo-guide/a.png" /></main>',
    '<section id="redcode-public-seo" data-redcode-prerender><h1>首頁摘要</h1></section>',
  ].join('');
}

beforeEach(() => {
  // 每個測試重新注入；模組 heldNode 用 discard 清零
  injectBlocks();
  discardGloGuidePrerender();
  document.body.innerHTML = '';
  injectBlocks();
});

describe('R01：App mount 唔再即刪 glo-guide 文章', () => {
  it('removeNonGuidePrerenderBlocks 只清非指南注入，文章區塊保持可見', () => {
    removeNonGuidePrerenderBlocks();
    expect(document.querySelector('#redcode-public-seo')).toBeNull();
    const guide = document.querySelector<HTMLElement>('#redcode-glo-guide-seo');
    expect(guide).not.toBeNull();
    // 慢網絡保命核心：冇任何節點被 inline 收起
    expect(guide!.style.display).not.toBe('none');
    expect(guide!.isConnected).toBe(true);
  });
});

describe('R01 pending 領養／交接', () => {
  it('adopt 將文章搬入 outlet 容器；重複呼叫安全', () => {
    const outlet = document.createElement('div');
    document.querySelector('#root')!.appendChild(outlet);
    const node = findGloGuidePrerender()!;
    adoptGloGuidePrerender(outlet);
    expect(node.parentElement).toBe(outlet);
    expect(node.isConnected).toBe(true);
    // 再叫一次唔會複製、唔會搬第兩次
    adoptGloGuidePrerender(outlet);
    expect(outlet.querySelectorAll('[data-redcode-prerender="glo-guide"]')).toHaveLength(1);
  });

  it('容器脫離文件後（Suspense 交接／轉頁），下個容器可原樣再領養同一節點', () => {
    const first = document.createElement('div');
    document.querySelector('#root')!.appendChild(first);
    adoptGloGuidePrerender(first);
    const node = findGloGuidePrerender()!;
    // 模擬 React 容器 unmount：成個容器連內容脫離 document
    first.remove();
    expect(node.isConnected).toBe(false);
    // held ref 仲在：新 pending 容器領養返同一節點（圖片元素同一個，唔會重新下載）
    const second = document.createElement('div');
    document.querySelector('#root')!.appendChild(second);
    adoptGloGuidePrerender(second);
    expect(findGloGuidePrerender()).toBe(node);
    expect(node.parentElement).toBe(second);
    expect(node.isConnected).toBe(true);
  });
});

describe('R01 真資料 commit／轉頁清理', () => {
  it('discard 永久移除文章區塊，幂等', () => {
    expect(hasGloGuidePrerender()).toBe(true);
    discardGloGuidePrerender();
    expect(hasGloGuidePrerender()).toBe(false);
    expect(document.querySelector('#redcode-glo-guide-seo')).toBeNull();
    discardGloGuidePrerender(); // 第二次唔會炸
    expect(hasGloGuidePrerender()).toBe(false);
  });

  it('discard 連被領養中（或暫時脫離）嘅區塊都清到', () => {
    const outlet = document.createElement('div');
    document.querySelector('#root')!.appendChild(outlet);
    adoptGloGuidePrerender(outlet);
    outlet.remove(); // 脫離文件，只剩 held ref
    discardGloGuidePrerender();
    expect(hasGloGuidePrerender()).toBe(false);
  });
});

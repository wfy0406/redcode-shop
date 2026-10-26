/**
 * v2.2.59 首頁 trio 互動純邏輯測試（src/lib/homeFairy.ts）
 * 覆蓋契約：
 *  - 事件名固定 'redcode:home-fairy'（全站聯動靠佢，唔准改名）
 *  - isTapKey：Enter／Space 當點按，其他鍵唔觸發
 *  - isHomeFairyDetail：外部聯動事件 runtime 驗證（壞 detail 一律唔受）
 *  - trioContainerClass：shy/tap/paused 修飾 class 合成（對應 index.css 選擇器）
 *  - emitHomeFairy：冇 window 靜默 false；有 window 派 CustomEvent 兼補 at
 */
import { describe, expect, it } from 'vitest';
import {
  HOME_FAIRY_EVENT,
  TRIO_TAP_MS,
  emitHomeFairy,
  isHomeFairyDetail,
  isTapKey,
  trioContainerClass,
} from './homeFairy';

describe('HOME_FAIRY_EVENT 契約', () => {
  it('事件名固定 redcode:home-fairy', () => {
    expect(HOME_FAIRY_EVENT).toBe('redcode:home-fairy');
  });

  it('tap one-shot 長度 ≥ 0.9s 動畫（glo-delight）', () => {
    expect(TRIO_TAP_MS).toBeGreaterThanOrEqual(900);
  });
});

describe('isTapKey（keyboard 互動）', () => {
  it('Enter 觸發', () => {
    expect(isTapKey('Enter')).toBe(true);
  });

  it('Space 觸發（新舊 key 值都收）', () => {
    expect(isTapKey(' ')).toBe(true);
    expect(isTapKey('Spacebar')).toBe(true);
  });

  it('其他鍵唔觸發', () => {
    expect(isTapKey('a')).toBe(false);
    expect(isTapKey('Escape')).toBe(false);
    expect(isTapKey('Tab')).toBe(false);
  });
});

describe('isHomeFairyDetail（聯動事件驗證）', () => {
  it('收合法 detail', () => {
    expect(isHomeFairyDetail({ action: 'tap', source: 'left', at: 123 })).toBe(true);
    expect(isHomeFairyDetail({ action: 'shy-start', source: 'fairy', at: 0 })).toBe(true);
    expect(isHomeFairyDetail({ action: 'shy-end', source: 'right', at: 1 })).toBe(true);
  });

  it('x/y viewport 座標可選；有就一定要係 finite number', () => {
    expect(isHomeFairyDetail({ action: 'tap', source: 'left', at: 1, x: 320, y: 480 })).toBe(true);
    expect(isHomeFairyDetail({ action: 'tap', source: 'left', at: 1, x: Number.NaN })).toBe(false);
    expect(isHomeFairyDetail({ action: 'tap', source: 'left', at: 1, y: '100' })).toBe(false);
  });

  it('拒絕壞 detail', () => {
    expect(isHomeFairyDetail(null)).toBe(false);
    expect(isHomeFairyDetail(undefined)).toBe(false);
    expect(isHomeFairyDetail('tap')).toBe(false);
    expect(isHomeFairyDetail({ action: 'explode', source: 'left', at: 1 })).toBe(false);
    expect(isHomeFairyDetail({ action: 'tap', source: 'middle', at: 1 })).toBe(false);
    expect(isHomeFairyDetail({ action: 'tap', source: 'left' })).toBe(false);
    expect(isHomeFairyDetail({ action: 'tap', source: 'left', at: 'now' })).toBe(false);
  });
});

describe('trioContainerClass', () => {
  it('基準淨係 trio', () => {
    expect(trioContainerClass({ shy: null, tapping: false, paused: false })).toBe('trio');
  });

  it('怕羞修飾跟成員', () => {
    expect(trioContainerClass({ shy: 'left', tapping: false, paused: false })).toBe(
      'trio trio-shy-left',
    );
    expect(trioContainerClass({ shy: 'right', tapping: false, paused: false })).toBe(
      'trio trio-shy-right',
    );
  });

  it('tap＋paused 修飾可以疊加', () => {
    expect(trioContainerClass({ shy: null, tapping: true, paused: false })).toBe('trio trio-tap');
    expect(trioContainerClass({ shy: null, tapping: false, paused: true })).toBe('trio trio-paused');
    expect(trioContainerClass({ shy: 'fairy', tapping: true, paused: true })).toBe(
      'trio trio-shy-fairy trio-tap trio-paused',
    );
  });
});

describe('emitHomeFairy', () => {
  it('node 環境（冇 window）靜默 false，唔會 throw', () => {
    expect(emitHomeFairy({ action: 'tap', source: 'left' })).toBe(false);
  });

  it('有 window 就派 CustomEvent 兼補 at 時間戳', () => {
    const received: unknown[] = [];
    const fakeWindow = {
      dispatchEvent(e: unknown) {
        received.push(e);
        return true;
      },
    };
    const g = globalThis as { window?: unknown; CustomEvent?: unknown };
    const hadWindow = 'window' in g;
    const oldWindow = g.window;
    const oldCustomEvent = g.CustomEvent;
    g.window = fakeWindow;
    // node 20+ 有 CustomEvent；冇就用簡單 polyfill 頂住測試
    if (typeof g.CustomEvent !== 'function') {
      g.CustomEvent = class {
        type: string;
        detail: unknown;
        constructor(type: string, init?: { detail?: unknown }) {
          this.type = type;
          this.detail = init?.detail;
        }
      };
    }
    try {
      const before = Date.now();
      expect(emitHomeFairy({ action: 'shy-start', source: 'fairy', x: 120, y: 240 })).toBe(true);
      expect(received).toHaveLength(1);
      const e = received[0] as {
        type: string;
        detail: { action: string; source: string; at: number; x?: number; y?: number };
      };
      expect(e.type).toBe('redcode:home-fairy');
      expect(e.detail.action).toBe('shy-start');
      expect(e.detail.source).toBe('fairy');
      expect(e.detail.at).toBeGreaterThanOrEqual(before);
      // viewport 座標要原樣帶過去（全域小精靈飛行落腳點用）
      expect(e.detail.x).toBe(120);
      expect(e.detail.y).toBe(240);
    } finally {
      if (hadWindow) g.window = oldWindow;
      else delete g.window;
      g.CustomEvent = oldCustomEvent;
    }
  });
});

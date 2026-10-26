import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_STEP_ORDER,
  FAIRY_STEP_TARGET_SELECTORS,
  TRYON_GUIDE_EVENT,
  anchorToTarget,
  approachPoint,
  buildStepStates,
  clampFairyPosition,
  computePanelLayout,
  computeTryOnStep,
  fairyOverlapsRect,
  fallbackPerch,
  hoverDrift,
  parseHomeFairyReaction,
  parseTryOnGuideAction,
  restPosition,
  type TryOnSignals,
} from './globalFairyGuide';

const sig = (patch: Partial<TryOnSignals>): TryOnSignals => ({ ...EMPTY_TRYON_SIGNALS, ...patch });

describe('試穿五步狀態機（computeTryOnStep）', () => {
  it('未影相 → photo', () => {
    expect(computeTryOnStep(sig({}))).toBe('photo');
    expect(computeTryOnStep(sig({ selectionCount: 2 }))).toBe('photo');
  });

  it('有相未揀款 → product', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true }))).toBe('product');
  });

  it('有相有款未提交 → generate', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1 }))).toBe('generate');
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 2 }))).toBe('generate');
  });

  it('生成緊（queued/processing）→ 停喺 generate，唔准跳步', () => {
    expect(
      computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobActive: true })),
    ).toBe('generate');
  });

  it('生成失敗（job 存在但未 completed）→ 指返 generate（結果區有重試掣）', () => {
    expect(
      computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true })),
    ).toBe('generate');
  });

  it('生成完成未分享 → share', () => {
    expect(
      computeTryOnStep(
        sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobCompleted: true, purchasePresent: true }),
      ),
    ).toBe('share');
  });

  it('分享咗、有購買區 → purchase', () => {
    expect(
      computeTryOnStep(
        sig({
          hasPhoto: true,
          selectionCount: 1,
          jobPresent: true,
          jobCompleted: true,
          shareActed: true,
          purchasePresent: true,
        }),
      ),
    ).toBe('purchase');
  });

  it('完成但冇購買區、已分享 → 留喺 share（唔會假裝有下一步）', () => {
    expect(
      computeTryOnStep(
        sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobCompleted: true, shareActed: true }),
      ),
    ).toBe('share');
  });

  it('結果區出現但選擇被清走 → 唔會跌返 product（job 存在即已進入生成階段）', () => {
    expect(
      computeTryOnStep(sig({ hasPhoto: true, selectionCount: 0, jobPresent: true, jobCompleted: true })),
    ).toBe('share');
  });
});

describe('步驟列表狀態（buildStepStates）', () => {
  it('順序固定五步', () => {
    expect(FAIRY_STEP_ORDER).toEqual(['photo', 'product', 'generate', 'share', 'purchase']);
  });

  it('current 之前 done、之後 todo，淨係一個 current', () => {
    const states = buildStepStates('generate');
    expect(states.map((s) => s.status)).toEqual(['done', 'done', 'current', 'todo', 'todo']);
    expect(states.filter((s) => s.status === 'current')).toHaveLength(1);
  });

  it('第一步同最後一步都正確', () => {
    expect(buildStepStates('photo').map((s) => s.status)).toEqual(['current', 'todo', 'todo', 'todo', 'todo']);
    expect(buildStepStates('purchase').map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'current']);
  });
});

describe('目標選擇器合約', () => {
  it('每一步首選都係 data-fairy-target 合約，之後先係 TryOn 現有 class', () => {
    for (const step of FAIRY_STEP_ORDER) {
      const selectors = FAIRY_STEP_TARGET_SELECTORS[step];
      expect(selectors[0]).toBe(`[data-fairy-target="${step}"]`);
      expect(selectors.length).toBeGreaterThan(1);
    }
  });

  it('fallback 對應而家 TryOn DOM 實際 class', () => {
    expect(FAIRY_STEP_TARGET_SELECTORS.photo).toContain('.tryon-photo-panel .tryon-camera-controls');
    expect(FAIRY_STEP_TARGET_SELECTORS.product).toContain('.tryon-product-panel .tryon-contact-sheet');
    expect(FAIRY_STEP_TARGET_SELECTORS.generate).toContain('.tryon-submit-zone .tryon-generate-button');
    expect(FAIRY_STEP_TARGET_SELECTORS.share).toContain('.tryon-share-actions');
    expect(FAIRY_STEP_TARGET_SELECTORS.purchase).toContain('[data-testid="tryon-purchase"] .tryon-purchase-buy');
  });
});

describe('位置夾取同飛行（唔出 viewport、冇橫向 overflow）', () => {
  const viewport = { w: 390, h: 844 }; // iPhone 直放
  const fairy = { w: 96, h: 48 };

  it('clamp：負數同爆界都夾返入嚟', () => {
    expect(clampFairyPosition({ x: -50, y: 9999 }, viewport, fairy)).toEqual({
      x: 8,
      y: 844 - 48 - 8,
    });
  });

  it('viewport 細過小精靈都唔會負數', () => {
    const clamped = clampFairyPosition({ x: 5, y: 5 }, { w: 60, h: 40 }, fairy);
    expect(clamped.x).toBeGreaterThanOrEqual(8);
    expect(clamped.y).toBeGreaterThanOrEqual(8);
  });

  it('休息位喺 viewport 左下之內', () => {
    const rest = restPosition(viewport, fairy);
    expect(rest.x).toBeGreaterThanOrEqual(0);
    expect(rest.y).toBeGreaterThanOrEqual(0);
    expect(rest.x + fairy.w).toBeLessThanOrEqual(viewport.w);
    expect(rest.y + fairy.h).toBeLessThanOrEqual(viewport.h);
  });

  it('anchorToTarget：無論目標喺邊，落腳點都喺 viewport 之內', () => {
    const rects = [
      { left: 0, top: 0, width: 200, height: 60 },
      { left: 380, top: 800, width: 10, height: 44 },
      { left: 150, top: 400, width: 90, height: 44 },
    ];
    for (const rect of rects) {
      const p = anchorToTarget(rect, viewport, fairy);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + fairy.w).toBeLessThanOrEqual(viewport.w);
      expect(p.y + fairy.h).toBeLessThanOrEqual(viewport.h);
    }
  });

  it('anchorToTarget：手機 clamp 後都唔准覆蓋實際目標按鈕', () => {
    // 掃勻成個 viewport 嘅網格目標（細掣、長條、半版大卡）
    const rects = [
      { left: 0, top: 0, width: 390, height: 44 }, // 頂部全闊條
      { left: 0, top: 780, width: 390, height: 64 }, // 底部 sticky 結帳欄
      { left: 8, top: 300, width: 374, height: 220 }, // 半版大卡
      { left: 290, top: 96, width: 92, height: 44 }, // 右上角細掣
      { left: 0, top: 400, width: 60, height: 60 }, // 貼左邊掣
      { left: 330, top: 400, width: 60, height: 60 }, // 貼右邊掣
      { left: 147, top: 398, width: 96, height: 48 }, // 同小精靈一樣大嘅正中央掣
    ];
    for (const rect of rects) {
      const p = anchorToTarget(rect, viewport, fairy);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + fairy.w).toBeLessThanOrEqual(viewport.w);
      expect(p.y + fairy.h).toBeLessThanOrEqual(viewport.h);
      expect(fairyOverlapsRect(p, fairy, rect)).toBe(false);
    }
  });

  it('anchorToTarget：目標大過成個 viewport → 冇位可避，返回預設休息位', () => {
    const fullScreen = { left: 0, top: 0, width: 390, height: 844 };
    expect(anchorToTarget(fullScreen, viewport, fairy)).toEqual(restPosition(viewport, fairy));
  });

  it('fallbackPerch：目標佔咗左下休息位 → 揀另一個唔冚目標嘅角落', () => {
    const bottomLeft = { left: 0, top: 640, width: 260, height: 204 };
    const p = fallbackPerch(bottomLeft, viewport, fairy);
    expect(fairyOverlapsRect(p, fairy, bottomLeft)).toBe(false);
    expect(p).not.toEqual(restPosition(viewport, fairy));
  });

  it('fairyOverlapsRect：邊界判定', () => {
    const rect = { left: 100, top: 100, width: 50, height: 50 };
    expect(fairyOverlapsRect({ x: 90, y: 90 }, fairy, rect)).toBe(true); // 右下伸入
    expect(fairyOverlapsRect({ x: 150, y: 100 }, fairy, rect)).toBe(false); // 啱啱貼右邊唔算
    expect(fairyOverlapsRect({ x: 100, y: 150 }, fairy, rect)).toBe(false); // 啱啱貼底唔算
    expect(fairyOverlapsRect({ x: 0, y: 0 }, fairy, rect)).toBe(false); // 完全離開
  });

  it('approachPoint：向目標收斂、唔會走返轉頭', () => {
    const start = { x: 0, y: 0 };
    const target = { x: 100, y: 100 };
    const mid = approachPoint(start, target, 0.1);
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(100);
    const near = approachPoint(mid, target, 10);
    expect(near.x).toBeCloseTo(100, 0);
  });

  it('hoverDrift：幅度細（±10px 內），唔會推小精靈出界好多', () => {
    for (const t of [0, 1.3, 7.7, 123.4]) {
      const d = hoverDrift(t);
      expect(Math.abs(d.x)).toBeLessThanOrEqual(6);
      expect(Math.abs(d.y)).toBeLessThanOrEqual(8);
    }
  });
});

describe('面板擺位（computePanelLayout）', () => {
  const viewport = { w: 390, h: 844 };
  const panel = { w: 320, h: 300 };

  it('小精靈喺左邊、桌面夠位 → 面板放右側', () => {
    const desktop = { w: 1280, h: 800 };
    const p = computePanelLayout({ x: 16, y: 700 }, { w: 96, h: 48 }, panel, desktop);
    expect(p.x).toBeGreaterThan(96);
  });

  it('手機左右都擺唔落 → 面板放小精靈頭頂，而且唔出界', () => {
    const p = computePanelLayout({ x: 16, y: 700 }, { w: 96, h: 48 }, panel, viewport);
    expect(p.y + panel.h).toBeLessThanOrEqual(700);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + panel.w).toBeLessThanOrEqual(viewport.w);
  });

  it('小精靈喺右邊 → 面板轉放左側，而且唔出界', () => {
    const p = computePanelLayout({ x: 300, y: 700 }, { w: 96, h: 48 }, panel, viewport);
    expect(p.x + panel.w).toBeLessThanOrEqual(viewport.w);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + panel.h).toBeLessThanOrEqual(viewport.h);
  });

  it('面板闊過 viewport 時夾返窄', () => {
    const p = computePanelLayout({ x: 16, y: 700 }, { w: 96, h: 48 }, { w: 999, h: 300 }, viewport);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + (viewport.w - 16)).toBeLessThanOrEqual(viewport.w);
  });
});

describe('首頁互動事件解析（parseHomeFairyReaction）', () => {
  it('認得 celebrate 同 shy（計劃書版）', () => {
    expect(parseHomeFairyReaction({ action: 'celebrate' })).toEqual({ action: 'celebrate' });
    expect(parseHomeFairyReaction({ action: 'shy' })).toEqual({ action: 'shy' });
  });

  it('認得首頁 trio 版：tap→celebrate、shy-start→shy、shy-end 唔使反應', () => {
    expect(parseHomeFairyReaction({ action: 'tap', source: 'fairy', at: 123 })).toEqual({ action: 'celebrate' });
    expect(parseHomeFairyReaction({ action: 'shy-start', source: 'left', at: 123 })).toEqual({ action: 'shy' });
    expect(parseHomeFairyReaction({ action: 'shy-end', source: 'right', at: 456 })).toBeNull();
  });

  it('合法 x/y 座標會保留', () => {
    expect(parseHomeFairyReaction({ action: 'celebrate', x: 120.5, y: 640 })).toEqual({
      action: 'celebrate',
      x: 120.5,
      y: 640,
    });
  });

  it('唔識嘅 action／壞 detail 一律返回 null，唔會炸', () => {
    expect(parseHomeFairyReaction(null)).toBeNull();
    expect(parseHomeFairyReaction(undefined)).toBeNull();
    expect(parseHomeFairyReaction('celebrate')).toBeNull();
    expect(parseHomeFairyReaction({ action: 'dance' })).toBeNull();
    expect(parseHomeFairyReaction({})).toBeNull();
  });

  it('非 finite 或非數字座標會被丟棄，動作仍生效', () => {
    expect(parseHomeFairyReaction({ action: 'shy', x: Number.NaN, y: '700' })).toEqual({ action: 'shy' });
    expect(parseHomeFairyReaction({ action: 'celebrate', x: Infinity, y: -Infinity })).toEqual({
      action: 'celebrate',
    });
  });
});

describe('TryOn 進度事件解析（parseTryOnGuideAction）', () => {
  it('事件名固定 redcode:tryon-guide', () => {
    expect(TRYON_GUIDE_EVENT).toBe('redcode:tryon-guide');
  });

  it('淨係認 share／purchase', () => {
    expect(parseTryOnGuideAction({ action: 'share' })).toBe('share');
    expect(parseTryOnGuideAction({ action: 'purchase' })).toBe('purchase');
  });

  it('壞 detail 一律 null，唔會假裝完成', () => {
    expect(parseTryOnGuideAction(null)).toBeNull();
    expect(parseTryOnGuideAction(undefined)).toBeNull();
    expect(parseTryOnGuideAction('share')).toBeNull();
    expect(parseTryOnGuideAction({ action: 'click' })).toBeNull();
    expect(parseTryOnGuideAction({ action: 'purchase', extra: 1 })).toBe('purchase');
    expect(parseTryOnGuideAction({})).toBeNull();
  });
});

// 源碼防退化（2026-10-26 第二輪 blocker）：share/purchase 完成狀態唔准再用 broad
// capture-phase click 推測（容器空白 click 都會誤記＝假進度）。呢個測試直接掃
// GlobalFairyGuide.tsx 源碼，一旦有人加返 click 监听或 broad closest 即刻紅。
describe('源碼防退化：唔准 reintroduce broad closest 記進度', () => {
  const source = readFileSync(new URL('./GlobalFairyGuide.tsx', import.meta.url), 'utf8');

  it('組件用 TRYON_GUIDE_EVENT 監聽明確成功事件', () => {
    expect(source).toContain('TRYON_GUIDE_EVENT');
    expect(source).toMatch(/addEventListener\(TRYON_GUIDE_EVENT/);
  });

  it('冇任何 click listener（capture-phase 推測已廢除）', () => {
    expect(source).not.toMatch(/addEventListener\(['"]click['"]/);
  });

  it('冇 broad share/purchase 容器 closest 匹配', () => {
    expect(source).not.toContain(".tryon-share-actions button");
    expect(source).not.toContain('.tryon-purchase-buy');
    expect(source).not.toContain('.tryon-purchase-cart');
    expect(source).not.toContain('.tryon-purchase-add-one');
  });
});

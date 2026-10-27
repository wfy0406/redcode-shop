import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_DRAG_RETURN_MS,
  FAIRY_DRAG_THRESHOLD_PX,
  FAIRY_FLIGHT_STALL_WINDOW_FRAMES,
  FAIRY_STEP_ORDER,
  FAIRY_STEP_TARGET_SELECTORS,
  TRYON_GUIDE_EVENT,
  advanceFairyFlight,
  chooseFairyPlacement,
  clampFairyPosition,
  computeBubbleLayout,
  computeTryOnStep,
  expandRect,
  fairyOverlapsRect,
  fairyEscapeTarget,
  fairyPointSafe,
  getFairyRouteGuide,
  intersectRect,
  parseTryOnGuideAction,
  restPosition,
  shouldStartFairyDrag,
  shouldStopStalledFlight,
  visibleActionRect,
  type FairyRect,
  type FairySize,
  type TryOnSignals,
} from './globalFairyGuide';

const sig = (patch: Partial<TryOnSignals>): TryOnSignals => ({ ...EMPTY_TRYON_SIGNALS, ...patch });

function expectInside(point: { x: number; y: number }, size: FairySize, viewport: FairySize) {
  expect(point.x).toBeGreaterThanOrEqual(0);
  expect(point.y).toBeGreaterThanOrEqual(0);
  expect(point.x + size.w).toBeLessThanOrEqual(viewport.w);
  expect(point.y + size.h).toBeLessThanOrEqual(viewport.h);
}

describe('TryOn 真實流程狀態機', () => {
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

  it('生成中唔跳步', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobActive: true }))).toBe('generate');
  });

  it('失敗後指返生成／重試流程；已有購買區都唔會搶先', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true }))).toBe('generate');
    expect(computeTryOnStep(sig({
      hasPhoto: true,
      selectionCount: 2,
      jobPresent: true,
      jobCompleted: false,
      purchasePresent: true,
    }))).toBe('generate');
  });

  it('完成未分享 → share', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobCompleted: true, purchasePresent: true }))).toBe('share');
  });

  it('真分享成功後有購買區 → purchase', () => {
    expect(computeTryOnStep(sig({
      hasPhoto: true,
      selectionCount: 1,
      jobPresent: true,
      jobCompleted: true,
      shareActed: true,
      purchasePresent: true,
    }))).toBe('purchase');
  });

  it('冇購買區唔會假裝有下一步', () => {
    expect(computeTryOnStep(sig({ hasPhoto: true, selectionCount: 1, jobPresent: true, jobCompleted: true, shareActed: true }))).toBe('share');
  });

  it('加車成功後指去真購物車連結，唔再循環推購買', () => {
    expect(computeTryOnStep(sig({
      hasPhoto: true,
      selectionCount: 1,
      jobPresent: true,
      jobCompleted: true,
      shareActed: true,
      purchasePresent: true,
      purchaseActed: true,
    }))).toBe('cart');
    expect(FAIRY_STEP_TARGET_SELECTORS.cart[0]).toContain('.tryon-purchase-view-cart');
  });
});

describe('真控制 selector 同 route-aware 目錄', () => {
  it('流程順序保持', () => {
    expect(FAIRY_STEP_ORDER).toEqual(['photo', 'product', 'generate', 'share', 'purchase', 'cart']);
  });

  it('每步指真控制，唔再指成塊 panel', () => {
    expect(FAIRY_STEP_TARGET_SELECTORS.photo[0]).toContain('button');
    expect(FAIRY_STEP_TARGET_SELECTORS.product[0]).toContain('.tryon-product-card');
    expect(FAIRY_STEP_TARGET_SELECTORS.generate).toContain('.tryon-submit-zone .tryon-generate-button');
    expect(FAIRY_STEP_TARGET_SELECTORS.share[0]).toContain('button');
    expect(FAIRY_STEP_TARGET_SELECTORS.purchase[0]).toContain('.tryon-purchase-cart');
    expect(FAIRY_STEP_TARGET_SELECTORS.photo).not.toContain('.tryon-photo-panel');
    expect(FAIRY_STEP_TARGET_SELECTORS.product).not.toContain('.tryon-product-panel');
  });

  it('購買步優先加車，唔會優先推即買', () => {
    const selectors = FAIRY_STEP_TARGET_SELECTORS.purchase.join(' | ');
    expect(selectors.indexOf('.tryon-purchase-cart')).toBeLessThan(selectors.indexOf('.tryon-purchase-buy'));
  });

  it('Home 只讀現有 CTA，唔需要改 Home', () => {
    const guide = getFairyRouteGuide('/');
    expect(guide.candidates[0].selectors).toContain('main [data-fairy-target="home-cta"]');
  });

  it('商品列表只指搜尋及分類；普通商品卡唔再被導覽圈圈住', () => {
    const selectors = getFairyRouteGuide('/products').candidates.flatMap((item) => item.selectors);
    expect(selectors).toContain('main input[aria-label="搜尋商品"]');
    expect(selectors).toContain('main [role="group"][aria-label="商品類別篩選"] button');
    expect(selectors).not.toContain('main article a[href^="/products/"]');
  });

  it('商品詳情優先現有 AI 試穿入口', () => {
    const guide = getFairyRouteGuide('/products/85');
    expect(guide.candidates[0].selectors).toContain('main a[href^="/try-on?productId="]');
  });

  it('TryOn 按目前步驟揀目標', () => {
    const guide = getFairyRouteGuide('/try-on', 'share');
    expect(guide.candidates).toHaveLength(1);
    expect(guide.candidates[0].id).toBe('tryon-share');
    expect(guide.candidates[0].selectors).toEqual(FAIRY_STEP_TARGET_SELECTORS.share);
  });

  it('TryOn 未登入降級做真登入入口', () => {
    const guide = getFairyRouteGuide('/try-on', 'photo', { tryOnAccess: true });
    expect(guide.candidates).toHaveLength(1);
    expect(guide.candidates[0].selectors).toContain('main .tryon-access-card a.tryon-primary-link');
  });

  it('充值開單後進入 quiet 模式，唔圈付款控制', () => {
    const guide = getFairyRouteGuide('/wallet-topup', 'photo', { walletPayment: true });
    expect(guide.quiet).toBe(true);
    expect(guide.candidates).toEqual([]);
  });

  it.each(['/checkout', '/guest-checkout', '/payment', '/guest-payment', '/receipt/123'])('%s 只留守唔干擾金流', (pathname) => {
    const guide = getFairyRouteGuide(pathname);
    expect(guide.quiet).toBe(true);
    expect(guide.candidates).toEqual([]);
  });

  it('中獎公告指現有活動連結', () => {
    const guide = getFairyRouteGuide('/lucky-results');
    expect(guide.candidates[0].selectors).toContain('main a.lr-event-link[href^="/lucky-results/"]');
  });
});

describe('可見面積同 viewport 夾取', () => {
  const viewport = { w: 390, h: 844 };
  const fairy = { w: 66, h: 111 };

  it('clamp 保留完整精靈喺畫面內', () => {
    const point = clampFairyPosition({ x: -50, y: 9999 }, viewport, fairy);
    expectInside(point, fairy, viewport);
    expect(point.x).toBe(12);
    expect(point.y).toBe(844 - 111 - 12);
  });

  it('極細 viewport 都唔回負座標', () => {
    const point = clampFairyPosition({ x: -10, y: -10 }, { w: 40, h: 50 }, fairy);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
  });

  it('intersectRect 回真實交集', () => {
    expect(intersectRect(
      { left: -20, top: 10, width: 100, height: 50 },
      { left: 0, top: 0, width: 390, height: 844 },
    )).toEqual({ left: 0, top: 10, width: 80, height: 50 });
  });

  it('完全離屏唔可指', () => {
    expect(visibleActionRect({ left: 20, top: -100, width: 120, height: 44 }, viewport)).toBeNull();
    expect(visibleActionRect({ left: 500, top: 100, width: 120, height: 44 }, viewport)).toBeNull();
  });

  it('只露少少邊都唔假裝可指', () => {
    expect(visibleActionRect({ left: 20, top: -39, width: 120, height: 44 }, viewport)).toBeNull();
  });

  it('有足夠可見面積先回可見 rect', () => {
    expect(visibleActionRect({ left: 20, top: -10, width: 120, height: 44 }, viewport)).toEqual({
      left: 20,
      top: 0,
      width: 120,
      height: 34,
    });
  });

  it('導覽目標只計 header 以下可見區，唔會穿越 sticky 導覽列', () => {
    const contentBounds = { left: 0, top: 80, width: 390, height: 764 };
    expect(visibleActionRect(
      { left: 20, top: 60, width: 200, height: 100 },
      viewport,
      contentBounds,
    )).toEqual({ left: 20, top: 80, width: 200, height: 80 });
    expect(visibleActionRect(
      { left: 20, top: 20, width: 200, height: 44 },
      viewport,
      contentBounds,
    )).toBeNull();
  });

  it('休息位完整喺 viewport 右下角，唔再寫錯去左下', () => {
    const rest = restPosition(viewport, fairy);
    expectInside(rest, fairy, viewport);
    expect(rest.x).toBe(viewport.w - fairy.w - 16);
    expect(rest.y).toBe(viewport.h - fairy.h - 64);
  });
});

describe('碰撞安全：目標、header、浮鈕及 dock', () => {
  const viewport = { w: 390, h: 844 };
  const fairy = { w: 66, h: 111 };

  it('目標喺不同位置都完整避開目標', () => {
    const targets: FairyRect[] = [
      { left: 0, top: 80, width: 390, height: 44 },
      { left: 0, top: 780, width: 390, height: 64 },
      { left: 8, top: 300, width: 374, height: 180 },
      { left: 290, top: 120, width: 92, height: 44 },
      { left: 0, top: 400, width: 60, height: 60 },
      { left: 330, top: 400, width: 60, height: 60 },
    ];
    for (const target of targets) {
      const placement = chooseFairyPlacement({ viewport, fairy, target });
      expect(placement).not.toBeNull();
      expectInside(placement!.point, fairy, viewport);
      expect(fairyOverlapsRect(placement!.point, fairy, expandRect(target, 5))).toBe(false);
    }
  });

  it('header 整體係禁區，唔會撞 logo', () => {
    const header = { left: 0, top: 0, width: 1280, height: 72 };
    const target = { left: 80, top: 110, width: 200, height: 52 };
    const placement = chooseFairyPlacement({ viewport: { w: 1280, h: 800 }, fairy: { w: 86, h: 144 }, target, obstacles: [header] });
    expect(placement).not.toBeNull();
    expect(fairyOverlapsRect(placement!.point, { w: 86, h: 144 }, header)).toBe(false);
  });

  it('冇目標時安全 dock 避開 WhatsApp／Messenger', () => {
    const obstacles: FairyRect[] = [
      { left: 312, top: 764, width: 56, height: 56 },
      { left: 312, top: 684, width: 56, height: 56 },
    ];
    const placement = chooseFairyPlacement({ viewport, fairy, obstacles });
    expect(placement).not.toBeNull();
    expect(placement!.nearTarget).toBe(false);
    for (const obstacle of obstacles) expect(fairyOverlapsRect(placement!.point, fairy, obstacle)).toBe(false);
  });

  it('無可見導覽目標時由內容中間返回右下；右下被浮鈕佔用就揀最近安全位', () => {
    const current = { x: 173, y: 411 };
    const rest = restPosition(viewport, fairy);
    expect(chooseFairyPlacement({ viewport, fairy, current, obstacles: [], preferRest: true })?.point).toEqual(rest);

    const blockingFloatButton = {
      left: rest.x - 4,
      top: rest.y - 4,
      width: fairy.w + 8,
      height: fairy.h + 8,
    };
    const moved = chooseFairyPlacement({
      viewport,
      fairy,
      current,
      obstacles: [blockingFloatButton],
      preferRest: true,
    });
    expect(moved).not.toBeNull();
    expect(moved!.point).not.toEqual(current);
    expect(fairyOverlapsRect(moved!.point, fairy, blockingFloatButton)).toBe(false);
  });

  it('scroll 新幀舊位仍安全就保持；真相撞先重新掃位', () => {
    const current = { x: 173, y: 411 };
    expect(chooseFairyPlacement({ viewport, fairy, current, obstacles: [] })?.point).toEqual(current);
    const collision = { left: current.x - 2, top: current.y - 2, width: fairy.w + 4, height: fairy.h + 4 };
    const moved = chooseFairyPlacement({ viewport, fairy, current, obstacles: [collision] });
    expect(moved).not.toBeNull();
    expect(moved!.point).not.toEqual(current);
    expect(fairyOverlapsRect(moved!.point, fairy, collision)).toBe(false);
  });

  it('右側被撞時揀最近安全出口，唔會無故閃去最左 dock', () => {
    const current = { x: 308, y: 400 };
    const collision = { left: 300, top: 390, width: 90, height: 140 };
    const placement = chooseFairyPlacement({ viewport, fairy, current, obstacles: [collision] });
    expect(placement).not.toBeNull();
    expect(placement!.point.x).toBeGreaterThan(200);
    expect(Math.hypot(placement!.point.x - current.x, placement!.point.y - current.y)).toBeLessThan(130);
    expect(fairyOverlapsRect(placement!.point, fairy, collision)).toBe(false);
  });

  it('全部位置被冚就回 null，唔硬放喺控制上面', () => {
    const full = { left: 0, top: 0, width: 390, height: 844 };
    expect(chooseFairyPlacement({ viewport, fairy, obstacles: [full] })).toBeNull();
    expect(chooseFairyPlacement({ viewport, fairy, target: full })).toBeNull();
  });

  it('密集頁只用完整畫面掃位，唔靠放寬碰撞硬冚商品', () => {
    const denseViewport = { w: 400, h: 800 };
    const denseFairy = { w: 60, h: 100 };
    const obstacles: FairyRect[] = [
      { left: 0, top: 0, width: 170, height: 800 },
      { left: 270, top: 0, width: 130, height: 800 },
      { left: 170, top: 0, width: 100, height: 330 },
      { left: 170, top: 480, width: 100, height: 320 },
    ];
    const placement = chooseFairyPlacement({ viewport: denseViewport, fairy: denseFairy, obstacles });
    expect(placement).not.toBeNull();
    for (const obstacle of obstacles) {
      expect(fairyOverlapsRect(placement!.point, denseFairy, obstacle)).toBe(false);
    }
  });
});

describe('時間制連續飛行', () => {
  const viewport = { w: 390, h: 844 };
  const fairy = { w: 66, h: 111 };

  it('相同時間拆成高刷新率細步，距離一致而且唔會瞬移', () => {
    const current = { x: 12, y: 400 };
    const target = { x: 312, y: 400 };
    const one = advanceFairyFlight({ current, target, viewport, fairy, deltaMs: 32, maxSpeed: 600 });
    let two = current;
    for (let index = 0; index < 2; index += 1) {
      two = advanceFairyFlight({ current: two, target, viewport, fairy, deltaMs: 16, maxSpeed: 600 });
    }
    expect(two.x).toBeCloseTo(one.x, 8);
    expect(two.y).toBeCloseTo(one.y, 8);
    expect(Math.hypot(one.x - current.x, one.y - current.y)).toBeLessThanOrEqual(19.2 + 0.0001);

    const capped = advanceFairyFlight({ current, target, viewport, fairy, deltaMs: 1000, maxSpeed: 600 });
    expect(Math.hypot(capped.x - current.x, capped.y - current.y)).toBeLessThanOrEqual(24 + 0.0001);
    expect(advanceFairyFlight({ current, target, viewport, fairy, deltaMs: 0 })).toEqual(current);
  });

  it('尺寸恢復時安全邊距修正唔會疊加成超步', () => {
    const current = { x: 322, y: 467.67 };
    const next = advanceFairyFlight({
      current,
      target: { x: 312, y: 120 },
      viewport,
      fairy,
      deltaMs: 40,
      maxSpeed: 960,
    });
    expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeLessThanOrEqual(38.4 + 0.0001);
    expectInside(next, fairy, viewport);
  });

  it('跨屏長距離都係一串有限細步，最後連續到達目標', () => {
    const target = { x: 312, y: 120 };
    let current = { x: 12, y: 700 };
    let frames = 0;
    for (; frames < 240 && Math.hypot(target.x - current.x, target.y - current.y) > 0.5; frames += 1) {
      const next = advanceFairyFlight({ current, target, viewport, fairy, deltaMs: 16.67, maxSpeed: 720 });
      expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeLessThanOrEqual(720 * 16.67 / 1000 + 0.001);
      expectInside(next, fairy, viewport);
      current = next;
    }
    expect(frames).toBeGreaterThan(20);
    expect(frames).toBeLessThan(240);
    expect(Math.hypot(target.x - current.x, target.y - current.y)).toBeLessThanOrEqual(0.5);
  });

  it('直線受阻會繞行，每一段都唔穿過商品障礙物', () => {
    const obstacle = { left: 150, top: 300, width: 90, height: 200 };
    const target = { x: 312, y: 400 };
    let current = { x: 12, y: 400 };
    let frames = 0;
    for (; frames < 360 && Math.hypot(target.x - current.x, target.y - current.y) > 0.5; frames += 1) {
      const next = advanceFairyFlight({
        current, target, viewport, fairy, obstacles: [obstacle], deltaMs: 16.67, maxSpeed: 720,
      });
      expect(fairyOverlapsRect(next, fairy, obstacle)).toBe(false);
      expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeLessThanOrEqual(720 * 16.67 / 1000 + 0.001);
      current = next;
    }
    expect(frames).toBeLessThan(360);
    expect(Math.hypot(target.x - current.x, target.y - current.y)).toBeLessThanOrEqual(0.5);
  });

  it('滾動內容被動撞上時，可向安全目標連續脫離', () => {
    const obstacle = { left: 0, top: 0, width: 120, height: 120 };
    const current = { x: 40, y: 40 };
    const target = { x: 250, y: 250 };
    const next = advanceFairyFlight({
      current,
      target,
      viewport,
      fairy,
      obstacles: [obstacle],
      deltaMs: 16.67,
      maxSpeed: 720,
    });
    expect(next).not.toEqual(current);
    expect(next.x).toBeGreaterThan(current.x);
    expect(next.y).toBeGreaterThan(current.y);
    expect(Math.hypot(target.x - next.x, target.y - next.y)).toBeLessThan(Math.hypot(target.x - current.x, target.y - current.y));
  });

  it('桌面多段文字部分包圍時，會向右上安全位脫困而唔係向左卡住', () => {
    const desktopViewport = { w: 1280, h: 800 };
    const desktopFairy = { w: 80, h: 80 * 768 / 458 };
    // 1280×800 真 Chromium 內層滑動個案嘅精簡幾何；舊規則會由 x≈35 向左卡住。
    const obstacles: FairyRect[] = [
      { left: 43, top: 545.3125, width: 163.015625, height: 74.25 },
      { left: 43, top: 625.5625, width: 183.015625, height: 67.546875 },
      { left: 43, top: 698.109375, width: 82.015625, height: 27 },
      { left: 23.265625, top: 716.984375, width: 106.015625, height: 34 },
      { left: 23.265625, top: 736.984375, width: 106.015625, height: 34 },
    ];
    const target = { x: 236, y: 620 };
    let current = { x: 34.91890005787396, y: 653.8515283842795 };
    let frames = 0;
    for (; frames < 120 && Math.hypot(target.x - current.x, target.y - current.y) > 0.5; frames += 1) {
      const next = advanceFairyFlight({
        current, target, viewport: desktopViewport, fairy: desktopFairy, obstacles, deltaMs: 16.67, maxSpeed: 1200,
      });
      expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeLessThanOrEqual(1200 * 16.67 / 1000 + 0.001);
      expect(fairyOverlapsRect(next, desktopFairy, obstacles[0])).toBe(false);
      current = next;
    }
    expect(frames).toBeLessThan(120);
    expect(Math.hypot(target.x - current.x, target.y - current.y)).toBeLessThanOrEqual(0.5);
    for (const obstacle of obstacles) expect(fairyOverlapsRect(current, desktopFairy, obstacle)).toBe(false);
  });

  it('脫困只豁免起點已碰撞障礙，唔會撞入新障礙', () => {
    const initial = { left: 0, top: 0, width: 120, height: 120 };
    const incoming = { left: 150, top: 140, width: 70, height: 180 };
    const target = { x: 312, y: 400 };
    let current = { x: 40, y: 40 };
    let frames = 0;
    for (; frames < 360 && Math.hypot(target.x - current.x, target.y - current.y) > 0.5; frames += 1) {
      const next = advanceFairyFlight({
        current, target, viewport, fairy, obstacles: [initial, incoming], deltaMs: 16.67, maxSpeed: 720,
      });
      expect(fairyOverlapsRect(next, fairy, incoming)).toBe(false);
      expect(Math.hypot(next.x - current.x, next.y - current.y)).toBeLessThanOrEqual(720 * 16.67 / 1000 + 0.001);
      current = next;
    }
    expect(frames).toBeLessThan(360);
    expect(Math.hypot(target.x - current.x, target.y - current.y)).toBeLessThanOrEqual(0.5);
  });

  it('完全藏喺大圖入面都會連續向邊緣脫困，唔會原地卡死', () => {
    const obstacle = { left: 0, top: 0, width: 300, height: 300 };
    const target = { x: 312, y: 40 };
    let current = { x: 40, y: 40 };
    let frames = 0;
    const overlapArea = (point: { x: number; y: number }) => {
      const overlap = intersectRect({ left: point.x, top: point.y, width: fairy.w, height: fairy.h }, obstacle);
      return overlap ? overlap.width * overlap.height : 0;
    };
    for (; frames < 60 && fairyOverlapsRect(current, fairy, obstacle); frames += 1) {
      const next = advanceFairyFlight({
        current, target, viewport, fairy, obstacles: [obstacle], deltaMs: 16.67, maxSpeed: 720,
      });
      expect(next).not.toEqual(current);
      expect(overlapArea(next)).toBeLessThanOrEqual(overlapArea(current) + 0.01);
      current = next;
    }
    expect(frames).toBeLessThan(60);
    expect(fairyOverlapsRect(current, fairy, obstacle)).toBe(false);
  });
});

describe('非 modal 小氣泡擺位', () => {
  it('氣泡完整喺 viewport，唔冚精靈或 header', () => {
    const viewport = { w: 1280, h: 800 };
    const fairy = { x: 16, y: 600 };
    const fairySize = { w: 86, h: 144 };
    const bubble = { w: 256, h: 150 };
    const header = { left: 0, top: 0, width: 1280, height: 72 };
    const point = computeBubbleLayout(fairy, fairySize, bubble, viewport, [header]);
    expect(point).not.toBeNull();
    expectInside(point!, bubble, viewport);
    expect(fairyOverlapsRect(point!, bubble, expandRect({ left: fairy.x, top: fairy.y, width: fairySize.w, height: fairySize.h }, 4))).toBe(false);
  });

  it('手機氣泡會夾返入畫面', () => {
    const viewport = { w: 390, h: 844 };
    const point = computeBubbleLayout({ x: 16, y: 650 }, { w: 66, h: 111 }, { w: 256, h: 150 }, viewport);
    expect(point).not.toBeNull();
    expectInside(point!, { w: 256, h: 150 }, viewport);
  });

  it('常用角落冇位會掃完整畫面，唔好即刻放棄真安全位', () => {
    const viewport = { w: 400, h: 800 };
    const bubble = { w: 120, h: 100 };
    const obstacles: FairyRect[] = [
      { left: 0, top: 0, width: 268, height: 800 },
      { left: 388, top: 0, width: 12, height: 800 },
      { left: 268, top: 0, width: 120, height: 300 },
      { left: 268, top: 400, width: 120, height: 400 },
    ];
    const point = computeBubbleLayout({ x: 16, y: 650 }, { w: 66, h: 111 }, bubble, viewport, obstacles);
    expect(point).toEqual({ x: 268, y: 300 });
    for (const obstacle of obstacles) {
      expect(fairyOverlapsRect(point!, bubble, obstacle)).toBe(false);
    }
  });

  it('32px 網格之間嘅窄縫都會用障礙物邊緣搵到，唔會誤判無位', () => {
    const viewport = { w: 240, h: 240 };
    const bubble = { w: 80, h: 60 };
    const obstacles: FairyRect[] = [
      { left: 0, top: 0, width: 240, height: 101 },
      { left: 0, top: 161, width: 240, height: 79 },
    ];
    // 唯一安全位置係 y=101..161；舊網格 y=12,44,76,108… 全部會撞。
    const point = computeBubbleLayout({ x: 12, y: 12 }, { w: 30, h: 40 }, bubble, viewport, obstacles);
    expect(point).toEqual({ x: 12, y: 101 });
    for (const obstacle of obstacles) {
      expect(fairyOverlapsRect(point!, bubble, obstacle)).toBe(false);
    }
  });

  it('冇安全位就唔強行顯示', () => {
    const full = { left: 0, top: 0, width: 390, height: 844 };
    expect(computeBubbleLayout({ x: 16, y: 650 }, { w: 66, h: 111 }, { w: 256, h: 150 }, { w: 390, h: 844 }, [full])).toBeNull();
  });

  // 真手機模擬（375×667、pointer:coarse）/products 實測障礙物幾何：
  // header、頂部 WhatsApp/Messenger、搜尋、排序、類別兩行、日期篩選三行、
  // 指定日期 input、首兩行文字、「24 件商品」、右下 WhatsApp/Messenger 浮鈕。
  // 呢組幾何曾令 full→short→compact 全部冇位而 100% denied；micro 192×52 必須搵到真安全位。
  const TRUE_MOBILE_PRODUCTS_OBSTACLES: FairyRect[] = [
    { left: -8, top: -8, width: 391, height: 76 }, // header（擴 8）
    { left: 200, top: 2.5, width: 56, height: 54 }, // 頂部 WhatsApp
    { left: 146, top: 2.5, width: 56, height: 54 }, // 頂部 Messenger
    { left: 290, top: 582, width: 66, height: 66 }, // 右下 WhatsApp
    { left: 290, top: 518, width: 66, height: 66 }, // 右下 Messenger
    { left: 28, top: 244, width: 319, height: 58 }, // 搜尋商品
    { left: 64, top: 304, width: 154, height: 58 }, // 商品排序
    { left: 15, top: 381, width: 70, height: 50.8 }, // 全部
    { left: 83, top: 381, width: 70, height: 50.8 }, // 上衣
    { left: 151, top: 381, width: 57, height: 50.8 }, // 褲
    { left: 206, top: 381, width: 57, height: 50.8 }, // 裙
    { left: 261, top: 381, width: 57, height: 50.8 }, // 鞋
    { left: 15, top: 429.8, width: 70, height: 50.8 }, // 飾物
    { left: 83, top: 429.8, width: 96, height: 50.8 }, // 生活用品
    { left: 177, top: 429.8, width: 83, height: 50.8 }, // 護膚品
    { left: 258, top: 429.8, width: 70, height: 50.8 }, // 其他
    { left: 83, top: 482.5, width: 88, height: 45 }, // 全部日期
    { left: 169, top: 482.5, width: 88, height: 45 }, // 今日上架
    { left: 255, top: 482.5, width: 85.6, height: 45 }, // 近 3 日
    { left: 15, top: 525.5, width: 85.6, height: 45 }, // 近 7 日
    { left: 98.6, top: 525.5, width: 64, height: 45 }, // 較早
    { left: 73, top: 568.5, width: 143, height: 42 }, // 揀選指定上架日期
    { left: 15, top: 120, width: 207.5, height: 43 }, // pick your star ✦
    { left: 15, top: 164, width: 130, height: 43 }, // 全部商品
    { left: 15, top: 624.5, width: 26.8, height: 29 }, // 24 件商品（首段）
    { left: 31.8, top: 624.5, width: 60.4, height: 29 }, // 24 件商品（次段）
  ];
  const trueMobileViewport = { w: 375, h: 667 };
  const trueMobileFairy = { x: 293, y: 96 };
  const trueMobileFairySize = { w: 66, h: 110.7 };

  it('真手機 /products 幾何：full、short、compact 甚至 192×56 都真係冇位', () => {
    for (const size of [{ w: 224, h: 143 }, { w: 224, h: 104 }, { w: 192, h: 80 }, { w: 192, h: 56 }]) {
      expect(computeBubbleLayout(
        trueMobileFairy, trueMobileFairySize, size, trueMobileViewport, TRUE_MOBILE_PRODUCTS_OBSTACLES,
      )).toBeNull();
    }
  });

  it('真手機 /products 幾何：micro 192×52 搵到完整安全位，唔撞任何障礙物或精靈', () => {
    const micro = { w: 192, h: 52 };
    const point = computeBubbleLayout(
      trueMobileFairy, trueMobileFairySize, micro, trueMobileViewport, TRUE_MOBILE_PRODUCTS_OBSTACLES,
    );
    expect(point).not.toBeNull();
    expectInside(point!, micro, trueMobileViewport);
    for (const obstacle of TRUE_MOBILE_PRODUCTS_OBSTACLES) {
      expect(fairyOverlapsRect(point!, micro, obstacle)).toBe(false);
    }
    const fairyRect = expandRect({
      left: trueMobileFairy.x, top: trueMobileFairy.y,
      width: trueMobileFairySize.w, height: trueMobileFairySize.h,
    }, 4);
    expect(fairyOverlapsRect(point!, micro, fairyRect)).toBe(false);
    // 安全帶喺 header（底 68）同首行文字（頂 120）之間。
    expect(point!.y).toBeGreaterThanOrEqual(68);
    expect(point!.y + micro.h).toBeLessThanOrEqual(120);
  });
});

describe('TryOn 明確成功事件', () => {
  it('事件名固定', () => {
    expect(TRYON_GUIDE_EVENT).toBe('redcode:tryon-guide');
  });

  it('只認 share／purchase', () => {
    expect(parseTryOnGuideAction({ action: 'share' })).toBe('share');
    expect(parseTryOnGuideAction({ action: 'purchase' })).toBe('purchase');
  });

  it('壞 detail 一律 null', () => {
    expect(parseTryOnGuideAction(null)).toBeNull();
    expect(parseTryOnGuideAction('share')).toBeNull();
    expect(parseTryOnGuideAction({ action: 'click' })).toBeNull();
    expect(parseTryOnGuideAction({})).toBeNull();
  });
});

describe('拖曳門檻、安全位檢查及放開返回', () => {
  const viewport = { w: 390, h: 844 };
  const fairy = { w: 66, h: 111 };

  it('6px 門檻：輕微郁動唔當拖曳，超過先開始', () => {
    expect(FAIRY_DRAG_THRESHOLD_PX).toBe(6);
    expect(shouldStartFairyDrag({ x: 100, y: 100 }, { x: 103, y: 104 })).toBe(false);
    expect(shouldStartFairyDrag({ x: 100, y: 100 }, { x: 100, y: 105.9 })).toBe(false);
    expect(shouldStartFairyDrag({ x: 100, y: 100 }, { x: 106, y: 100 })).toBe(true);
    expect(shouldStartFairyDrag({ x: 100, y: 100 }, { x: 94, y: 100 })).toBe(true);
  });

  it('放開返回休息位約 5 秒', () => {
    expect(FAIRY_DRAG_RETURN_MS).toBe(5000);
  });

  it('fairyPointSafe：完整喺畫面、無碰撞先安全；需 clamp 或撞障礙物就唔安全', () => {
    const free = { x: 100, y: 400 };
    expect(fairyPointSafe(free, fairy, [], viewport)).toBe(true);
    const blocker = { left: 90, top: 390, width: 120, height: 160 };
    expect(fairyPointSafe(free, fairy, [blocker], viewport)).toBe(false);
    // 超出 viewport 會被 clamp 移位，唔算仍然安全。
    expect(fairyPointSafe({ x: -30, y: 400 }, fairy, [], viewport)).toBe(false);
    expect(fairyPointSafe({ x: 390, y: 400 }, fairy, [], viewport)).toBe(false);
    // 極細 viewport 下任何位置都被 clamp，唔會誤當安全而停止逃脫。
    expect(fairyPointSafe({ x: 10, y: 10 }, fairy, [], { w: 40, h: 50 })).toBe(false);
  });
});

describe('窗口制飛行 stall 偵測', () => {
  it('未夠窗口帧數唔會誤停', () => {
    const window = { frames: 3, start: { x: 0, y: 0 }, startTargetDistance: 500 };
    expect(shouldStopStalledFlight(window, { x: 0.5, y: 0 }, 499.5)).toBe(false);
  });

  it('窗口內來回震盪（淨位移同接近目標都無進展）即停', () => {
    const window = { frames: FAIRY_FLIGHT_STALL_WINDOW_FRAMES, start: { x: 100, y: 400 }, startTargetDistance: 700 };
    expect(shouldStopStalledFlight(window, { x: 106.7, y: 400 }, 700)).toBe(true);
    expect(shouldStopStalledFlight(window, { x: 93.3, y: 401 }, 702)).toBe(true);
  });

  it('窗口內有實質位移或持續接近目標唔會停', () => {
    const window = { frames: 48, start: { x: 100, y: 400 }, startTargetDistance: 700 };
    expect(shouldStopStalledFlight(window, { x: 180, y: 420 }, 640)).toBe(false);
    // 沿牆滑動：位置郁得多但目標距離冇縮都當有進展（繞行中）。
    expect(shouldStopStalledFlight(window, { x: 100, y: 250 }, 700)).toBe(false);
  });

  it('「安全但不可達」全高牆：有限帧內停止，而且唔再左右反轉', () => {
    const viewport = { w: 1280, h: 800 };
    const fairy = { w: 86, h: 144 };
    // 審查重現個案：全高牆擋住，目標喺牆另一邊；目標本身安全但到唔到。
    const wall: FairyRect = { left: 500, top: 0, width: 120, height: 800 };
    const target = { x: 1100, y: 400 };
    let current = { x: 60, y: 400 };
    let window = { frames: 0, start: { ...current }, startTargetDistance: Math.hypot(target.x - current.x, target.y - current.y) };
    let stoppedAt = -1;
    let reversals = 0;
    let prevDx = 0;
    for (let frame = 0; frame < 600 && stoppedAt < 0; frame += 1) {
      const next = advanceFairyFlight({
        current, target, viewport, fairy, obstacles: [wall], deltaMs: 16.67, maxSpeed: 1200,
      });
      const dx = next.x - current.x;
      if (prevDx !== 0 && dx !== 0 && Math.sign(dx) !== Math.sign(prevDx)) reversals += 1;
      if (Math.abs(dx) > 0.01) prevDx = dx;
      window.frames += 1;
      const remaining = Math.hypot(target.x - next.x, target.y - next.y);
      if (shouldStopStalledFlight(window, next, remaining)) {
        stoppedAt = frame;
      } else if (window.frames >= FAIRY_FLIGHT_STALL_WINDOW_FRAMES) {
        window = { frames: 0, start: { ...next }, startTargetDistance: remaining };
      }
      current = next;
    }
    expect(stoppedAt).toBeGreaterThanOrEqual(FAIRY_FLIGHT_STALL_WINDOW_FRAMES - 1);
    expect(stoppedAt).toBeLessThan(200);
    // 牆左邊停低，唔會穿牆；全段飛行唔會長期左右拉鋸。
    expect(current.x + fairy.w).toBeLessThanOrEqual(wall.left + 0.5);
    expect(reversals).toBeLessThan(60);
  });

  it('可達目標喺同一窗口規則下唔會被誤停，正常到達', () => {
    const viewport = { w: 1280, h: 800 };
    const fairy = { w: 86, h: 144 };
    const target = { x: 1100, y: 400 };
    let current = { x: 60, y: 400 };
    let window = { frames: 0, start: { ...current }, startTargetDistance: Math.hypot(target.x - current.x, target.y - current.y) };
    let frames = 0;
    for (; frames < 300 && Math.hypot(target.x - current.x, target.y - current.y) > 0.5; frames += 1) {
      const next = advanceFairyFlight({ current, target, viewport, fairy, deltaMs: 16.67, maxSpeed: 1200 });
      window.frames += 1;
      const remaining = Math.hypot(target.x - next.x, target.y - next.y);
      expect(shouldStopStalledFlight(window, next, remaining)).toBe(false);
      if (window.frames >= FAIRY_FLIGHT_STALL_WINDOW_FRAMES) {
        window = { frames: 0, start: { ...next }, startTargetDistance: remaining };
      }
      current = next;
    }
    expect(Math.hypot(target.x - current.x, target.y - current.y)).toBeLessThanOrEqual(0.5);
    expect(frames).toBeLessThan(300);
  });
});

describe('unsafe drop 脫困：stall 唔准停喺碰撞位', () => {
  const viewport = { w: 390, h: 844 };
  const fairy = { w: 66, h: 110.67 };

  /** 同 GlobalFairyGuide flight loop 一樣嘅 stall＋rescue 脫困規則，純函數重現。 */
  function simulateWithEscape(
    start: { x: number; y: number },
    initialTarget: { x: number; y: number },
    obstacles: readonly FairyRect[],
    maxFrames = 1500,
  ) {
    let current = { ...start };
    let destination = { ...initialTarget };
    const tried: Array<{ x: number; y: number }> = [];
    const freshWindow = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
      frames: 0,
      start: { ...from },
      startTargetDistance: Math.hypot(to.x - from.x, to.y - from.y),
    });
    let window = freshWindow(current, destination);
    let escapeMode = !fairyPointSafe(current, fairy, obstacles, viewport);
    for (let frame = 0; frame < maxFrames; frame += 1) {
      const next = advanceFairyFlight({
        current, target: destination, viewport, fairy,
        obstacles: escapeMode ? [] : obstacles, deltaMs: 16.67, maxSpeed: 960,
      });
      window.frames += 1;
      const stillUnsafe = !fairyPointSafe(next, fairy, obstacles, viewport);
      current = next;
      if (escapeMode && !stillUnsafe) {
        escapeMode = false;
        window = freshWindow(current, destination);
      }
      const remaining = Math.hypot(destination.x - next.x, destination.y - next.y);
      if (remaining <= 0.5) return { point: current, outcome: 'reached' as const, frames: frame + 1 };
      if (!escapeMode && shouldStopStalledFlight(window, next, remaining)) {
        if (!stillUnsafe) return { point: current, outcome: 'safe-stall' as const, frames: frame + 1 };
        escapeMode = true;
        if (!fairyPointSafe(destination, fairy, obstacles, viewport)) {
          tried.push(destination);
          const escape = tried.length <= 8 ? fairyEscapeTarget(next, tried, viewport, fairy, obstacles) : null;
          if (!escape) return { point: current, outcome: 'exhausted' as const, frames: frame + 1 };
          destination = escape;
        }
        window = freshWindow(current, destination);
      } else if (window.frames >= FAIRY_FLIGHT_STALL_WINDOW_FRAMES) {
        window = freshWindow(current, destination);
      }
    }
    return { point: current, outcome: 'timeout' as const, frames: maxFrames };
  }

  it('fairyEscapeTarget 回最近嘅真 freeAt 安全位，排除已試目標', () => {
    const cta: FairyRect = { left: 10, top: 464, width: 370, height: 84 };
    const current = { x: 157, y: 483 };
    const escape = fairyEscapeTarget(current, [], viewport, fairy, [cta]);
    expect(escape).not.toBeNull();
    expect(fairyPointSafe(escape!, fairy, [cta], viewport)).toBe(true);
    const again = fairyEscapeTarget(current, [escape!], viewport, fairy, [cta]);
    expect(again).not.toBeNull();
    expect(Math.hypot(again!.x - escape!.x, again!.y - escape!.y)).toBeGreaterThanOrEqual(24);
    expect(fairyPointSafe(again!, fairy, [cta], viewport)).toBe(true);
  });

  it('主線重現個案：拖放上全寬 CTA，有限帧內脫困到唔再重疊嘅安全位', () => {
    // 390×844 首頁：ring/CTA x15 y469 w360 h74（擴 5），下方浮鈕，上方文字帶。
    const obstacles: FairyRect[] = [
      { left: 10, top: 464, width: 370, height: 84 }, // 全寬 CTA（擴 5）
      { left: 10, top: 300, width: 370, height: 120 }, // CTA 上方內容帶
      { left: 290, top: 700, width: 80, height: 130 }, // 右下浮鈕
    ];
    const drop = { x: 157.46, y: 483.79 };
    expect(fairyPointSafe(drop, fairy, obstacles, viewport)).toBe(false);
    const result = simulateWithEscape(drop, { x: 308, y: 717.33 }, obstacles);
    // 可以到達目標，或中途已 free 就停——重點係最終 freeAt 且唔再冚 CTA，唔准 stall 喺碰撞位。
    expect(['reached', 'safe-stall']).toContain(result.outcome);
    expect(result.frames).toBeLessThan(1500);
    expect(fairyPointSafe(result.point, fairy, obstacles, viewport)).toBe(true);
    for (const obstacle of obstacles) {
      expect(fairyOverlapsRect(result.point, fairy, obstacle)).toBe(false);
    }
  });

  it('全高牆不可達：已 free 就停安全位，唔會因脫困邏輯亂飛', () => {
    const wall: FairyRect = { left: 500, top: 0, width: 120, height: 800 };
    const desktop = { w: 1280, h: 800 };
    const big = { w: 86, h: 144 };
    const result = simulateWithEscape({ x: 60, y: 400 }, { x: 1100, y: 400 }, [wall], 600);
    expect(result.outcome).toBe('safe-stall');
    expect(fairyPointSafe(result.point, big, [wall], desktop)).toBe(true);
    expect(result.point.x + big.w).toBeLessThanOrEqual(wall.left + 0.5);
  });

  it('全部候選都唔 free 嘅極密頁：回 exhausted 而唔係死循環', () => {
    const full: FairyRect = { left: 0, top: 0, width: 390, height: 844 };
    expect(fairyEscapeTarget({ x: 100, y: 400 }, [], viewport, fairy, [full])).toBeNull();
  });
});

describe('源碼防退化：拖曳、reduced-motion 中途停機及 scroll 唔即時 retarget', () => {
  const source = readFileSync(new URL('./GlobalFairyGuide.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./GlobalFairyGuide.css', import.meta.url), 'utf8');

  it('pointer capture 拖曳：6px 門檻、拖曳唔觸發 click、觸控唔捲頁', () => {
    expect(source).toContain('onPointerDown={onFairyPointerDown}');
    expect(source).toContain('onPointerMove={onFairyPointerMove}');
    expect(source).toContain('onPointerUp={(event) => endFairyDrag(event, false)}');
    expect(source).toContain('onPointerCancel={(event) => endFairyDrag(event, true)}');
    expect(source).toContain('fairy.setPointerCapture(event.pointerId)');
    expect(source).toContain('shouldStartFairyDrag(');
    expect(source).toContain('suppressClickRef.current = true;');
    expect(source).toContain('if (suppressClickRef.current) {');
    expect(css).toMatch(/\.fairy-guide-button\s*\{[\s\S]*?touch-action:\s*none/);
    expect(css).toContain('.fairy-guide-button[data-dragging="true"]');
  });

  it('拖曳進入即停現有飛行並以肉眼位置接手，唔會閃走', () => {
    expect(source).toContain('drag.active = true;');
    expect(source).toContain('if (flightRafRef.current) cancelAnimationFrame(flightRafRef.current);\n      flightRafRef.current = 0;\n      flightLastTimeRef.current = 0;\n      flightTargetRef.current = null;\n      if (openRef.current) setOpen(false);');
    expect(source).toContain('renderedPositionRef.current = point;\n    positionRef.current = point;');
  });

  it('放開約 5 秒由肉眼位置連續返回安全休息位，唔准瞬移', () => {
    expect(source).toContain('FAIRY_DRAG_RETURN_MS');
    expect(source).toContain('forceReplaceRef.current = true;\n      refresh();');
    expect(source).toContain('dragReturnTimerRef.current = window.setTimeout(');
    expect(source).toContain('if (dragReturnTimerRef.current) window.clearTimeout(dragReturnTimerRef.current);');
    // 放開撞內容會先飛去最近安全位，唔係 hide 或瞬移。
    expect(source).toContain('`drag-drop|${makeObstacleKey(dropObstacles)}`');
  });

  it('拖曳 scared、真指引 point、平時閒置循環', () => {
    expect(source).toContain("? 'scared'");
    expect(source).toContain(": showGuide && sameRoute && !isScrolling && resolution.ring");
    expect(source).toContain("? 'point'");
    expect(source).toContain('action={displayedAction}');
    expect(source).toContain('if (!isFairyIdleAction(completed)) return;');
    expect(source).toContain('data-dragging={dragging ?');
  });

  it('scroll 中現有飛行目標仍安全就唔 retarget，只更新障礙物資料', () => {
    expect(source).toContain('const keepFlight =');
    expect(source).toContain('flightMode === lastFlightModeRef.current &&');
    expect(source).toContain('flightCandidate === lastFlightCandidateRef.current &&');
    expect(source).toContain('fairyPointSafe(existingTarget, sizeRef.current, flightObstacles, viewportSize)');
    expect(source).toContain('if (keepFlight && existingTarget) {');
    expect(source).toContain('flightObstaclesRef.current = flightObstacles;');
    // 揀位錨點係肉眼位置，唔係幾百毫秒後嘅飛行終點。
    expect(source).toContain('renderedPositionRef.current ?? positionRef.current');
  });

  it('reduced-motion 中途切換即停飛行 rAF 並 snap 到安全目標', () => {
    const reduce = source.slice(
      source.indexOf('if (!reducedMotion) return;'),
      source.indexOf('}, [reducedMotion, syncPointing]);'),
    );
    expect(reduce).toContain('cancelAnimationFrame(flightRafRef.current)');
    expect(reduce).toContain('flightTargetRef.current = null;');
    expect(reduce).toContain('renderedPositionRef.current = { ...target };');
    // 拖曳緊唔 snap 走用家手底下嘅精靈。
    expect(reduce).toContain('!draggingRef.current');
  });
  it('pointercancel 唔留 suppress 殘留吞下次真 tap；新按下會清狀態', () => {
    expect(source).toContain('if (!cancelled) suppressClickRef.current = true;');
    expect(source).not.toMatch(/if \(!drag\.active\) return;\s*\n\s*suppressClickRef\.current = true;/);
    const pointerDown = source.slice(source.indexOf('const onFairyPointerDown'), source.indexOf('const onFairyPointerMove'));
    expect(pointerDown).toContain('suppressClickRef.current = false;');
    expect(pointerDown).toContain('dragReturnPendingRef.current = false;');
    expect(pointerDown).toContain('clearDragReturnTimer();');
  });

  it('放開後 5 秒 freeze window：普通 refresh 保持 drop 位，timer 到先強制重揀', () => {
    expect(source).toContain('const dragReturnPendingRef = useRef(false);');
    expect(source).toContain('dragReturnPendingRef.current = true;');
    expect(source).toContain('dragReturnPendingRef.current = false;\n      forceReplaceRef.current = true;\n      refresh();');
    expect(source).toContain('preferRest: !active && !dragReturnPendingRef.current,');
  });

  it('cancelled drag 掉喺障礙物都即時去最近安全位', () => {
    const endDrag = source.slice(source.indexOf('const endFairyDrag'), source.indexOf('const displayedAction'));
    expect(endDrag).toContain('if (drop) {');
    expect(endDrag).not.toContain('if (!cancelled && drop) {');
    expect(endDrag).toContain('`drag-drop|${makeObstacleKey(dropObstacles)}`');
  });

  it('窗口制 stall 偵測取代單帧 moved 門檻', () => {
    expect(source).toContain('shouldStopStalledFlight(stallWindow, next, remaining)');
    expect(source).toContain('FAIRY_FLIGHT_STALL_WINDOW_FRAMES');
    expect(source).toContain('stallWindow = { frames: 0, start: { ...next }, startTargetDistance: remaining };');
    expect(source).not.toContain('stalledFrames');
  });

  it('stall 時仍碰撞唔准停：入 rescue 模式直線去已驗證 freeAt 位，free 先恢復正常碰撞飛行', () => {
    expect(source).toContain('const stillUnsafe = !fairyPointSafe(next, sizeRef.current, flightObstaclesRef.current, flightViewportRef.current);');
    expect(source).toContain('obstacles: escapeMode ? [] : flightObstaclesRef.current,');
    expect(source).toContain('if (escapeMode && !stillUnsafe) {');
    expect(source).toContain('escapeMode = true;');
    expect(source).toContain('fairyEscapeTarget(next, escapeTried, flightViewportRef.current, sizeRef.current, flightObstaclesRef.current)');
    expect(source).toContain('escapeTried.length <= 8');
    // 拖放脫困要連真指引目標（ring）都當障礙物。
    expect(source).toContain('const dropObstacles = pointingRingRef.current');
  });
});

describe('源碼防退化：舊大面板及假指唔准返嚟', () => {
  const source = readFileSync(new URL('./GlobalFairyGuide.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./GlobalFairyGuide.css', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../pages/Home.tsx', import.meta.url), 'utf8');
  const products = readFileSync(new URL('../pages/Products.tsx', import.meta.url), 'utf8');
  const productDetail = readFileSync(new URL('../pages/ProductDetail.tsx', import.meta.url), 'utf8');
  const navbar = readFileSync(new URL('./Navbar.tsx', import.meta.url), 'utf8');

  it('只用真透明多幀動作播放器，唔再載舊單圖、飛行媒體或 GloCutout', () => {
    expect(source).toContain('FairyActionAnimation');
    expect(source).toContain('onHoldComplete={completeFairyAction}');
    expect(source).toContain('nextFairyAction');
    expect(source).not.toContain('/fairy/glo-guide.png');
    expect(source).not.toContain('GloCutout');
    expect(source).not.toContain('fairy-fly-alpha');
    expect(source).not.toContain('fairy-fly-anim');
    expect(source).not.toContain('fairy-fly-poster');
  });

  it('冇大型 dialog、五步清單或 Home reaction 彈窗', () => {
    expect(source).not.toContain('role="dialog"');
    expect(source).not.toContain('FAIRY_STEP_ORDER.map');
    expect(source).not.toContain('HOME_FAIRY_EVENT');
    expect(source).not.toContain('parseHomeFairyReaction');
  });

  it('root 唔裁切，只有精靈同氣泡可接收 pointer', () => {
    expect(css).toMatch(/\.fairy-guide-root\s*\{[\s\S]*?overflow:\s*visible/);
    expect(css).toMatch(/\.fairy-guide-root\s*\{[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/\.fairy-guide-button\s*\{[\s\S]*?pointer-events:\s*auto/);
    expect(css).toMatch(/\.fairy-guide-bubble\s*\{[\s\S]*?pointer-events:\s*auto/);
  });

  it('目標離屏只可由用戶撳「帶我去」後 scroll，唔會代點控制', () => {
    expect(source).toContain('const goToPendingTarget = () =>');
    expect(source).toContain('target.scrollIntoView');
    expect(source).not.toMatch(/\.click\s*\(/);
    expect(source).not.toContain('anchorToTarget');
  });

  it('保留真成功事件、hidden、reduced-motion 同 observer 清理', () => {
    expect(source).toMatch(/addEventListener\(TRYON_GUIDE_EVENT/);
    expect(source).not.toMatch(/addEventListener\(['"]click['"]/);
    expect(source).toContain('document.hidden');
    expect(source).toContain('prefers-reduced-motion: reduce');
    expect(source).toContain('observer.disconnect()');
    expect(source).toContain('resizeObserver.disconnect()');
    expect(source).toContain('cancelScheduled()');
  });

  it('精靈同氣泡都避控制、商品媒體、公告及實際標題文字', () => {
    expect(source).toContain('obstacles: obstacles.all');
    expect(source).toContain("'main h1, main h2, main h3, main h4, main p, main figcaption, main blockquote, main dt, main dd, main .faq-kicker-cn, main header > p.script'");
    expect(source).toContain('range.getClientRects()');
    expect(source).toContain('all.push(...collectContentObstacles(viewport))');
    expect(source).toContain('bubbleObstaclesRef.current = obstacles.all');
    expect(source).not.toContain('bubbleObstaclesRef.current = obstacles.critical');
    expect(source).toContain("'main .lr-card'");
    expect(source).toContain("'main .duotone img'");
    expect(source).toContain("'main .overflow-x-auto img'");
    expect(source).toContain("'main [aria-hidden=\"true\"].absolute.rounded-2xl'");
    expect(source).toContain('if (!isRendered(element, true)) continue;');
    expect(source).toContain("element.closest(includeAriaHidden ? '[inert]' : '[inert], [aria-hidden=\"true\"]')");
    expect(source).toContain("if (!isRendered(element) || element.closest('header, [data-fairy-guide-root]')) return false;");
    expect(source).not.toContain('aria-hidden={!showGuide}');
  });

  it('氣泡冇安全位會清舊座標及真正收埋，唔會假開啟或自動重彈', () => {
    expect(source).toContain('if (!open || !resolution.placed || !resolution.point)');
    expect(source).toContain('setBubblePos(null);\n      setOpen(false);\n      setDenied(true);');
    expect(source).toContain('if ((blocked || !placement) && openRef.current) setOpen(false);');
    expect(source).toContain('samePoint(a.point, b.point)');
    expect(source).toContain('a.obstacleKey === b.obstacleKey');
    expect(source).toContain('const obstacleKey = makeObstacleKey(obstacles.all)');
    expect(source).toContain('obstacleKey,');
    expect(source).toContain('useLayoutEffect(() => {');
    expect(source).toContain('point: placement ?');
    expect(source).toContain('className="fairy-guide-denied"');
    expect(source).toContain('if (!pageVisible) {\n      setDenied(false);');
    expect(css).toMatch(/\.fairy-guide-denied\s*\{[\s\S]*?pointer-events:\s*none/);
    expect(css).toMatch(/@media \(max-width: 480px\)[\s\S]*?\.fairy-guide-bubble\s*\{[\s\S]*?max-height:\s*42vh/);
  });

  it('原尺寸無位先逐級試可滾動矮版、緊湊版及微型版，仍無位先收起', () => {
    expect(source).toContain("const [bubbleMode, setBubbleMode] = useState<'full' | 'short' | 'compact' | 'micro'>('full');");
    expect(source).toContain("if (bubbleMode !== 'micro') {");
    expect(source).toContain("setBubbleMode(bubbleMode === 'full' ? 'short' : bubbleMode === 'short' ? 'compact' : 'micro');");
    expect(source).toContain("if (!open) setBubbleMode('full');");
    expect(source).toContain('data-bubble-layout={bubbleMode}');
    expect(source).toContain('}, [open, resolution, bubbleMode]);');
    expect(css).toMatch(/\.fairy-guide-bubble\.is-short\s*\{[\s\S]*?max-height:\s*min\(104px, calc\(100vh - 24px\)\)/);
    expect(css).toMatch(/\.fairy-guide-bubble\.is-compact\s*\{[\s\S]*?width:\s*min\(192px, calc\(100vw - 24px\)\)[\s\S]*?max-height:\s*min\(80px, calc\(100vh - 24px\)\)/);
    expect(css).toMatch(/\.fairy-guide-bubble\.is-micro\s*\{[\s\S]*?width:\s*min\(192px, calc\(100vw - 24px\)\)[\s\S]*?max-height:\s*min\(52px, calc\(100vh - 24px\)\)/);
    // 最後防線仍然係完全冇安全位就真正關閉，唔准用細氣泡做藉口放寬碰撞。
    expect(source).toContain('setBubblePos(null);\n      setOpen(false);\n      setDenied(true);');
  });

  it('手機商品雙欄回復正常寬度，唔再為精靈留中央通道', () => {
    for (const page of [home, products, productDetail]) {
      expect(page).toContain('grid-cols-2 gap-4');
      expect(page).toContain('md:gap-6');
      expect(page).not.toContain('gap-x-20');
    }
  });

  it('窄屏 Hero 唔再額外留白；精靈仍只揀真安全位', () => {
    expect(home).toContain('mt-10 grid grid-cols-2 items-stretch gap-3 sm:flex');
    expect(home).not.toContain('max-[380px]:mt-24');
    expect(source).toContain('const widths = [...new Set([naturalSize.w, 66, 56, 48, 44]');
    expect(source).not.toContain('hidePlacementForRelayout');
  });

  it('文件滾動由時間制 flight loop 連續追位；幾何重讀唔再綁死每個 rAF', () => {
    expect(source).toContain('scrollingRef.current = true');
    expect(source).toContain('const trackScrollFrame = () =>');
    expect(source).toContain('requestAnimationFrame(trackScrollFrame)');
    expect(source).toContain('now - lastScrollRefreshRef.current >= 80');
    expect(source).toContain('const startFlight = useCallback(');
    expect(source).toContain('advanceFairyFlight({');
    expect(source).toContain('preferRest: !active');
    expect(source).toContain('renderedPositionRef.current = next');
    expect(source).toContain('point.x.toFixed(2)');
    expect(source).toContain('point.y.toFixed(2)');
    expect(source).toContain('if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)');
    expect(source).toContain('if (document.hidden || dismissed || isAdmin) return;');
    expect(source).not.toContain('document.hidden || dismissed || isAdmin || scrollingRef.current');
    expect(source).not.toContain('hidePlacementForRelayout');
    const begin = source.slice(source.indexOf('const beginScrollSettle'), source.indexOf('const onScroll ='));
    expect(begin).not.toContain('setResolution');
    expect(begin).not.toContain('placed: false');
    const entrance = source.slice(source.indexOf('const onEntranceMotionStart'), source.indexOf('const onEntranceMotionEnd'));
    expect(entrance).not.toContain('setResolution');
    expect(source).toContain('if (isGuideScroll(event)) return;');
    expect(source).toContain('hasUnsettledEntranceMotion()');
    expect(source).toContain("window.addEventListener('scrollend', onScrollEnd, true)");
    expect(source).toContain('window.setTimeout(settleScroll, 180)');
    expect(source).toContain('const widths = [...new Set([naturalSize.w, 66, 56, 48, 44]');
    expect(source).toContain('h: width * 768 / 458');
    expect(source).toContain("document.addEventListener('transitionrun', onEntranceMotionStart, true)");
    expect(source).toContain("document.addEventListener('transitionend', onEntranceMotionEnd, true)");
    expect(css).not.toMatch(/transition:\s*transform\s+520ms/);
    expect(css).not.toMatch(/\.fairy-guide-ring\s*\{[\s\S]*?transition:\s*transform/);
  });

  it('resize 即時夾返可見位置並重讀幾何，唔等 timer 令精靈離屏', () => {
    expect(source).toContain('const onResize = () => {');
    expect(source).toContain('const visible = clampFairyPosition(current, viewport, baseFairySize(viewport));');
    expect(source).toContain('renderedPositionRef.current = { ...visible };');
    expect(source).toContain("window.addEventListener('resize', onResize)");
    expect(source).toContain("window.removeEventListener('resize', onResize)");
    expect(source).not.toContain("window.addEventListener('resize', scheduleRefresh)");
  });

  it('滾動中暫時無新安全位都唔拆走精靈合成層；真正阻塞層先暫停', () => {
    expect(source).toContain('const hasRenderedPosition = !!(positionedRef.current && renderedPositionRef.current);');
    expect(source).toContain('const showGuide = !resolution.blocked && (resolution.placed || hasRenderedPosition);');
    expect(source).toContain('a.blocked === b.blocked');
    expect(source).toContain('blocked,');
    expect(source).not.toContain('const showGuide = resolution.placed &&');
  });

  it('目標及 ring 共用 header 以下安全區；reduced-motion 直接落安全位', () => {
    expect(source).toContain('const contentViewport: FairyRect = {');
    expect(source).toContain('visibleActionRect(rect, viewportSize, contentViewport)');
    expect(source).toContain('roundedRect(intersectRect(expandRect(active.visibleRect, 5), contentViewport))');
    expect(source).toContain('if (!renderedPositionRef.current || reducedMotion || !positionedRef.current)');
    expect(source).toContain('{showGuide && sameRoute && !isScrolling && resolution.ring && (');
    expect(source).toContain('setIsScrolling(true);');
    expect(source).toContain('setIsScrolling(false);');
    expect(source).toContain('if (!escapeMode && shouldStopStalledFlight(stallWindow, next, remaining)) {');
    expect(source).toContain('stallWindow.frames += 1;');
    expect(source).toContain('flightStallKeyRef.current === flightKey');
    expect(css).not.toMatch(/transition:\s*transform/);
  });

  it('內層商品滾動逐幀更新；無關 carousel 唔追，相交先追且唔隐藏', () => {
    expect(source).toContain('const guideIntersectsScroller = (event: Event): boolean =>');
    expect(source).toContain('const beginScrollSettle = (event: Event)');
    expect(source).toContain('if (documentScroll || sameChannel || guideIntersectsScroller(event)) beginScrollSettle(event);');
    expect(source).toContain('scrollTargetRef.current = event.target');
    expect(source).toContain('if (beginsScrollChannel) {');
    expect(source).toContain('lastScrollRefreshRef.current = performance.now();\n        refresh();');
    expect(source).toContain('scrollRafRef.current = 0');
    expect(source).not.toContain('scrollHideRef');
    expect(source).toContain("window.removeEventListener('scrollend', onScrollEnd, true)");
    expect(source).not.toContain('if (!isDocumentScroll(event)) return;');
  });

  it('無限動畫、完全離屏進場及無關 hover 唔阻導覽；動畫事件缺失仍有自癒重試', () => {
    expect(source).toContain('effect?.getTiming().iterations === Infinity');
    expect(source).toContain('if (!intersectRect(toRect(target.getBoundingClientRect()), VIEWPORT_RECT())) return false;');
    expect(source).toContain("animation.playState === 'paused'");
    expect(source).toContain("target.matches('main .reveal, main .lr-enter, main .hero-enter')");
    expect(source).toContain("event.target.matches('main .reveal') && (event as TransitionEvent).propertyName === 'transform'");
    expect(source).toContain("if (event.type === 'animationstart') return event.target.matches('main .lr-enter, main .hero-enter')");
    expect(source).toContain('motionRetryTimerRef.current = window.setTimeout');
    expect(source).toContain('window.clearTimeout(motionRetryTimerRef.current)');
  });

  it('離屏 CSS start 事件即時豁免，唔會先閃藏可見精靈', () => {
    expect(source).toContain(
      "const isEntranceMotion = (event: Event) => {\n      if (!(event.target instanceof Element)) return false;\n      // start 事件都要即時排除離屏元素；唔可以只靠之後 refresh 嘅動畫掃描，否則可見精靈會閃一下。\n      if (!intersectRect(toRect(event.target.getBoundingClientRect()), VIEWPORT_RECT())) return false;",
    );
  });

  it('桌面會員名有完整提示及寬屏空間；打卡牆同標題共用置中容器', () => {
    expect(navbar).toContain('title={user.name}');
    expect(navbar).toContain('nav-link min-w-0 max-w-40 shrink-0 truncate xl:max-w-48');
    expect(home).toContain('md:mx-auto md:grid md:max-w-[1280px] md:grid-cols-3');
    expect(home).toContain('lg:grid-cols-6');
    expect(home).toContain('w-56 shrink-0 md:w-auto md:shrink');
  });

  it('精靈有四套真動作，只向真實可見目標轉向；reduced-motion 用靜態幀', () => {
    expect(source).toContain('const syncPointing = useCallback((point: FairyPoint | null)');
    expect(source).toContain("ring.left + ring.width / 2 < point.x + sizeRef.current.w / 2");
    expect(source).toContain('syncPointing(point);');
    expect(source).toContain('pointingRingRef.current = scrollingRef.current ? null : ring;');
    expect(source).not.toContain('data-pointing={pointingDirection');
    expect(source).toContain("useState<FairyAction>('wave')");
    expect(source).toContain('setFairyAction((current) => current === completed ? nextFairyAction(current) : current)');
    expect(source).toContain('setFairyAction(\'wave\')');
    expect(source).toContain('animate={pageVisible && !reducedMotion}');
    expect(css).toContain('.fairy-guide-button[data-pointing="left"] .fairy-guide-float img');
    expect(css).toContain('.fairy-guide-button[data-pointing="right"] .fairy-guide-float img');
    expect(css).not.toContain('@keyframes fairy-guide-hover');
    expect(css).toContain('@media (max-height: 560px) {\n  .fairy-guide-button { width: 60px; }\n}');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fairy-guide-float\s*\{[\s\S]*?transform:\s*none/);
  });
});

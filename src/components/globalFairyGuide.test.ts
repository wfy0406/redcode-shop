import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  EMPTY_TRYON_SIGNALS,
  FAIRY_STEP_ORDER,
  FAIRY_STEP_TARGET_SELECTORS,
  TRYON_GUIDE_EVENT,
  chooseFairyPlacement,
  clampFairyPosition,
  computeBubbleLayout,
  computeTryOnStep,
  expandRect,
  fairyOverlapsRect,
  getFairyRouteGuide,
  intersectRect,
  parseTryOnGuideAction,
  restPosition,
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

  it('商品列表有搜尋、分類及商品卡真控制', () => {
    const selectors = getFairyRouteGuide('/products').candidates.flatMap((item) => item.selectors);
    expect(selectors).toContain('main input[aria-label="搜尋商品"]');
    expect(selectors).toContain('main article a[href^="/products/"]');
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

  it('休息位完整喺 viewport', () => {
    expectInside(restPosition(viewport, fairy), fairy, viewport);
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

describe('源碼防退化：舊大面板及假指唔准返嚟', () => {
  const source = readFileSync(new URL('./GlobalFairyGuide.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./GlobalFairyGuide.css', import.meta.url), 'utf8');

  it('只用新單層透明 PNG，唔再載舊飛行媒體或 GloCutout', () => {
    expect(source).toContain('/fairy/glo-guide.png');
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
    expect(source).toContain('obstacleKey: makeObstacleKey(obstacles.all)');
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

  it('文件滾動及進場位移未完成先收起精靈同目標環，穩定後先重算安全位', () => {
    expect(source).toContain('scrollingRef.current = true');
    expect(source).toContain('setResolution(hidePlacementForRelayout)');
    expect(source).toContain('placed: false, ring: null, point: null, canScroll: false');
    expect(source).toContain('document.hidden || dismissed || isAdmin || scrollingRef.current');
    expect(source).toContain('if (isGuideScroll(event)) return;');
    expect(source).toContain('hasUnsettledEntranceMotion()');
    expect(source).toContain("window.addEventListener('scrollend', onScrollEnd, true)");
    expect(source).toContain('window.setTimeout(settleScroll, 180)');
    expect(source).toContain("document.addEventListener('transitionrun', onEntranceMotionStart, true)");
    expect(source).toContain("document.addEventListener('transitionend', onEntranceMotionEnd, true)");
    expect(css).not.toMatch(/transition:\s*transform\s+520ms/);
    expect(css).not.toMatch(/\.fairy-guide-ring\s*\{[\s\S]*?transition:\s*transform/);
  });

  it('內層商品滾動停滾後更新；無關 carousel 唔盲 hide，相交先收起', () => {
    expect(source).toContain('const guideIntersectsScroller = (event: Event): boolean =>');
    expect(source).toContain('const beginScrollSettle = (event: Event, hide: boolean)');
    expect(source).toContain('documentScroll || guideIntersectsScroller(event) || (sameChannel && scrollHideRef.current)');
    expect(source).toContain('scrollTargetRef.current = event.target');
    expect(source).toContain('scrollHideRef.current = false');
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

  it('精靈輕快浮飛，只向真實可見目標轉向；reduced-motion 照停', () => {
    expect(source).toContain('const pointingDirection = showGuide && resolution.ring && resolution.point');
    expect(source).toContain("resolution.ring.left + resolution.ring.width / 2 < resolution.point.x + sizeRef.current.w / 2");
    expect(source).toContain('data-pointing={pointingDirection ?? undefined}');
    expect(css).toContain('.fairy-guide-button[data-pointing="left"] .fairy-guide-float img');
    expect(css).toContain('.fairy-guide-button[data-pointing="right"] .fairy-guide-float img');
    expect(css).toMatch(/@keyframes fairy-guide-hover\s*\{[\s\S]*?translate3d\(1\.5px, -2px, 0\)[\s\S]*?translate3d\(-1\.5px, -2px, 0\)/);
    expect(css).toContain('@media (max-height: 560px) {\n  .fairy-guide-button { width: 60px; }\n}');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.fairy-guide-float\s*\{[\s\S]*?animation:\s*none/);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Navbar「更多」整合契約（2026-10-26.2，UI v2026.10.26.2 §5）：
 *
 * 直接掃 Navbar.tsx 源碼，鎖死以下合約，任何人改返即刻紅：
 * - AI 試穿 /try-on 同中獎公告 /lucky-results 收入同一份 MORE_LINKS，
 *   桌面 dropdown 同手機 drawer 共用（各自 MORE_LINKS.map），同其他項目完全同款
 * - MORE_LINKS 新兩項擺最前；原有 INFO_LINKS 順序（順豐→VIP→關於→FAQ）不變
 * - 冇桌面獨立 AI CTA（lg:inline-flex btn-primary）、冇金框中獎入口（xl:inline-flex + Trophy）、
 *   冇 xl:hidden dropdown 專用 lucky link、冇手機特色 row（Sparkles/Trophy 漸變 row）
 * - Sparkles／Trophy 唔再 import（無死代碼）
 * - 「更多」對子路由 active（MORE_LINKS.some startsWith），有 aria-expanded、Escape、
 *   觸控 click 開關同 outside-click 收埋
 * - 右 cluster／auth min-w-0＋會員名 truncate（長名唔再頂爆）；手機 DrawerRow label 都 truncate
 * - WhatsApp 連字＋加寬 padding 維持 2xl 起（1280/1440 icon-only）
 */

const source = readFileSync(new URL('./Navbar.tsx', import.meta.url), 'utf8');

/** 抽出 `const NAME = [...]` 陣列定義區段做斷言 */
function constArrayBlock(name: string): string {
  const start = source.indexOf(`const ${name}`);
  if (start < 0) return '';
  const end = source.indexOf('];', start);
  return end < 0 ? '' : source.slice(start, end);
}

/** 數某個 pattern 喺 source 出現幾多次 */
function countOccurrences(needle: string): number {
  return source.split(needle).length - 1;
}

describe('Navbar「更多」共用資料契約（2026-10.26.2）', () => {
  it('MORE_LINKS 同時收 /try-on 同 /lucky-results，而且擺最前', () => {
    const block = constArrayBlock('MORE_LINKS');
    expect(block).not.toBe('');
    const tryOnIdx = block.indexOf("to: '/try-on'");
    const luckyIdx = block.indexOf("to: '/lucky-results'");
    const spreadIdx = block.indexOf('...INFO_LINKS');
    expect(tryOnIdx).toBeGreaterThanOrEqual(0);
    expect(luckyIdx).toBeGreaterThanOrEqual(0);
    expect(spreadIdx).toBeGreaterThanOrEqual(0);
    // 新兩項擺 More 資料最前，原有 INFO_LINKS 項目跟尾
    expect(tryOnIdx).toBeLessThan(luckyIdx);
    expect(luckyIdx).toBeLessThan(spreadIdx);
  });

  it('INFO_LINKS 原項目同順序不變（順豐 → VIP → 關於 → 常見問題）', () => {
    const block = constArrayBlock('INFO_LINKS');
    const order = ['/sf-stations', '/vip', '/about', '/faq'];
    const idxs = order.map((to) => block.indexOf(`to: '${to}'`));
    for (const idx of idxs) expect(idx).toBeGreaterThanOrEqual(0);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    // INFO_LINKS 唔准直接收新兩項（佢哋只喺 MORE_LINKS 出現一次）
    expect(block).not.toContain('/try-on');
    expect(block).not.toContain('/lucky-results');
  });

  it('MAIN_LINKS 原項目同順序不變', () => {
    const block = constArrayBlock('MAIN_LINKS');
    const order = ['/', '/products', '/live', '/orders', '/wallet-topup'];
    const idxs = order.map((to) => block.indexOf(`to: '${to}'`));
    for (const idx of idxs) expect(idx).toBeGreaterThanOrEqual(0);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });

  it('桌面 dropdown 同手機 drawer 共用 MORE_LINKS（兩處 MORE_LINKS.map）', () => {
    expect(countOccurrences('MORE_LINKS.map')).toBe(2);
  });

  it('More 項目同其他 dropdown 項目同款（統一 NavLink 樣式，無 xl:hidden 特例）', () => {
    // 桌面「更多」MORE_LINKS.map 行用返標準 dropdown 項目樣式（同商品分類項一致）
    const moreMap = source.indexOf('MORE_LINKS.map');
    expect(moreMap).toBeGreaterThanOrEqual(0);
    const block = source.slice(moreMap, moreMap + 800);
    expect(block).toContain('block rounded-xl px-3.5 py-2 text-[13px] font-bold tracking-wide transition-colors hover:bg-space-3');
    // 唔再有任何 xl:hidden 嘅 breakpoint 特例連結
    expect(source).not.toContain('xl:hidden');
  });
});

describe('Navbar 無獨立入口（2026-10.26.2 刪除契約）', () => {
  it('冇桌面獨立 AI 試穿 CTA（lg:inline-flex / btn-primary 頂欄鈕）', () => {
    expect(source).not.toContain('lg:inline-flex');
    expect(source).not.toMatch(/to="\/try-on"[\s\S]{0,300}?btn-primary/);
  });

  it('冇金框中獎公告頂欄入口（xl:inline-flex + 金邊 boxShadow）', () => {
    expect(source).not.toContain('xl:inline-flex');
    expect(source).not.toContain('rgba(245,197,24,0.55)');
  });

  it('Sparkles／Trophy icon 唔再 import（特色 row／CTA 已刪）', () => {
    expect(source).not.toMatch(/import\s*\{[^}]*\bSparkles\b[^}]*\}\s*from 'lucide-react'/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bTrophy\b[^}]*\}\s*from 'lucide-react'/);
    expect(source).not.toContain('<Sparkles');
    expect(source).not.toContain('<Trophy');
  });

  it('冇手機特色 row（金粉漸變背景 row 已刪）', () => {
    expect(source).not.toContain('linear-gradient(120deg, rgba(255,0,84,0.18)');
    expect(source).not.toContain('linear-gradient(120deg, rgba(245,197,24,0.16)');
  });

  it('／try-on 同 /lucky-results 各自只喺 MORE_LINKS 定義出現一次（冇殘留硬編碼入口）', () => {
    expect(countOccurrences("to: '/try-on'")).toBe(1);
    expect(countOccurrences("to: '/lucky-results'")).toBe(1);
    // JSX 入面唔再有 to="/try-on"／to="/lucky-results" 硬編碼
    expect(source).not.toContain('to="/try-on"');
    expect(source).not.toContain('to="/lucky-results"');
  });
});

describe('Navbar「更多」互動契約', () => {
  it('More 對子路由 active（MORE_LINKS.some startsWith）', () => {
    expect(source).toContain('MORE_LINKS.some((l) => pathname.startsWith(l.to))');
  });

  it('More 掣有 aria-haspopup／aria-expanded，click 開關照顧觸控', () => {
    const btn = source.slice(source.indexOf('aria-haspopup'), source.indexOf('aria-haspopup') + 900);
    expect(btn).toContain('aria-expanded={moreOpen}');
    expect(btn).toContain('onClick={() => setMoreOpen((v) => !v)}');
  });

  it('Escape 收埋兼 focus 返 More 掣', () => {
    expect(source).toContain("e.key === 'Escape'");
    expect(source).toContain('moreBtnRef.current?.focus()');
  });

  it('More 可見性只由 moreOpen 控制，Escape／轉頁後唔准被 CSS focus 偷開', () => {
    const start = source.indexOf('ref={moreRef}');
    const end = source.indexOf('{/* 右：', start);
    const moreSection = source.slice(start, end);
    expect(moreSection).not.toContain('group-focus-within:visible');
    expect(moreSection).not.toContain('group-hover:visible');
    expect(moreSection).toContain('suppressMoreFocusOpenRef.current = true');
    expect(moreSection).toContain("matches(':focus-visible')");
    expect(moreSection).toContain('onPointerEnter');
  });

  it('mouse 移走會收埋，但鍵盤焦點在選單時唔被混合輸入藏起', () => {
    const start = source.indexOf('onPointerLeave={');
    const section = source.slice(start, start + 900);
    expect(section).toContain("e.pointerType === 'mouse' && !hasKeyboardFocus");
    expect(section).toContain("focused.matches(':focus-visible')");
    expect(section).toContain('moreRef.current?.contains(focused)');
  });

  it('outside pointerdown 同 route change 都會收埋 dropdown', () => {
    expect(source).toContain("document.addEventListener('pointerdown', onPointerDown)");
    expect(source).toMatch(/useEffect\(\(\) => \{\s*setMoreOpen\(false\);\s*\}, \[pathname\]\)/);
  });

  it('手機 drawer 無障礙保留（useDialogA11y：Esc＋focus trap＋滾動鎖）', () => {
    expect(source).toContain('useDialogA11y(() => setMenuOpen(false), menuOpen)');
  });
});

describe('Navbar responsive 合約（溢出防退化）', () => {
  it('WhatsApp 連字＋加寬 padding 2xl 起（1280/1440 icon-only）', () => {
    expect(source).toContain('btn-whatsapp min-h-11 !px-3 !py-2 text-sm 2xl:!px-4');
    expect(source).toContain('<span className="hidden 2xl:inline">WhatsApp</span>');
  });

  it('右 cluster／auth min-w-0，桌面會員名 truncate 且唔被 flex 壓縮', () => {
    expect(source).toContain('flex min-w-0 items-center gap-2 xl:gap-3');
    expect(source).toContain('hidden min-w-0 items-center gap-2.5 lg:flex');
    expect(source).toContain('nav-link min-w-0 max-w-40 shrink-0 truncate xl:max-w-48');
  });

  it('手機 DrawerRow label truncate（長會員名唔頂爆 drawer）', () => {
    expect(source).toContain('min-w-0 flex-1 truncate font-serif-tc text-2xl font-semibold');
  });

  it('桌面主導航 lg 起、間距 lg→xl 漸進（唔撞 logo／右 cluster）', () => {
    expect(source).toContain('hidden items-center gap-3 lg:flex xl:gap-4');
  });
});

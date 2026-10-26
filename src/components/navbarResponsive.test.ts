import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Navbar 頂欄溢出防退化（2026-10-26，camera agent T19 實測：1024 溢 50px、1280 溢 42px）。
 *
 * 直接掃 Navbar.tsx 源碼，鎖死以下 responsive 合約，任何人改返即刻紅：
 * - 中獎公告（lucky）頂欄 icon：xl 起先出（lg–xl 窄帶收喺「更多」dropdown）
 * - AI 試穿 CTA icon：lg 起保持（主打功能唔收埋）
 * - lucky／AI／WhatsApp 連字＋加寬 padding：2xl 起（1280/1440 icon-only）
 * - 「更多」dropdown 有 lg–xl 專用中獎公告 NavLink（xl:hidden），而且唔入 INFO_LINKS
 *   （手機 drawer 已有專屬 row，入 INFO_LINKS 會重複）
 * - 右 cluster／auth min-w-0＋會員名 truncate（長名唔再頂爆）
 */

const source = readFileSync(new URL('./Navbar.tsx', import.meta.url), 'utf8');

/** 抽出某個 to=... 嘅「頂欄 CTA」開 tag 區段（至 `>` 收口）做斷言。
 *  同一個 to 可能出現多次（頂欄 CTA／更多 dropdown／手機 drawer），
 *  頂欄 CTA 特徵係 className 入面有 inline-flex。 */
function navLinkBlock(to: string): string {
  let from = 0;
  for (;;) {
    const start = source.indexOf(`to="${to}"`, from);
    if (start < 0) return '';
    const end = source.indexOf('>', start);
    const block = source.slice(start, end);
    if (block.includes('inline-flex')) return block;
    from = end + 1;
  }
}

describe('Navbar responsive 合約（T19 溢出修正）', () => {
  it('lucky 頂欄 icon xl 起先出（lg–xl 唔出）', () => {
    const block = navLinkBlock('/lucky-results');
    expect(block).toContain('xl:inline-flex');
    expect(block).not.toContain('lg:inline-flex');
  });

  it('AI 試穿頂欄 icon 保持 lg 起', () => {
    const block = navLinkBlock('/try-on');
    expect(block).toContain('lg:inline-flex');
  });

  it('lucky／AI 連字同加寬 padding 由 2xl 起', () => {
    for (const to of ['/lucky-results', '/try-on']) {
      const block = navLinkBlock(to);
      expect(block).toContain('2xl:!px-4');
      // 注意「2xl:!px-4」本身就包含子串「xl:!px-4」，要用邊界 regex 先分得開
      expect(block).not.toMatch(/(^|\s)xl:!px-4/);
    }
    // label spans：AI 試穿／中獎公告／WhatsApp 全部 2xl 先出字
    const labels = source.match(/hidden (?:2xl|xl):inline/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.every((label) => label === 'hidden 2xl:inline')).toBe(true);
  });

  it('WhatsApp 連字＋padding 同樣 2xl 起', () => {
    expect(source).toContain('btn-whatsapp min-h-11 !px-3 !py-2 text-sm 2xl:!px-4');
  });

  it('「更多」dropdown 有 lg–xl 專用中獎公告（xl:hidden），唔入 INFO_LINKS', () => {
    // dropdown 入面嘅獨立 NavLink 帶 xl:hidden
    const dropdownLucky = source.match(/to="\/lucky-results"[\s\S]{0,400}?xl:hidden/);
    expect(dropdownLucky).not.toBeNull();
    // INFO_LINKS 定義唔准收 /lucky-results（手機 drawer 會重複）
    const infoLinks = source.slice(source.indexOf('const INFO_LINKS'), source.indexOf('];', source.indexOf('const INFO_LINKS')));
    expect(infoLinks).not.toContain('/lucky-results');
  });

  it('右 cluster／auth min-w-0，會員名 truncate', () => {
    expect(source).toContain('flex min-w-0 items-center gap-2 xl:gap-3');
    expect(source).toContain('hidden min-w-0 items-center gap-2.5 lg:flex');
    expect(source).toMatch(/nav-link min-w-0 max-w-40 truncate/);
  });
});

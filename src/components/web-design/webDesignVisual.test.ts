/**
 * webDesignVisual —— /web-design 首屏人物素材視覺回歸測試。
 *
 * 背景：用戶曾回報人物有白底、邊緣一格格白邊、手部好似被隱藏、首次顯示模糊。
 * 呢個測試直接 decode 實際會用到的 WebP（hero + 72 幀 = 18 張 row sheet），
 * 用像素級檢查鎖住已修復嘅狀態，防止回歸：
 *  1. 尺寸同 alpha channel 符合 SuitScroll.tsx 嘅硬編碼假設（864×1350 / 2880×1125）；
 *  2. 每一幀人物實體覆蓋率喺合理範圍（人物、手、鞋唔會整體消失或被裁走）；
 *  3. 半透明邊緣近白像素比例 < 2%（白邊／白格 regression guard）；
 *  4. 每幀 cell 內側邊界無長段不透明接觸（保證手臂擺動唔會被 cell 邊裁切）。
 *
 * 純 node 環境用 sharp decode，唔需要瀏覽器；瀏覽器層面嘅實際渲染截圖
 * 由 qa/visual 嘅 Playwright 證據覆蓋。
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../../../public/web-design', import.meta.url));
const FRAME_COLS = 4;
const FRAME_ROWS = 18;
const FRAME_WIDTH = 720;
const FRAME_HEIGHT = 1125;

interface Decoded {
  data: Buffer;
  width: number;
  height: number;
}

async function decode(name: string): Promise<Decoded> {
  const path = `${PUBLIC_DIR}/${name}`;
  expect(existsSync(path), `${name} 必須存在`).toBe(true);
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** 逐像素掃描一次，收集 alpha／白邊／覆蓋率統計。 */
function scan({ data, width, height }: Decoded) {
  const total = width * height;
  let transparent = 0;
  let opaque = 0;
  let semi = 0;
  let semiNearWhite = 0;
  for (let i = 0; i < total; i += 1) {
    const a = data[i * 4 + 3];
    if (a < 8) {
      transparent += 1;
    } else if (a > 247) {
      opaque += 1;
    } else {
      semi += 1;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      if (r > 200 && g > 200 && b > 200) semiNearWhite += 1;
    }
  }
  return { total, transparent, opaque, semi, semiNearWhite };
}

describe('webDesignVisual 人物素材', () => {
  it('hero 同 18 張 row sheet 尺寸同 alpha 符合播放器假設', async () => {
    const hero = await decode('character-hero.webp');
    expect([hero.width, hero.height]).toEqual([864, 1350]);
    for (let row = 0; row < FRAME_ROWS; row += 1) {
      const sheet = await decode(`character-walk-row-${row}.webp`);
      expect([sheet.width, sheet.height], `row-${row} 尺寸`).toEqual([
        FRAME_WIDTH * FRAME_COLS,
        FRAME_HEIGHT,
      ]);
    }
  });

  it('hero 透明背景、人物覆蓋率合理、邊緣無白邊污染', async () => {
    const s = scan(await decode('character-hero.webp'));
    const transparentRatio = s.transparent / s.total;
    const opaqueRatio = s.opaque / s.total;
    expect(transparentRatio).toBeGreaterThan(0.5); // 真透明背景，唔係白底
    expect(transparentRatio).toBeLessThan(0.95); // 人物確實存在
    expect(opaqueRatio).toBeGreaterThan(0.1); // 人體／衫／鞋實心不透明
    expect(s.semi).toBeGreaterThan(0);
    expect(s.semiNearWhite / s.semi).toBeLessThan(0.02); // 白邊 regression guard
  });

  it('72 幀每幀人物覆蓋率穩定，冇邊界裁切，冇白邊污染', async () => {
    for (let row = 0; row < FRAME_ROWS; row += 1) {
      const sheet = await decode(`character-walk-row-${row}.webp`);
      const sheetStats = scan(sheet);
      expect(sheetStats.semiNearWhite / sheetStats.semi, `row-${row} 白邊`).toBeLessThan(0.02);
      for (let col = 0; col < FRAME_COLS; col += 1) {
        let cellOpaque = 0;
        let edgeContact = 0;
        const x0 = col * FRAME_WIDTH;
        for (let y = 0; y < FRAME_HEIGHT; y += 1) {
          for (let x = x0; x < x0 + FRAME_WIDTH; x += 1) {
            const a = sheet.data[(y * sheet.width + x) * 4 + 3];
            if (a > 247) cellOpaque += 1;
          }
          // cell 內側 1px 邊界：長段不透明接觸 = 手／身體被 cell 邊裁切
          const edges = [
            sheet.data[(y * sheet.width + x0 + 1) * 4 + 3],
            sheet.data[(y * sheet.width + x0 + FRAME_WIDTH - 2) * 4 + 3],
          ];
          for (const a of edges) if (a > 30) edgeContact += 1;
        }
        for (let x = x0; x < x0 + FRAME_WIDTH; x += 1) {
          const topA = sheet.data[(sheet.width + x) * 4 + 3];
          const bottomA = sheet.data[((FRAME_HEIGHT - 2) * sheet.width + x) * 4 + 3];
          if (topA > 30) edgeContact += 1;
          if (bottomA > 30) edgeContact += 1;
        }
        const frameNo = row * FRAME_COLS + col;
        const coverage = cellOpaque / (FRAME_WIDTH * FRAME_HEIGHT);
        expect(coverage, `frame ${frameNo} 人物覆蓋率`).toBeGreaterThan(0.08);
        expect(coverage, `frame ${frameNo} 人物覆蓋率`).toBeLessThan(0.6);
        expect(edgeContact, `frame ${frameNo} 邊界裁切`).toBeLessThan(20);
      }
    }
  });
});

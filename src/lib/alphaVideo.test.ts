import { describe, expect, it } from 'vitest';
import { pixelsHaveRealAlpha } from '@/lib/alphaVideo';

/**
 * GloCutout 三層切換嘅判官：pixelsHaveRealAlpha（videoHasRealAlpha 嘅純像素核心）。
 * v2.2.57 雙保險規則：要同時見到透明（<250）同不透明（≥250）像素先算真 alpha——
 * 全 0 空白幀（WKWebView 時機誤判）同全 255 不透明片（Safari 解唔到 VP9 alpha）
 * 兩個方向都必須判 false，唔准黑盒跟全場。
 */
function rgba(alphas: number[]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((a, i) => {
    d[i * 4] = 128; d[i * 4 + 1] = 64; d[i * 4 + 2] = 200; d[i * 4 + 3] = a;
  });
  return d;
}

describe('pixelsHaveRealAlpha', () => {
  it('透明＋不透明並存 → 真 alpha', () => {
    expect(pixelsHaveRealAlpha(rgba([0, 255, 0, 255]))).toBe(true);
  });

  it('半透明（1–249）都算透明一侧', () => {
    expect(pixelsHaveRealAlpha(rgba([128, 255]))).toBe(true);
  });

  it('全 0 空白幀（未上到色）→ false，唔准誤判留喺冇 alpha 嘅片', () => {
    expect(pixelsHaveRealAlpha(rgba([0, 0, 0, 0]))).toBe(false);
  });

  it('全 255 不透明片（Safari 解唔到 alpha）→ false，觸發轉動畫 WebP', () => {
    expect(pixelsHaveRealAlpha(rgba([255, 255, 255, 255]))).toBe(false);
  });

  it('全半透明（冇實心像素）→ false', () => {
    expect(pixelsHaveRealAlpha(rgba([100, 200, 249]))).toBe(false);
  });

  it('邊界：249 當透明、250 當不透明', () => {
    expect(pixelsHaveRealAlpha(rgba([249, 250]))).toBe(true);
    expect(pixelsHaveRealAlpha(rgba([249, 249]))).toBe(false);
    expect(pixelsHaveRealAlpha(rgba([250, 250]))).toBe(false);
  });

  it('空陣列 → false（安全兜底）', () => {
    expect(pixelsHaveRealAlpha(new Uint8ClampedArray(0))).toBe(false);
  });
});

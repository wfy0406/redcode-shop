/**
 * v2.2.60 AnimatedLogo 重影根因修正測試（src/lib/animatedLogo.ts）
 * 覆蓋契約：三層（poster／video／anim）任何 mode × reduced 組合，
 * 永遠只有一層可見——component 即時切換（無 crossfade／opacity transition），
 * 所以「一層可見」唔單止係目標態，係任何時刻都成立：重影無可能出現。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { logoLayerVisibility, type LogoMode } from './animatedLogo';

const MODES: LogoMode[] = ['poster', 'video', 'anim'];

describe('logoLayerVisibility', () => {
  it('每個 mode 只有一層可見（即時切換不變量，唔准兩層疊加）', () => {
    for (const mode of MODES) {
      const v = logoLayerVisibility(mode, false);
      const visible = [v.poster, v.video, v.anim].filter(Boolean);
      expect(visible).toHaveLength(1);
    }
  });

  it('mode 對應層啱位', () => {
    expect(logoLayerVisibility('poster', false)).toEqual({ poster: true, video: false, anim: false });
    expect(logoLayerVisibility('video', false)).toEqual({ poster: false, video: true, anim: false });
    expect(logoLayerVisibility('anim', false)).toEqual({ poster: false, video: false, anim: true });
  });

  it('reduced-motion 無論 mode 係咩都淨係 poster', () => {
    for (const mode of MODES) {
      expect(logoLayerVisibility(mode, true)).toEqual({ poster: true, video: false, anim: false });
    }
  });
});

describe('重影根因 regression guard（老闆鐵律：唔准 crossfade）', () => {
  it('AnimatedLogo／GloCutout 源碼唔准有 transition class（即時切換）', () => {
    // 淨係捉 Tailwind transition class；comment 入面講「唔准 transition」唔算犯規
    const banned = /\btransition(?:-opacity|-transform|-all|-colors|-shadow)?\b(?=[\s"'`}])/;
    for (const rel of ['../components/AnimatedLogo.tsx', '../components/GloCutout.tsx']) {
      const src = readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
      const codeOnly = src
        .replace(/\/\*[\s\S]*?\*\//g, '') // Block comments
        .replace(/\/\/.*/g, ''); // Line comments
      expect(banned.test(codeOnly), `${rel} 唔准有 transition class`).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  FAIRY_ACTIONS,
  FAIRY_ACTION_ORDER,
  nextFairyAction,
  type FairyAction,
} from './fairyActions';

function asset(action: FairyAction, poster = false): URL {
  return new URL(`../../public/fairy/actions/${action}${poster ? '-poster' : ''}.webp`, import.meta.url);
}

function riffFrameDurations(buffer: Buffer): number[] {
  expect(buffer.subarray(0, 4).toString()).toBe('RIFF');
  expect(buffer.subarray(8, 12).toString()).toBe('WEBP');
  const durations: number[] = [];
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + 4).toString();
    const size = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (chunk === 'ANMF') durations.push(buffer.readUIntLE(payload + 12, 3));
    offset = payload + size + (size % 2);
  }
  return durations;
}

describe('Glo Glo 真動作透明動畫素材', () => {
  it('四套動作順序完整循環，唔係一個表情當完成', () => {
    expect(FAIRY_ACTION_ORDER).toEqual(['wave', 'dance', 'shy', 'play']);
    let action: FairyAction = 'wave';
    for (const expected of ['dance', 'shy', 'play', 'wave'] as const) {
      action = nextFairyAction(action);
      expect(action).toBe(expected);
    }
    for (const name of FAIRY_ACTION_ORDER) {
      const spec = FAIRY_ACTIONS[name];
      expect(spec.frames).toBe(6);
      expect(spec.cycleMs).toBe(spec.frames * spec.frameDurationMs);
      expect(spec.holdMs % spec.cycleMs).toBe(0);
      expect(spec.holdMs / spec.cycleMs).toBeGreaterThanOrEqual(2);
    }
  });

  it.each(FAIRY_ACTION_ORDER)('%s：六個已編碼畫面全部唔同，逐幀都有真 alpha', async (action) => {
    const spec = FAIRY_ACTIONS[action];
    const encoded = readFileSync(asset(action));
    expect(riffFrameDurations(encoded)).toEqual(Array(spec.frames).fill(spec.frameDurationMs));

    const { data, info } = await sharp(encoded, { animated: true }).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(384);
    expect(info.pageHeight).toBe(576);
    expect(info.pages).toBe(spec.frames);
    expect(info.height).toBe(576 * spec.frames);
    expect(info.channels).toBe(4);

    const frameBytes = info.width * 576 * info.channels;
    const hashes = new Set<string>();
    for (let frame = 0; frame < spec.frames; frame += 1) {
      const pixels = data.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      hashes.add(createHash('sha256').update(pixels).digest('hex'));
      let minAlpha = 255;
      let maxAlpha = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        minAlpha = Math.min(minAlpha, pixels[index]);
        maxAlpha = Math.max(maxAlpha, pixels[index]);
      }
      expect(minAlpha).toBe(0);
      expect(maxAlpha).toBe(255);
    }
    expect(hashes.size).toBe(spec.frames);

    const poster = await sharp(readFileSync(asset(action, true))).metadata();
    expect(poster.width).toBe(384);
    expect(poster.height).toBe(576);
    expect(poster.hasAlpha).toBe(true);
  });

  it('播放器沿用 logo 嘅透明 poster→動畫即時切換，冇 crossfade', () => {
    const source = readFileSync(new URL('./FairyActionAnimation.tsx', import.meta.url), 'utf8');
    const guide = readFileSync(new URL('./GlobalFairyGuide.tsx', import.meta.url), 'utf8');
    expect(source).toContain('data-fairy-poster={name === action ? name : undefined}');
    expect(source).toContain('data-fairy-animation={action}');
    expect(source).toContain('setReadyAction(action)');
    expect(source).toContain('const posterAction = loadedPosters.has(action) ? action : posterFallback;');
    expect(source).toContain('window.setTimeout(() => onHoldComplete(action), spec.holdMs)');
    expect(source).toContain('if (activeActionRef.current !== action) return;');
    expect(source).toContain("data-fairy-frame-mode={showAnimation ? 'animated' : 'loading'}");
    expect(source).not.toContain('transition:');
    expect(guide).toContain('animate={pageVisible && !reducedMotion}');
    expect(guide).toContain('replay={actionReplay}');
    expect(guide).toContain('onHoldComplete={completeFairyAction}');
    expect(guide).not.toContain('/fairy/glo-guide.png');
  });
});

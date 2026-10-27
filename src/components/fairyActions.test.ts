import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  FAIRY_ACTIONS,
  FAIRY_ACTION_ORDER,
  FAIRY_ALL_ACTIONS,
  FAIRY_GUIDE_ACTIONS,
  isFairyIdleAction,
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
  it('四套閒置動作順序完整循環，唔係一個表情當完成', () => {
    expect(FAIRY_ACTION_ORDER).toEqual(['wave', 'dance', 'shy', 'play']);
    expect(FAIRY_GUIDE_ACTIONS).toEqual(['point', 'scared']);
    expect(FAIRY_ALL_ACTIONS).toEqual(['wave', 'dance', 'shy', 'play', 'point', 'scared']);
    for (const guided of FAIRY_GUIDE_ACTIONS) {
      expect((FAIRY_ACTION_ORDER as readonly string[]).includes(guided)).toBe(false);
      expect(isFairyIdleAction(guided)).toBe(false);
    }
    expect(isFairyIdleAction('shy')).toBe(true);
    let action: FairyAction = 'wave';
    for (const expected of ['dance', 'shy', 'play', 'wave'] as const) {
      action = nextFairyAction(action);
      expect(action).toBe(expected);
    }
    for (const name of FAIRY_ACTION_ORDER) {
      const spec = FAIRY_ACTIONS[name];
      expect(spec.frames).toBe(60);
      expect(spec.frameDurationMs).toBe(40);
      expect(spec.cycleMs).toBe(2400);
      expect(spec.cycleMs).toBe(spec.frames * spec.frameDurationMs);
      expect(spec.holdMs % spec.cycleMs).toBe(0);
      // 每個完整動作停留 7200ms（3 個完整循環）；只加長停留，唔拖慢動作速度。
      expect(spec.holdMs).toBe(7200);
      expect(spec.holdMs / spec.cycleMs).toBe(3);
    }
    // 指引 point／拖曳 scared 由狀態即時切入切出，hold 只保底一個完整循環。
    expect(FAIRY_ACTIONS.point.holdMs).toBe(2400);
    expect(FAIRY_ACTIONS.scared.holdMs).toBe(2400);
    expect(FAIRY_ACTIONS.point.cycleMs).toBe(2400);
    expect(FAIRY_ACTIONS.scared.cycleMs).toBe(2400);
  });

  it.each(FAIRY_ALL_ACTIONS)('%s：60 個已編碼畫面全部唔同，逐幀都有真 alpha', async (action) => {
    const spec = FAIRY_ACTIONS[action];
    const encoded = readFileSync(asset(action));
    expect(riffFrameDurations(encoded)).toEqual(Array(spec.frames).fill(spec.frameDurationMs));

    const { data, info } = await sharp(encoded, { animated: true }).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(256);
    expect(info.pageHeight).toBe(384);
    expect(info.pages).toBe(spec.frames);
    expect(info.height).toBe(384 * spec.frames);
    expect(info.channels).toBe(4);

    const frameBytes = info.width * 384 * info.channels;
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
      // WebP 解碼器對完全唔透明像素可以有 1–2 級舍入差異；253–255 都係實質不透明。
      expect(maxAlpha).toBeGreaterThanOrEqual(250);
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

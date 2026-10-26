import { describe, expect, it } from 'vitest';
import {
  TRYON_CAMERA_ASPECT_RATIO,
  getTryOnCoverCrop,
  tryOnCameraVideoConstraints,
} from './tryonCamera';

describe('TryOn portrait camera constraints', () => {
  it.each(['user', 'environment'] as const)('requests a non-mandatory portrait stream for %s camera', (facingMode) => {
    const constraints = tryOnCameraVideoConstraints(facingMode);
    expect(constraints.facingMode).toEqual({ ideal: facingMode });
    expect(constraints.aspectRatio).toEqual({ ideal: 3 / 4 });
    expect(constraints.aspectRatio).toEqual({ ideal: TRYON_CAMERA_ASPECT_RATIO });
    expect(constraints.resizeMode).toEqual({ ideal: 'crop-and-scale' });
    expect(constraints.width).toEqual({ ideal: 1440 });
    expect(constraints.height).toEqual({ ideal: 1920 });
    expect(constraints).not.toHaveProperty('advanced');
  });
});

describe('TryOn cover crop matches the visible preview', () => {
  it('crops a landscape sensor stream to a centered 3:4 portrait frame', () => {
    const crop = getTryOnCoverCrop(1920, 1080, 375, 500);
    expect(crop.sourceX).toBeCloseTo(555);
    expect(crop.sourceY).toBe(0);
    expect(crop.sourceWidth).toBeCloseTo(810);
    expect(crop.sourceHeight).toBe(1080);
    expect(crop.sourceWidth / crop.sourceHeight).toBeCloseTo(3 / 4);
  });

  it('crops a tall native portrait stream without stretching', () => {
    const crop = getTryOnCoverCrop(1080, 1920, 375, 500);
    expect(crop.sourceX).toBe(0);
    expect(crop.sourceY).toBeCloseTo(240);
    expect(crop.sourceWidth).toBe(1080);
    expect(crop.sourceHeight).toBeCloseTo(1440);
    expect(crop.sourceWidth / crop.sourceHeight).toBeCloseTo(3 / 4);
  });

  it('uses the current desktop 4:5 frame ratio', () => {
    const crop = getTryOnCoverCrop(1600, 900, 400, 500);
    expect(crop.sourceX).toBeCloseTo(440);
    expect(crop.sourceY).toBe(0);
    expect(crop.sourceWidth).toBeCloseTo(720);
    expect(crop.sourceHeight).toBe(900);
    expect(crop.sourceWidth / crop.sourceHeight).toBeCloseTo(4 / 5);
  });

  it('keeps the whole frame when ratios already match', () => {
    expect(getTryOnCoverCrop(960, 1280, 375, 500)).toEqual({
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 960,
      sourceHeight: 1280,
    });
  });

  it('recomputes for a landscape frame instead of reusing the portrait crop', () => {
    const crop = getTryOnCoverCrop(1080, 1920, 844, 390);
    const expectedHeight = 1080 / (844 / 390);
    expect(crop.sourceX).toBe(0);
    expect(crop.sourceY).toBeCloseTo((1920 - expectedHeight) / 2, 5);
    expect(crop.sourceWidth).toBe(1080);
    expect(crop.sourceHeight).toBeCloseTo(expectedHeight, 5);
    expect(crop.sourceWidth / crop.sourceHeight).toBeCloseTo(844 / 390);
  });

  it.each([
    [0, 1080, 375, 500],
    [1920, Number.NaN, 375, 500],
    [1920, 1080, 0, 500],
    [1920, 1080, 375, Number.POSITIVE_INFINITY],
  ])('rejects invalid dimensions instead of producing a broken canvas', (videoW, videoH, frameW, frameH) => {
    expect(() => getTryOnCoverCrop(videoW, videoH, frameW, frameH)).toThrow('Invalid');
  });
});

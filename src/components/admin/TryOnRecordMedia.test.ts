import { describe, expect, it } from 'vitest';
import {
  TRYON_MEDIA_COPY,
  resolvePrivateMediaState,
  resolveProductMediaState,
} from './TryOnRecordMedia';

/**
 * 後台試穿紀錄三圖（TryOnRecordMedia）狀態歸納純邏輯測試。
 * 覆蓋：保留期（30 日）／未生成／loading／error／ready／商品圖三態，
 * 同「冇圖可保留」（生成未完成）優先於「已過保留期」嘅次序。
 */
describe('resolvePrivateMediaState', () => {
  const base = {
    status: 'completed',
    archiveAvailable: true,
    queryLoading: false,
    queryError: false,
    url: 'https://media.example/input?s=sig',
  };

  it('ready：archive 喺度＋endpoint 回 URL → 帶 URL 顯示', () => {
    expect(resolvePrivateMediaState({ ...base, kind: 'input' })).toEqual({
      kind: 'ready',
      url: 'https://media.example/input?s=sig',
    });
    expect(resolvePrivateMediaState({ ...base, kind: 'output' })).toEqual({
      kind: 'ready',
      url: 'https://media.example/input?s=sig',
    });
  });

  it('生成未完成／失敗 → 未有生成圖（原相唔受影響，一定有上載）', () => {
    for (const status of ['queued', 'processing', 'failed']) {
      expect(resolvePrivateMediaState({ ...base, kind: 'output', status })).toEqual({ kind: 'pending' });
      // 原相係會員上載，同生成狀態無關
      expect(resolvePrivateMediaState({ ...base, kind: 'input', status })).toEqual({
        kind: 'ready',
        url: 'https://media.example/input?s=sig',
      });
    }
  });

  it('「未有生成圖」優先於「已過保留期」：失敗工作根本冇生成圖可過期', () => {
    expect(
      resolvePrivateMediaState({ ...base, kind: 'output', status: 'failed', archiveAvailable: false }),
    ).toEqual({ kind: 'pending' });
  });

  it('archiveAvailable=false → 已過30日保留期（唔會打 endpoint，query 狀態無關）', () => {
    expect(resolvePrivateMediaState({ ...base, kind: 'input', archiveAvailable: false })).toEqual({
      kind: 'expired',
    });
    expect(
      resolvePrivateMediaState({ ...base, kind: 'input', archiveAvailable: false, queryError: true }),
    ).toEqual({ kind: 'expired' });
    expect(
      resolvePrivateMediaState({ ...base, kind: 'output', status: 'completed', archiveAvailable: false }),
    ).toEqual({ kind: 'expired' });
  });

  it('查詢中 → loading（骨架格）', () => {
    expect(resolvePrivateMediaState({ ...base, kind: 'input', queryLoading: true, url: undefined })).toEqual({
      kind: 'loading',
    });
  });

  it('查詢失敗 → error（顯示重試掣）', () => {
    expect(resolvePrivateMediaState({ ...base, kind: 'input', queryError: true, url: undefined })).toEqual({
      kind: 'error',
    });
    // loading 優先於 error（唔會同時閃兩格態）
    expect(
      resolvePrivateMediaState({ ...base, kind: 'input', queryLoading: true, queryError: true, url: undefined }),
    ).toEqual({ kind: 'loading' });
  });

  it('endpoint 回 null URL → 已過30日保留期（媒體已刪／到期嘅防禦性兜底）', () => {
    expect(resolvePrivateMediaState({ ...base, kind: 'input', url: null })).toEqual({ kind: 'expired' });
    expect(resolvePrivateMediaState({ ...base, kind: 'input', url: undefined })).toEqual({ kind: 'expired' });
    expect(resolvePrivateMediaState({ ...base, kind: 'output', url: null })).toEqual({ kind: 'expired' });
  });
});

describe('resolveProductMediaState', () => {
  it('有 URL 而且未載入失敗 → ready', () => {
    expect(resolveProductMediaState('https://cdn.example/top-101.jpg', false)).toEqual({
      kind: 'ready',
      url: 'https://cdn.example/top-101.jpg',
    });
  });

  it('冇 URL → 未有商品圖', () => {
    expect(resolveProductMediaState(null, false)).toEqual({ kind: 'unavailable' });
    expect(resolveProductMediaState(undefined, false)).toEqual({ kind: 'unavailable' });
  });

  it('<img> onError → 載入失敗（可重試）', () => {
    expect(resolveProductMediaState('https://cdn.example/top-101.jpg', true)).toEqual({ kind: 'error' });
  });

  it('冇 URL 時 onError 狀態唔覆蓋「未有商品圖」', () => {
    expect(resolveProductMediaState(null, true)).toEqual({ kind: 'unavailable' });
  });
});

describe('TRYON_MEDIA_COPY', () => {
  it('保留期文案：後台原相及生成圖只保留 30 日', () => {
    expect(TRYON_MEDIA_COPY.expired).toBe('已過30日保留期');
  });

  it('生成未完成／失敗文案：未有生成圖', () => {
    expect(TRYON_MEDIA_COPY.pendingOutput).toBe('未有生成圖');
  });

  it('三格 caption 同互動文案齊全', () => {
    expect(TRYON_MEDIA_COPY.inputCaption).toBe('客戶原相');
    expect(TRYON_MEDIA_COPY.outputCaption).toBe('AI 生成圖');
    expect(TRYON_MEDIA_COPY.productCaption).toBe('商品圖');
    expect(TRYON_MEDIA_COPY.viewImages).toBe('查看圖片');
    expect(TRYON_MEDIA_COPY.loadFailed).toBe('載入失敗');
    expect(TRYON_MEDIA_COPY.retry).toBe('重試');
    expect(TRYON_MEDIA_COPY.productUnavailable).toBe('未有商品圖');
  });
});

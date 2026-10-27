import { describe, expect, it } from 'vitest';
import { parseSharedParams } from './TryOnShared';

/** 模擬 URLSearchParams 嘅最小介面 */
function queryOf(entries: Record<string, string>) {
  return { get: (key: string) => (key in entries ? entries[key] : null) };
}

const VALID_ID = '0f3d2c1a-1111-4222-8333-abcdefabcdef';

describe('TryOnShared parseSharedParams（分享連結格式 /try-on/shared/:publicId?e=...&s=...）', () => {
  it('合法：path param publicId ＋ query e/s 齊全', () => {
    const result = parseSharedParams(VALID_ID, queryOf({ e: '1761902400000', s: 'sig_abc' }));
    expect(result).toEqual({
      publicId: VALID_ID,
      expires: 1761902400000,
      signature: 'sig_abc',
      paramsValid: true,
    });
  });

  it('publicId 嚟自 path param：query 冇 publicId 都唔會當無效', () => {
    // 舊寫法會用 searchParams.get('publicId')；而家 path param 有值即有效
    const result = parseSharedParams(VALID_ID, queryOf({ e: '1761902400000', s: 'sig' }));
    expect(result.paramsValid).toBe(true);
    expect(result.publicId).toBe(VALID_ID);
  });

  it('缺 path param publicId → 無效（就算 query 有 e/s）', () => {
    const result = parseSharedParams(undefined, queryOf({ e: '1761902400000', s: 'sig' }));
    expect(result.paramsValid).toBe(false);
    expect(result.publicId).toBe('');
  });

  it('缺 signature 或 e → 無效', () => {
    expect(parseSharedParams(VALID_ID, queryOf({ e: '1761902400000' })).paramsValid).toBe(false);
    expect(parseSharedParams(VALID_ID, queryOf({ s: 'sig' })).paramsValid).toBe(false);
    expect(parseSharedParams(VALID_ID, queryOf({})).paramsValid).toBe(false);
  });

  it('e 唔係正數毫秒時間戳 → 無效', () => {
    expect(parseSharedParams(VALID_ID, queryOf({ e: 'abc', s: 'sig' })).paramsValid).toBe(false);
    expect(parseSharedParams(VALID_ID, queryOf({ e: '0', s: 'sig' })).paramsValid).toBe(false);
    expect(parseSharedParams(VALID_ID, queryOf({ e: '-5', s: 'sig' })).paramsValid).toBe(false);
    expect(parseSharedParams(VALID_ID, queryOf({ e: '', s: 'sig' })).paramsValid).toBe(false);
  });
});

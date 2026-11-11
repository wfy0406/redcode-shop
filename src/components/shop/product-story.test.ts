import { describe, expect, it } from 'vitest';
import { hasStylingAdvice, splitStoryParagraphs } from './ProductStory';

describe('splitStoryParagraphs（空行分段、段內換行保留）', () => {
  it('空行分段，前後空白 trim 走', () => {
    expect(splitStoryParagraphs('第一段。\n\n  第二段。  \n\n\n第三段。')).toEqual([
      '第一段。',
      '第二段。',
      '第三段。',
    ]);
  });

  it('段內單行換行唔會拆段（交畀 pre-line 顯示）', () => {
    expect(splitStoryParagraphs('第一行\n第二行')).toEqual(['第一行\n第二行']);
  });

  it('null／空字串／純空白 → []', () => {
    expect(splitStoryParagraphs(null)).toEqual([]);
    expect(splitStoryParagraphs(undefined)).toEqual([]);
    expect(splitStoryParagraphs('')).toEqual([]);
    expect(splitStoryParagraphs('  \n\n  ')).toEqual([]);
  });

  it('兼容 Windows 換行', () => {
    expect(splitStoryParagraphs('甲\r\n\r\n乙')).toEqual(['甲', '乙']);
  });
});

describe('hasStylingAdvice（有配搭字樣先出免責句）', () => {
  it('提到「配搭」或「穿搭」→ true', () => {
    expect(hasStylingAdvice('可以配搭高腰褲著')).toBe(true);
    expect(hasStylingAdvice('日常穿搭好易襯')).toBe(true);
  });

  it('冇提配搭 → false（唔好多餘免責句）', () => {
    expect(hasStylingAdvice('布料柔軟，剪裁合身。')).toBe(false);
  });

  it('null／空字串 → false', () => {
    expect(hasStylingAdvice(null)).toBe(false);
    expect(hasStylingAdvice(undefined)).toBe(false);
    expect(hasStylingAdvice('')).toBe(false);
  });
});

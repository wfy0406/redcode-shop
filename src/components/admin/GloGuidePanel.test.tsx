/**
 * GloGuidePanel 純邏輯測試——唔掂 trpc／DOM，淨係驗面板用嘅閘口規則：
 * ─ 純文字字數（剝 [b]/[gold]/[pink]/[tag] 標記、空白唔計）同 service 150–300 閘一致；
 * ─ 編輯／提交／批准／落架嘅狀態閘（published 唔准改、生成中鎖住等）；
 * ─ 上傳檔 client 檢查（格式／10MB）＋ dataURL→base64。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BODY_MAX,
  BODY_MIN,
  bodyCountOk,
  canApproveArticle,
  canArchiveArticle,
  canEditArticle,
  canSubmitArticle,
  dataUrlToBase64,
  isGenerating,
  plainBodyCharCount,
  validateUploadFile,
} from './GloGuidePanel';

describe('plainBodyCharCount（同 service countBodyCodePoints 同一規則）', () => {
  it('格式標記唔計入字數', () => {
    const body = '[b]粗體[/b]同[gold]金色[/gold]同[tag]重點[/tag]';
    expect(plainBodyCharCount(body)).toBe([...'粗體同金色同重點'].length);
  });

  it('空白／換行唔計', () => {
    expect(plainBodyCharCount('ab c\n\nd　e')).toBe(5);
  });

  it('未閉合標記當普通文字（parser 容錯）', () => {
    expect(plainBodyCharCount('[b]未閉合')).toBe(3);
  });

  it('巢狀標記只計文字一次', () => {
    expect(plainBodyCharCount('[b][gold]四個字呀[/gold][/b]')).toBe(4);
  });
});

describe('bodyCountOk（150–300 硬閘）', () => {
  it('邊界：149 唔得、150 得、300 得、301 唔得', () => {
    expect(bodyCountOk(BODY_MIN - 1)).toBe(false);
    expect(bodyCountOk(BODY_MIN)).toBe(true);
    expect(bodyCountOk(BODY_MAX)).toBe(true);
    expect(bodyCountOk(BODY_MAX + 1)).toBe(false);
  });
});

describe('文章狀態閘', () => {
  it('published 唔准改；生成中唔准改；draft 可以改', () => {
    expect(canEditArticle({ status: 'published', generationStatus: 'idle' })).toBe(false);
    expect(canEditArticle({ status: 'draft', generationStatus: 'queued' })).toBe(false);
    expect(canEditArticle({ status: 'draft', generationStatus: 'processing' })).toBe(false);
    expect(canEditArticle({ status: 'draft', generationStatus: 'idle' })).toBe(true);
    expect(canEditArticle({ status: 'rejected', generationStatus: 'idle' })).toBe(true);
  });

  it('isGenerating 只認 queued／processing', () => {
    expect(isGenerating({ generationStatus: 'queued' })).toBe(true);
    expect(isGenerating({ generationStatus: 'processing' })).toBe(true);
    expect(isGenerating({ generationStatus: 'idle' })).toBe(false);
    expect(isGenerating({ generationStatus: 'failed' })).toBe(false);
  });

  it('submit 只限 draft／rejected', () => {
    expect(canSubmitArticle('draft')).toBe(true);
    expect(canSubmitArticle('rejected')).toBe(true);
    expect(canSubmitArticle('pending_review')).toBe(false);
    expect(canSubmitArticle('published')).toBe(false);
    expect(canSubmitArticle('archived')).toBe(false);
  });

  it('approve 只限 pending_review；archive 只限 published', () => {
    expect(canApproveArticle('pending_review')).toBe(true);
    expect(canApproveArticle('draft')).toBe(false);
    expect(canApproveArticle('published')).toBe(false);
    expect(canArchiveArticle('published')).toBe(true);
    expect(canArchiveArticle('draft')).toBe(false);
    expect(canArchiveArticle('archived')).toBe(false);
  });
});

describe('上傳檔檢查', () => {
  it('格式白名單：JPEG/PNG/WebP 先得', () => {
    expect(validateUploadFile({ size: 100, type: 'image/png' })).toBeNull();
    expect(validateUploadFile({ size: 100, type: 'image/jpeg' })).toBeNull();
    expect(validateUploadFile({ size: 100, type: 'image/webp' })).toBeNull();
    expect(validateUploadFile({ size: 100, type: 'image/gif' })).toContain('只支援');
    expect(validateUploadFile({ size: 100, type: 'text/html' })).toContain('只支援');
  });

  it('10MB 上限', () => {
    expect(validateUploadFile({ size: 10 * 1024 * 1024, type: 'image/png' })).toBeNull();
    expect(validateUploadFile({ size: 10 * 1024 * 1024 + 1, type: 'image/png' })).toContain('10MB');
  });

  it('dataUrlToBase64：剝 data: 前綴；壞字串回 null', () => {
    expect(dataUrlToBase64('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(dataUrlToBase64('QUJD')).toBeNull();
    expect(dataUrlToBase64('data:image/png;base64,')).toBeNull();
  });
});

describe('CTA 樣式硬標準（source guard：深色實心＋金色描邊＋金字）', () => {
  const css = readFileSync(path.join(__dirname, 'GloGuidePanel.css'), 'utf8');
  const block = (sel: string): string => {
    const i = css.indexOf(`${sel} {`);
    expect(i, `搵唔到 ${sel}`).toBeGreaterThanOrEqual(0);
    const j = css.indexOf('}', i);
    return css.slice(i, j + 1);
  };

  it('所有按鈕／chip 深色實底——唔准透明、唔准金底 gradient', () => {
    for (const sel of [
      '.ggp-btn',
      '.ggp-btn-primary',
      '.ggp-btn-danger',
      '.ggp-btn-ghost',
      '.ggp-chip',
      '.ggp-tool',
      '.ggp-product',
    ]) {
      const b = block(sel);
      expect(b, sel).not.toContain('transparent');
      expect(b, sel).not.toContain('gradient');
      expect(b, sel).toMatch(/background:\s*#[0-9a-f]{6}/i);
    }
    const pressed = block(".ggp-chip[aria-pressed='true']");
    expect(pressed).not.toContain('transparent');
    expect(pressed).toMatch(/background:\s*#[0-9a-f]{6}/i);
  });

  it('hover 唔會變金底（唔准 gradient／深字金底）', () => {
    for (const sel of ['.ggp-btn:hover:not(:disabled)', '.ggp-btn-primary:hover:not(:disabled)']) {
      const b = block(sel);
      expect(b, sel).not.toContain('gradient');
      expect(b, sel).not.toContain('#241a08');
      expect(b, sel).toMatch(/background:\s*#[0-9a-f]{6}/i);
    }
  });

  it('觸控熱區 ≥44px（btn／chip／tool）', () => {
    expect(block('.ggp-btn')).toContain('min-height: 44px');
    expect(block('.ggp-chip')).toContain('min-height: 44px');
    expect(block('.ggp-tool')).toContain('min-height: 44px');
  });

  it('檔頭註解講明深色實心＋金色描邊標準', () => {
    const head = css.slice(0, css.indexOf('*/'));
    expect(head).toContain('深色實心');
    expect(head).toContain('唔准透明');
  });
});

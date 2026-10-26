import { describe, expect, it } from 'vitest';
import {
  TRYON_RECORD_STATUSES,
  describeTryOnRecord,
  fmtMemberPhone,
  jobBadge,
  lookBadge,
  paginationSummary,
  shortId,
  tryOnRecordStatusMeta,
  type TryOnRecordItem,
} from './tryOnRecordsMeta';

/** 最小假 item（型別由 AppRouter 推斷；淨係測 helper 邏輯用） */
function makeItem(overrides: Partial<TryOnRecordItem> = {}): TryOnRecordItem {
  return {
    jobId: 1,
    publicId: '123e4567-e89b-42d3-a456-426614174000',
    lookId: '223e4567-e89b-42d3-a456-426614174000',
    stepNumber: 1,
    status: 'completed',
    failureCode: null,
    member: { id: 7, name: '陳小明', phone: '91234567' },
    product: {
      id: 101,
      name: '白色恤衫',
      sku: 'TOP-101',
      category: 'top',
      tryOnKind: 'top',
      exists: true,
      changed: false,
      currentName: '白色恤衫',
      currentSku: 'TOP-101',
    },
    mediaDeleted: false,
    createdAt: new Date('2026-10-25T10:00:00Z'),
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as TryOnRecordItem;
}

describe('tryOnRecordStatusMeta', () => {
  it('四個已知狀態有中文 label', () => {
    expect(tryOnRecordStatusMeta('queued').label).toBe('排隊中');
    expect(tryOnRecordStatusMeta('processing').label).toBe('生成中');
    expect(tryOnRecordStatusMeta('completed').label).toBe('完成');
    expect(tryOnRecordStatusMeta('failed').label).toBe('失敗');
  });

  it('未知狀態兜底原字顯示，唔會炸', () => {
    expect(tryOnRecordStatusMeta('mystery').label).toBe('mystery');
  });

  it('篩選選項同後端枚舉一致', () => {
    expect(TRYON_RECORD_STATUSES.map((s) => s.value)).toEqual(['queued', 'processing', 'completed', 'failed']);
  });
});

describe('fmtMemberPhone', () => {
  it('8 位 → XXXX XXXX；852 開頭 → 852 XXXX XXXX；其他原樣；空 → 空字串', () => {
    expect(fmtMemberPhone('91234567')).toBe('9123 4567');
    expect(fmtMemberPhone('85291234567')).toBe('852 9123 4567');
    expect(fmtMemberPhone('+852-9123-4567')).toBe('852 9123 4567');
    expect(fmtMemberPhone('12345')).toBe('12345');
    expect(fmtMemberPhone('')).toBe('');
    expect(fmtMemberPhone(null)).toBe('');
  });
});

describe('describeTryOnRecord（邊個試穿邊件）', () => {
  it('會員名＋商品 snapshot 名＋第幾件', () => {
    expect(describeTryOnRecord(makeItem())).toBe('陳小明 試穿咗 白色恤衫（第 1 件）');
  });

  it('第二步＋已刪會員兜底', () => {
    expect(describeTryOnRecord(makeItem({ stepNumber: 2, product: { ...makeItem().product, name: '牛仔褲' } }))).toBe(
      '陳小明 試穿咗 牛仔褲（第 2 件）',
    );
    expect(describeTryOnRecord(makeItem({ member: null }))).toBe('已刪除會員 試穿咗 白色恤衫（第 1 件）');
  });
});

describe('paginationSummary / shortId', () => {
  it('分頁概要', () => {
    expect(paginationSummary(1, 5, 97)).toBe('第 1 / 5 頁・共 97 條');
    expect(paginationSummary(1, 0, 0)).toBe('共 0 條');
    expect(paginationSummary(1, 0, 3)).toBe('第 1 / 1 頁・共 3 條'); // 後端 totalPages 兜底
  });

  it('shortId 取頭 8 位', () => {
    expect(shortId('123e4567-e89b-42d3-a456-426614174000')).toBe('123e4567');
    expect(shortId('abc')).toBe('abc');
  });

  it('lookBadge／jobBadge：縮短標籤；完整 id 由 title／aria-label 帶出', () => {
    const item = makeItem();
    expect(lookBadge(item.lookId)).toBe('造型 #223e4567');
    expect(jobBadge(item.publicId)).toBe('工作 #123e4567');
    // badge 只係縮短顯示——完整 id 仍然存在 item 上（title/aria-label 用），唔會消失
    expect(item.lookId).toBe('223e4567-e89b-42d3-a456-426614174000');
    expect(item.publicId).toBe('123e4567-e89b-42d3-a456-426614174000');
  });
});

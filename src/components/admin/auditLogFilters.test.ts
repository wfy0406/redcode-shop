import { describe, expect, it } from 'vitest';
import { AUDIT_FILTERS, filterAuditRowsByAction } from './auditLogFilters';

const rows = [
  { id: 1, action: 'order.create' },
  { id: 2, action: 'tryon.create' },
  { id: 3, action: 'member.register' },
  { id: 4, action: 'tryon.completed' },
  { id: 5, action: 'other.tryon.create' },
];

describe('官網日誌「試穿」分類', () => {
  it('後台篩選列有「試穿」分類', () => {
    expect(AUDIT_FILTERS).toContainEqual(expect.objectContaining({ key: 'tryon', label: '試穿' }));
  });

  it('只顯示 tryon. 動作，唔會混入訂單、會員或其他 prefix', () => {
    expect(filterAuditRowsByAction(rows, 'tryon').map((row) => row.id)).toEqual([2, 4]);
  });

  it('未知分類安全回退全部，原有全部分類唔受影響', () => {
    expect(filterAuditRowsByAction(rows, 'missing')).toEqual(rows);
    expect(filterAuditRowsByAction(rows, 'all')).toEqual(rows);
  });
});

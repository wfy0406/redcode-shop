import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../api/router';

/**
 * AI 試穿紀錄面板共用型別＋純邏輯 helper（畫面同測試共用，唔好喺组件入面複製）。
 * 後端 response 型別由 AppRouter 推斷——後端改欄位，呢度即刻 type error。
 */
type RouterOutputs = inferRouterOutputs<AppRouter>;
export type TryOnRecordsPageData = RouterOutputs['tryon']['listAdminRecords'];
export type TryOnRecordItem = TryOnRecordsPageData['items'][number];
export type TryOnRecordStatus = 'queued' | 'processing' | 'completed' | 'failed';

export const TRYON_RECORD_STATUSES: { value: TryOnRecordStatus; label: string }[] = [
  { value: 'queued', label: '排隊中' },
  { value: 'processing', label: '生成中' },
  { value: 'completed', label: '完成' },
  { value: 'failed', label: '失敗' },
];

const STATUS_META: Record<TryOnRecordStatus, { label: string; dot: string; className: string }> = {
  queued: { label: '排隊中', dot: 'var(--gold)', className: 'border-space-line text-txt-2' },
  processing: { label: '生成中', dot: 'var(--lavender)', className: 'border-space-line text-txt-2' },
  completed: { label: '完成', dot: 'var(--success)', className: 'border-space-line text-txt-2' },
  failed: { label: '失敗', dot: 'var(--pink-soft)', className: 'border-space-line text-txt-2' },
};

/** 狀態 meta（未知狀態兜底：原字顯示，唔會炸） */
export function tryOnRecordStatusMeta(status: string): { label: string; dot: string; className: string } {
  return (
    (STATUS_META as Record<string, { label: string; dot: string; className: string }>)[status] ?? {
      label: String(status),
      dot: 'var(--text-3)',
      className: 'border-space-line text-txt-3',
    }
  );
}

/** 香港電話格式化：8 位 → XXXX XXXX；852 開頭 11 位 → 852 XXXX XXXX；其他原樣（同 BoundDeviceList 一致） */
export function fmtMemberPhone(p: string | null | undefined): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (/^852\d{8}$/.test(d)) return `852 ${d.slice(3, 7)} ${d.slice(7)}`;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)} ${d.slice(4)}`;
  return p;
}

/** 「邊個試穿邊件」一句過描述（卡片主行／aria-label 用） */
export function describeTryOnRecord(item: TryOnRecordItem): string {
  const who = item.member?.name ?? '已刪除會員';
  return `${who} 試穿咗 ${item.product.name}（第 ${item.stepNumber} 件）`;
}

/** 分頁概要字：「第 1 / 5 頁・共 97 條」；冇資料 → 「共 0 條」 */
export function paginationSummary(page: number, totalPages: number, total: number): string {
  if (total <= 0) return '共 0 條';
  return `第 ${page} / ${Math.max(1, totalPages)} 頁・共 ${total} 條`;
}

/** uuid 縮短顯示（前 8 位）；唔係 uuid 就原樣頭 8 位 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 造型（look）標籤：「造型 #123e4567」（縮短顯示；完整 lookId 由 title／aria-label 帶出） */
export function lookBadge(lookId: string): string {
  return `造型 #${shortId(lookId)}`;
}

/** 工作（job）標籤：「工作 #123e4567」（縮短顯示；完整 publicId 由 title／aria-label 帶出） */
export function jobBadge(publicId: string): string {
  return `工作 #${shortId(publicId)}`;
}

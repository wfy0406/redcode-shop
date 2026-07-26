import { cn } from '@/lib/utils';
import type { OrderStatus } from './types';

/**
 * 訂單狀態 badge（§P8 + 狀態語義色）
 * pending_payment 待付款＝金邊金點 / payment_review 審核中＝紫 /
 * approved 已確認＝綠 / rejected 已拒絕＝粉紅 / shipped 已寄出＝紫 /
 * completed 完成＝綠 / cancelled 已取消＝灰紫
 */

const STATUS_META: Record<OrderStatus, { label: string; className: string; dotClassName?: string }> = {
  pending_payment: {
    label: '待付款',
    className: 'border-gold text-gold',
    dotClassName: 'bg-gold',
  },
  payment_review: {
    label: '審核中',
    className: 'border-purple-text text-purple-text',
  },
  approved: {
    label: '已確認',
    className: 'border-success text-success',
  },
  rejected: {
    label: '已拒絕',
    className: 'border-pink text-pink-soft',
  },
  shipped: {
    label: '已寄出',
    className: 'border-purple-text text-purple-text',
  },
  completed: {
    label: '完成',
    className: 'border-success text-success',
  },
  cancelled: {
    label: '已取消',
    className: 'border-space-line text-txt-3',
  },
};

export default function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      aria-label={`訂單狀態：${meta.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-space-2 px-3 py-1 text-[13px] font-medium leading-none',
        meta.className,
      )}
    >
      {meta.dotClassName && (
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', meta.dotClassName)} aria-hidden="true" />
      )}
      {meta.label}
    </span>
  );
}

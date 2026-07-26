import { Clock, Hourglass, BadgeCheck, Truck, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { OrderStatus } from './types';

/**
 * 訂單狀態 badge（R3 §1 配色階梯 + lucide icon 雙重編碼）
 * 進行中狀態用 palette 色階梯：待付款=--gold → 審核中=--lavender → 已確認=--pink → 已出貨=--pink 深級；
 * 終態先出灰綠／中性灰／暖紅。bg 12% 透明、text 全色、1px 同色 30% 邊（深底友好）。
 */

/** 由 --pink 向紅推導嘅暖紅（同飽和同明度），rejected 專用 */
export const REJECT_RED = '#FF6B5B';

interface StatusMeta {
  label: string;
  color: string;
  icon: LucideIcon;
  /** 深級 variant：bg／邊加重一級（shipped 比 approved 重） */
  strong?: boolean;
  /** 待付款金色呼吸（要行動嘅單先搶眼） */
  pulse?: boolean;
}

const STATUS_META: Record<OrderStatus, StatusMeta> = {
  pending_payment: { label: '待付款', color: 'var(--gold)', icon: Clock, pulse: true },
  payment_review: { label: '審核中', color: 'var(--lavender)', icon: Hourglass },
  approved: { label: '已確認', color: 'var(--pink)', icon: BadgeCheck },
  shipped: { label: '已出貨', color: 'var(--pink-soft)', icon: Truck, strong: true },
  completed: { label: '已完成', color: 'var(--success)', icon: CheckCircle2 },
  cancelled: { label: '已取消', color: 'var(--text-3)', icon: XCircle },
  rejected: { label: '已拒絕', color: REJECT_RED, icon: AlertCircle },
};

export default function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      aria-label={`訂單狀態：${meta.label}`}
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium leading-none transition-[color,border-color,background-color] duration-200"
      style={{
        color: meta.color,
        borderColor: `color-mix(in srgb, ${meta.color} ${meta.strong ? 45 : 30}%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} ${meta.strong ? 20 : 12}%, transparent)`,
      }}
    >
      <Icon size={13} aria-hidden="true" className={cn(meta.pulse && 'animate-pulse')} />
      {meta.label}
    </span>
  );
}

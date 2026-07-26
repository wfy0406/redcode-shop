import { Clock, Hourglass, BadgeCheck, Truck, CheckCircle2, AlertCircle, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { REJECT_RED } from './StatusBadge';
import type { OrderStatus } from './types';

/**
 * 訂單狀態時間線（R3 §1：五步橫向 stepper，lucide icon + 細字）
 * pending_payment → payment_review → approved → shipped → completed
 * - 已完成步：主色 --pink
 * - 當前步：--pink + 光效（pink-glow 外圈）
 * - 未到步：--text-3 + --space-line
 * - rejected／cancelled：唔顯示 stepper，改顯示終態標記
 * 每步 transition 0.2s，唔做入場動效。
 */

const STEPS: { label: string; icon: LucideIcon }[] = [
  { label: '待付款', icon: Clock },
  { label: '審核中', icon: Hourglass },
  { label: '已確認', icon: BadgeCheck },
  { label: '已出貨', icon: Truck },
  { label: '已完成', icon: CheckCircle2 },
];

type StepStatus = Exclude<OrderStatus, 'rejected' | 'cancelled'>;

const STATUS_INDEX: Record<StepStatus, number> = {
  pending_payment: 0,
  payment_review: 1,
  approved: 2,
  shipped: 3,
  completed: 4,
};

type StepState = 'done' | 'current' | 'upcoming';

function stepState(status: StepStatus, index: number): StepState {
  if (status === 'completed') return 'done';
  const current = STATUS_INDEX[status];
  if (index < current) return 'done';
  if (index === current) return 'current';
  return 'upcoming';
}

function StepNode({ state, icon: Icon }: { state: StepState; icon: LucideIcon }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-[color,border-color,background-color,box-shadow] duration-200"
      style={
        state === 'done'
          ? {
              color: 'var(--pink)',
              borderColor: 'color-mix(in srgb, var(--pink) 45%, transparent)',
              background: 'color-mix(in srgb, var(--pink) 12%, transparent)',
            }
          : state === 'current'
            ? {
                color: 'var(--pink)',
                borderColor: 'var(--pink)',
                background: 'color-mix(in srgb, var(--pink) 18%, transparent)',
                boxShadow:
                  '0 0 0 3px color-mix(in srgb, var(--pink) 20%, transparent), 0 0 16px var(--pink-glow)',
              }
            : {
                color: 'var(--text-3)',
                borderColor: 'var(--space-line)',
              }
      }
    >
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}

/** rejected／cancelled 終態標記（取代 stepper） */
function TerminalMarker({ status }: { status: 'rejected' | 'cancelled' }) {
  const rejected = status === 'rejected';
  const Icon = rejected ? AlertCircle : XCircle;
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-[13px]"
      style={{ color: rejected ? REJECT_RED : 'var(--text-3)' }}
    >
      <Icon size={15} aria-hidden="true" />
      {rejected ? '訂單已被拒絕 · 請重新上傳付款截圖' : '訂單已取消'}
    </p>
  );
}

export default function OrderTimeline({ status }: { status: OrderStatus }) {
  if (status === 'rejected' || status === 'cancelled') {
    return <TerminalMarker status={status} />;
  }

  const reached = STATUS_INDEX[status];
  return (
    <ol aria-label="訂單進度" className="flex items-start">
      {STEPS.map((step, i) => {
        const state = stepState(status, i);
        return (
          <li key={step.label} className="flex flex-1 flex-col items-center gap-1.5 last:flex-none">
            <span className="flex w-full items-center">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className="h-px flex-1 transition-[background-color] duration-200"
                  style={{ background: i <= reached ? 'var(--pink)' : 'var(--space-line)' }}
                />
              )}
              <StepNode state={state} icon={step.icon} />
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className="h-px flex-1 transition-[background-color] duration-200"
                  style={{ background: i < reached ? 'var(--pink)' : 'var(--space-line)' }}
                />
              )}
            </span>
            <span
              className={cn(
                'whitespace-nowrap text-[12px] leading-none transition-colors duration-200',
                state === 'current' ? 'font-medium text-pink-soft' : state === 'done' ? 'text-txt-1' : 'text-txt-3',
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

import { cn } from '@/lib/utils';
import type { OrderStatus } from './types';

/**
 * 訂單狀態時間線（§P8：金星節點）
 * 步驟點：下單 → 上傳截圖 → 審核 → 確認 → 寄出
 * - 完成步驟：金色四角星填金
 * - 當前步驟：金色 + 呼吸光圈
 * - 未到步驟：--space-line 暗星
 * - rejected：審核節點轉粉紅（拒絕）
 * - cancelled：全線降暗，只保留下單節點
 */

const STEPS = ['下單', '上傳截圖', '審核', '確認', '寄出'] as const;

type StepState = 'done' | 'current' | 'upcoming' | 'failed' | 'dim';

function stepStates(status: OrderStatus): StepState[] {
  switch (status) {
    case 'pending_payment':
      return ['done', 'current', 'upcoming', 'upcoming', 'upcoming'];
    case 'payment_review':
      return ['done', 'done', 'current', 'upcoming', 'upcoming'];
    case 'approved':
      return ['done', 'done', 'done', 'done', 'current'];
    case 'rejected':
      return ['done', 'done', 'failed', 'upcoming', 'upcoming'];
    case 'shipped':
      return ['done', 'done', 'done', 'done', 'done'];
    case 'completed':
      return ['done', 'done', 'done', 'done', 'done'];
    case 'cancelled':
      return ['done', 'dim', 'dim', 'dim', 'dim'];
  }
}

function Star({ state }: { state: StepState }) {
  const fill =
    state === 'done' || state === 'current'
      ? 'var(--gold)'
      : state === 'failed'
        ? 'var(--pink)'
        : 'var(--space-line)';
  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center">
      {state === 'current' && (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full"
          style={{ background: 'rgba(245,197,24,0.35)' }}
        />
      )}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="relative">
        <path
          d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
          fill={fill}
        />
      </svg>
    </span>
  );
}

export default function OrderTimeline({ status }: { status: OrderStatus }) {
  const states = stepStates(status);
  return (
    <ol aria-label="訂單進度" className="flex items-start">
      {STEPS.map((label, i) => {
        const state = states[i];
        const lineDone = state === 'done';
        return (
          <li key={label} className="flex flex-1 flex-col items-center gap-1.5 last:flex-none">
            <span className="flex w-full items-center">
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className="h-px flex-1"
                  style={{ background: lineDone ? 'var(--gold)' : 'var(--space-line)' }}
                />
              )}
              <Star state={state} />
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden="true"
                  className="h-px flex-1"
                  style={{
                    background: states[i + 1] !== 'upcoming' && states[i + 1] !== 'dim' ? 'var(--gold)' : 'var(--space-line)',
                  }}
                />
              )}
            </span>
            <span
              className={cn(
                'whitespace-nowrap text-[12px] leading-none',
                state === 'done' || state === 'current'
                  ? 'text-gold'
                  : state === 'failed'
                    ? 'text-pink-soft'
                    : 'text-txt-3',
              )}
            >
              {state === 'failed' ? '已拒絕' : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

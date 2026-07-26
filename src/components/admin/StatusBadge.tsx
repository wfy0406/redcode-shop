import { ORDER_STATUS_META } from './statusMeta';
import type { OrderStatus } from './types';

/** 訂單狀態 badge —— 每個 badge 有 aria-label，唔齋靠色 */
export default function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = ORDER_STATUS_META[status];
  return (
    <span
      aria-label={`訂單狀態：${meta.label}`}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-[13px] leading-none ${meta.className}`}
    >
      {meta.dot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: meta.dot }}
          aria-hidden="true"
        />
      )}
      {meta.label}
    </span>
  );
}

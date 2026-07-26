import type { ToastKind, ToastMsg } from './useToasts';

/**
 * 玻璃 toast stack —— 固定喺右上（右下係 WhatsApp 浮鈕位）
 */
const KIND_DOT: Record<ToastKind, string> = {
  success: 'var(--success)',
  info: 'var(--info)',
  error: 'var(--pink-soft)',
};

export default function ToastStack({ toasts }: { toasts: ToastMsg[] }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed right-4 top-20 z-[70] flex w-[min(92vw,340px)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-3 backdrop-blur-xl"
          style={{
            background: 'var(--glass-bg-strong)',
            borderColor: 'var(--glass-border)',
            animation: 'toast-in 300ms var(--ease-expo)',
          }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: KIND_DOT[t.kind] }}
            aria-hidden="true"
          />
          <p className="text-[14px] leading-snug text-txt-1">{t.text}</p>
        </div>
      ))}
      {/* keyframes 用 inline <style>，避免改全局 index.css */}
      <style>{`@keyframes toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}

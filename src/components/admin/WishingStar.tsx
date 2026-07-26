/**
 * §3.7 許願星 loading —— 金色四角星旋轉閃爍（唔用 spinner）
 * star-spin keyframes 喺 index.css 全局定義。
 */
export default function WishingStar({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-flex animate-pulse items-center justify-center"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        style={{ animation: 'star-spin 1.2s linear infinite' }}
      >
        <path
          d="M12 1.5 L14.2 9.8 L22.5 12 L14.2 14.2 L12 22.5 L9.8 14.2 L1.5 12 L9.8 9.8 Z"
          fill="var(--gold)"
        />
      </svg>
    </span>
  );
}

/** 局部 loading 區塊：許願星 + 輔助字 */
export function LoadingBlock({ text = '載入緊…' }: { text?: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 py-16"
      role="status"
      aria-live="polite"
    >
      <WishingStar size={28} />
      <p className="text-[14px] text-txt-3">{text}</p>
    </div>
  );
}

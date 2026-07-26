import { memo } from 'react';

/**
 * RedCode 設計系統 §3.7 —— 許願星 Loading（唔好用 spinner）
 * 金色四角星（SVG 兩條弧線組成嘅星芒形）：rotate 360° / 1.2s linear infinite + opacity 呼吸。
 * 獨立 memo 微組件（react-dev.md：無限循環動畫要隔離，防 parent re-render 重置動畫）。
 *
 * 用法：局部 loading <WishingStar size={16} />；頁面級 loading <WishingStar size={48} label="許願星載入中…" />
 */
interface WishingStarProps {
  /** 星星尺寸 px（§3.7 按鈕內用 16px） */
  size?: number;
  /** 星下面嘅輔助文字（可選） */
  label?: string;
  className?: string;
}

function WishingStarInner({ size = 16, label, className }: WishingStarProps) {
  return (
    <span
      role="status"
      aria-label={label ?? '載入中'}
      className={className}
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}
    >
      <svg
        className="wishing-star"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="var(--gold)"
        aria-hidden="true"
      >
        <path d="M12 1.5c.9 5.8 4.7 9.6 10.5 10.5-5.8.9-9.6 4.7-10.5 10.5-.9-5.8-4.7-9.6-10.5-10.5C7.3 11.1 11.1 7.3 12 1.5Z" />
      </svg>
      {label ? <span className="font-mono text-sm text-gold-soft">{label}</span> : null}
      <style>{`
        .wishing-star {
          transform-origin: center;
          animation: star-spin 1.2s linear infinite, wish-star-breathe 1.2s ease-in-out infinite;
        }
        @keyframes wish-star-breathe {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wishing-star { animation: none; opacity: 1; }
        }
      `}</style>
    </span>
  );
}

const WishingStar = memo(WishingStarInner);
export default WishingStar;

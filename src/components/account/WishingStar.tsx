/**
 * RedCode 設計系統 §3.7 —— 許願星（Wishing Star）
 * 唔好用 spinner：金色四角星（兩條弧線組成嘅星芒形）。
 * - loading 態：rotate 360° / 1.2s linear infinite + opacity 呼吸
 * - 靜態態：純金色四角星（dropzone 中央、時間線節點用）
 */

interface WishingStarProps {
  /** 星星尺寸（px） */
  size?: number;
  /** true = 旋轉閃爍 loading 態 */
  spinning?: boolean;
  className?: string;
}

export default function WishingStar({ size = 16, spinning = false, className }: WishingStarProps) {
  const star = (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
      style={spinning ? { animation: 'star-spin 1.2s linear infinite' } : undefined}
    >
      <path
        d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
        fill="var(--gold)"
      />
    </svg>
  );

  if (!spinning) return star;

  return (
    <span role="status" aria-label="載入中" className="inline-flex animate-pulse items-center justify-center">
      {star}
    </span>
  );
}

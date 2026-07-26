import type { CSSProperties } from 'react';

/**
 * RedCode 設計系統 §3.7 —— 許願星（Wishing Star）
 * 唔好用 spinner：局部 loading 用 16px 金色四角星旋轉閃爍；
 * 結帳成功用一次性星爆 + 呼吸發光。reduced-motion 全部降格做靜態星。
 */

interface StarGlyphProps {
  size?: number;
  color?: string;
  className?: string;
}

/** 金色四角星 SVG（兩條弧線組成嘅星芒形） */
export function StarGlyph({ size = 16, color = 'var(--gold)', className }: StarGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 1.5c.9 5.8 4.7 9.6 10.5 10.5-5.8.9-9.6 4.7-10.5 10.5-.9-5.8-4.7-9.6-10.5-10.5C7.3 11.1 11.1 7.3 12 1.5Z"
        fill={color}
      />
    </svg>
  );
}

const SPIN_STYLES = `
@keyframes wish-star-breathe { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
.wish-star-spin { animation: star-spin 1.2s linear infinite, wish-star-breathe 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .wish-star-spin { animation: none; } }
`;

/** §3.7 局部 loading：原位金色四角星旋轉閃爍（按鈕提交、上傳中、載入） */
export function WishStarSpinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="inline-flex items-center justify-center gap-2" role="status">
      <span className="wish-star-spin inline-flex" aria-hidden="true">
        <StarGlyph size={size} />
      </span>
      {label ? <span>{label}</span> : <span className="sr-only">載入中</span>}
      <style>{SPIN_STYLES}</style>
    </span>
  );
}

const BURST_STYLES = `
@keyframes wish-burst-in {
  0% { transform: scale(.2) rotate(-40deg); opacity: 0; }
  60% { opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
@keyframes wish-glow { 0%, 100% { opacity: .82; } 50% { opacity: 1; } }
.wish-burst-star {
  animation: wish-burst-in 900ms var(--ease-expo) both, wish-glow 3s ease-in-out 1s infinite;
  filter: drop-shadow(0 0 18px rgba(245, 197, 24, .45));
}
@keyframes wish-spark {
  0% { transform: translate(0, 0) scale(.4); opacity: 0; }
  30% { opacity: 1; }
  100% { transform: translate(var(--dx), var(--dy)) scale(1); opacity: 0; }
}
.wish-spark {
  position: absolute; left: 50%; top: 50%;
  width: 5px; height: 5px; margin: -2.5px 0 0 -2.5px;
  border-radius: 9999px; background: var(--gold);
  animation: wish-spark 900ms var(--ease-expo) both;
}
@media (prefers-reduced-motion: reduce) {
  .wish-burst-star { animation: none; }
  .wish-spark { animation: none; opacity: 0; }
}
`;

/** 結帳成功：許願星著燈 —— 主星放大轉正 + 8 粒小金星向外飛，之後呼吸發光 */
export function WishStarBurst() {
  const sparks = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const dist = 44 + (i % 3) * 7;
    return {
      '--dx': `${Math.round(Math.cos(angle) * dist)}px`,
      '--dy': `${Math.round(Math.sin(angle) * dist)}px`,
      animationDelay: `${i * 40}ms`,
    } as CSSProperties;
  });

  return (
    <div className="relative flex h-28 w-28 items-center justify-center" aria-hidden="true">
      <span className="wish-burst-star inline-flex">
        <StarGlyph size={76} />
      </span>
      {sparks.map((style, i) => (
        <span key={i} className="wish-spark" style={style} />
      ))}
      <style>{BURST_STYLES}</style>
    </div>
  );
}

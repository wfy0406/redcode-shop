/**
 * 表單小組件共用庫（2026-10-09 訪客購買抽出）
 * 原本全部內聯喺 Checkout.tsx；訪客結帳／查單都要用，抽出嚟兩邊共用，唔好複製貼上兩份。
 * 內容同 Checkout 原版逐字相同（design.md §1.6 指定重用）。
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { WishStarSpinner } from '@/components/cart/WishingStar';

/* ---------- 複製鈕（DM Mono 帳號 / 訂單編號用） ---------- */
export function CopyButton({ text, label = '複製' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard 唔可用就靜默（用戶仍可手動抄）
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="btn btn-secondary shrink-0 !px-4 !py-2 !text-[13px]"
      aria-label={`${label} ${text}`}
    >
      {copied ? (
        <>
          <Check size={14} aria-hidden="true" /> 已複製
        </>
      ) : (
        <>
          <Copy size={14} aria-hidden="true" /> {label}
        </>
      )}
    </button>
  );
}

/* ---------- §3.7 流星頭進度條（上傳中／跳轉付款平台等待中） ---------- */
export const METEOR_STYLES = `
@keyframes meteor-run { from { transform: translateX(-110%); } to { transform: translateX(260%); } }
.meteor-segment { animation: meteor-run 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .meteor-segment { animation: none; transform: translateX(60%); } }
`;

export function MeteorProgressBar({ text = '上傳緊，唔好閂頁面…' }: { text?: string }) {
  return (
    <div className="mt-5" role="status" aria-label={text}>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-space-4">
        <span
          className="meteor-segment absolute inset-y-0 left-0 w-2/5 rounded-full"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--gold))',
          }}
        />
      </div>
      <p className="mt-2.5 flex items-center justify-center gap-2 text-[13px] text-txt-3">
        <WishStarSpinner size={14} />
        {text}
      </p>
      <style>{METEOR_STYLES}</style>
    </div>
  );
}

/* ---------- F5 優惠碼：choreography 動效 keyframes ---------- */
export const PROMO_STYLES = `
@keyframes promo-check-draw { to { stroke-dashoffset: 0; } }
@keyframes promo-dot-bounce { 0%, 100% { transform: scale(.75); opacity: .4; } 50% { transform: scale(1); opacity: 1; } }
@keyframes promo-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes promo-total-in { from { opacity: .35; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
@keyframes promo-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) {
  .promo-check-path { animation: none !important; stroke-dashoffset: 0 !important; }
  .promo-dot { animation: none !important; opacity: 1 !important; }
  .promo-shimmer-bg { animation: none !important; }
}
`;

/** 貨圖縮圖：載入前微光掃掠底，載入後 0.5s 淡入（唔會空白一格格） */
export function BlurThumb({ src, className = 'h-16 w-16' }: { src: string; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      className={`relative block shrink-0 overflow-hidden rounded-lg border border-space-line ${className}`}
      style={{ background: 'var(--space-2)' }}
    >
      {!loaded && (
        <span
          className="promo-shimmer-bg absolute inset-0"
          aria-hidden="true"
          style={{
            background: 'linear-gradient(110deg, var(--space-2) 30%, var(--space-3, #241B3E) 50%, var(--space-2) 70%)',
            backgroundSize: '200% 100%',
            animation: 'promo-shimmer 1.3s linear infinite',
          }}
        />
      )}
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className="h-full w-full object-cover transition-opacity duration-500"
        style={{ opacity: loaded ? 1 : 0 }}
      />
    </span>
  );
}

/** 成功剔號（stroke-draw 0.3s，R3 §4 micro-interaction） */
export function StrokeCheck({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        className="promo-check-path"
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{
          strokeDasharray: 24,
          strokeDashoffset: 24,
          animation: 'promo-check-draw .3s cubic-bezier(0.65,0,0.45,1) forwards',
        }}
      />
    </svg>
  );
}

/** 行內三點跳動 loading（0.8s staggered，唔好用成版 WishingStar） */
export function DotsLoader() {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label="驗證緊">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="promo-dot inline-block h-1 w-1 rounded-full bg-current"
          style={{ animation: `promo-dot-bounce .8s ease-in-out ${i * 0.12}s infinite` }}
        />
      ))}
    </span>
  );
}

/**
 * 訪客單 30 分鐘付款倒數（2026-10-09）—— design.md §3.1「靜靜地催」三級制：
 *  > 10:00 淡定（金，圓環順滑退）｜10:00–03:00 提醒（金＋外圈光暈＋每 60s 呼吸）
 *  < 03:00 尾段（粉紅字，唔閃爍）｜到 0 唔跳掣，caller 負責 refetch 轉「已逾時」
 * 無障礙：role="timer"；> 5:00 時 aria-live="off"（每秒讀出會煩），< 5:00 改 polite 每 30s 報一次。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

const FULL_SECONDS = 30 * 60; // 契約：30 分鐘付款保留

export function useGuestCountdown(initialSeconds: number | null, onExpire?: () => void) {
  const [secondsLeft, setSecondsLeft] = useState<number>(initialSeconds ?? 0);
  const expiredFired = useRef(false);

  // server 返新 secondsLeft（refetch 後）就重校
  useEffect(() => {
    if (initialSeconds !== null) {
      setSecondsLeft(initialSeconds);
      expiredFired.current = initialSeconds <= 0;
    }
  }, [initialSeconds]);

  useEffect(() => {
    if (secondsLeft <= 0) {
      if (!expiredFired.current) {
        expiredFired.current = true;
        onExpire?.();
      }
      return;
    }
    const t = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [secondsLeft > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  return secondsLeft;
}

export function formatMMSS(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 三級制 MM:SS 倒數，兩種版型：
 * - inline（預設）：44px 金色進度圓環＋細字，嵌喺卡入行內
 * - hero：特大 tabular-nums 數字做主角（付款頁專用），下面一條金色髮絲進度線；
 *   倒數就係畫面主角，唔加多餘裝飾
 * 兩款都係 >10:00 淡定金 ｜ 10:00–03:00 提醒金 ｜ <03:00 粉紅（唔閃爍）
 */
export default function GuestCountdown({ secondsLeft, variant = 'inline' }: { secondsLeft: number; variant?: 'inline' | 'hero' }) {
  const ratio = Math.max(0, Math.min(1, secondsLeft / FULL_SECONDS));
  // 圓環幾何：r=18，周長 2πr≈113.1
  const R = 18;
  const CIRC = 2 * Math.PI * R;
  const tier: 'calm' | 'remind' | 'final' = secondsLeft > 600 ? 'calm' : secondsLeft > 180 ? 'remind' : 'final';
  // 提醒級每 60s 呼吸一下（key 綁分鐘數 re-mount 觸發一次性 scale）
  const breathKey = Math.floor(secondsLeft / 60);

  const numberColor = tier === 'final' ? 'var(--pink)' : 'var(--gold)';
  const labelled = useMemo(() => formatMMSS(secondsLeft), [secondsLeft]);

  /* hero：置頂大數字＋全寬髮絲進度線（付款頁主角位） */
  if (variant === 'hero') {
    return (
      <div
        className="flex flex-col items-center"
        role="timer"
        aria-live={secondsLeft < 300 ? 'polite' : 'off'}
        aria-label={`留貨時間剩餘 ${labelled}`}
      >
        <span
          className="font-mono font-bold tabular-nums leading-none"
          style={{
            fontSize: 'clamp(56px, 15vw, 88px)',
            letterSpacing: '-0.02em',
            color: numberColor,
            textShadow: tier === 'final' ? '0 0 26px rgba(255,0,84,0.35)' : '0 0 26px rgba(245,197,24,0.22)',
          }}
        >
          {labelled}
        </span>
        <div className="mt-5 h-[3px] w-full overflow-hidden rounded-full bg-space-4" aria-hidden="true">
          <div
            className="h-full rounded-full"
            style={{
              width: `${ratio * 100}%`,
              background:
                tier === 'final'
                  ? 'linear-gradient(90deg, var(--pink-tint), var(--pink))'
                  : 'linear-gradient(90deg, var(--gold-soft), var(--gold))',
              transition: 'width 1s linear',
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3"
      role="timer"
      aria-live={secondsLeft < 300 ? 'polite' : 'off'}
      aria-label={`留貨時間剩餘 ${labelled}`}
    >
      <svg
        width="44"
        height="44"
        viewBox="0 0 44 44"
        aria-hidden="true"
        key={tier === 'remind' ? breathKey : tier}
        style={tier === 'remind' ? { animation: 'guest-cd-breath .6s ease-in-out' } : undefined}
      >
        <circle cx="22" cy="22" r={R} fill="none" stroke="var(--space-4)" strokeWidth="3" />
        {tier === 'remind' && (
          <circle cx="22" cy="22" r={R + 3.5} fill="none" stroke="rgba(245,197,24,0.25)" strokeWidth="1.5" />
        )}
        <circle
          cx="22"
          cy="22"
          r={R}
          fill="none"
          stroke="var(--gold)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - ratio)}
          transform="rotate(-90 22 22)"
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      <span
        className="font-mono text-lg font-bold tabular-nums"
        style={{ color: numberColor }}
      >
        {labelled}
      </span>
      <style>{`
        @keyframes guest-cd-breath { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }
        @media (prefers-reduced-motion: reduce) { [role="timer"] svg { animation: none !important; } }
      `}</style>
    </div>
  );
}

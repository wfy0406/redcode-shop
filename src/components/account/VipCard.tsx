import { Link } from 'react-router';
import { Crown } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import VipBadge, { normalizeVipTier } from '@/components/VipBadge';

/**
 * 會員中心 VIP 區塊卡（v2.1.0 VIP+免運，2026-09-29）—— trpc.vip.getMyVip
 * 內容：而家級別（大字 badge）＋有效期（NONE 唔顯示）＋本年度已累積消費＋
 * 去下一級進度條（金會員顯示「你係我哋最高級會員 ♡」）＋「了解會員制度 →」去 /vip。
 * 設計跟會員中心現有玻璃卡風格；金／銀用級別色做邊框同標題色。
 * 金額：API 回整數仙，顯示 ÷100 轉港元（千分位，唔出小數）。
 */

/** 仙 → $X,XXX（整數港元，千分位） */
function fmtHKDFromCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-HK')}`;
}

/** Date/ISO → 2027年1月5日 */
function fmtDateTc(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export default function VipCard() {
  const vipQuery = trpc.vip.getMyVip.useQuery();

  // 載入失敗唔好阻住會員中心，成張卡收埋（Navbar badge 仲會顯示級別）
  if (vipQuery.isError) return null;

  const vip = vipQuery.data;
  const tier = vip ? normalizeVipTier(vip.tier) : 'NONE';

  // 級別色：金／銀卡邊框同標題跟級別；普通會員用返玻璃預設
  const accentColor =
    tier === 'GOLD' ? '#F5C518' : tier === 'SILVER' ? '#C0C0C0' : 'var(--glass-border)';

  // 進度條：普通→銀門檻；銀→金門檻；金→滿級
  const nextTierLabel = tier === 'SILVER' ? 'VIP金會員' : 'VIP銀會員';
  const targetCents =
    tier === 'SILVER' ? (vip?.goldThresholdCents ?? 0) : (vip?.silverThresholdCents ?? 0);
  const progressPct =
    vip && targetCents > 0
      ? Math.min(100, Math.round((vip.yearSpendCents / targetCents) * 100))
      : 0;

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{
        borderColor: accentColor,
        background: 'var(--glass-bg)',
        boxShadow:
          tier === 'GOLD'
            ? '0 0 24px rgba(245, 197, 24, 0.15)'
            : tier === 'SILVER'
              ? '0 0 24px rgba(192, 192, 192, 0.10)'
              : 'none',
      }}
      aria-label="我的會員級別"
    >
      {vipQuery.isLoading || !vip ? (
        <div className="flex items-center gap-3 py-4 text-[13px] text-txt-3">
          <WishingStar size={18} spinning />
          許願星搬緊你嘅會員級別…
        </div>
      ) : (
        <>
          {/* 頂行：大 badge ＋ 有效期 */}
          <div className="flex flex-wrap items-center gap-3">
            <VipBadge tier={tier} size="lg" />
            {tier !== 'NONE' && vip.expiresAt && (
              <p className="text-[13px] text-txt-2">
                {tier === 'GOLD' ? 'VIP金會員' : 'VIP銀會員'}・有效期至{' '}
                <span className="font-mono">{fmtDateTc(vip.expiresAt)}</span>
              </p>
            )}
          </div>

          {/* 本年度累積消費 */}
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-[13px] text-txt-3">本年度已累積消費</span>
            <span
              className="font-mono text-[26px] font-bold leading-none"
              style={{ color: tier === 'NONE' ? 'var(--starlight)' : accentColor }}
            >
              {fmtHKDFromCents(vip.yearSpendCents)}
            </span>
          </div>

          {/* 升級進度／滿級訊息 */}
          {tier === 'GOLD' ? (
            <p className="mt-3 flex items-center gap-1.5 text-[14px] font-bold" style={{ color: '#F5C518' }}>
              <Crown size={15} aria-hidden="true" />
              你係我哋最高級會員 ♡
            </p>
          ) : (
            <div className="mt-3">
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ background: 'var(--space-3)' }}
                role="progressbar"
                aria-valuenow={progressPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`升級進度 ${progressPct}%`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${progressPct}%`,
                    background:
                      tier === 'SILVER'
                        ? 'linear-gradient(90deg, #C0C0C0, #F5C518)'
                        : 'linear-gradient(90deg, var(--lavender), #C0C0C0)',
                  }}
                />
              </div>
              <p className="mt-2 text-[13px] text-txt-2">
                再消費{' '}
                <span className="font-mono font-bold text-txt-1">
                  {fmtHKDFromCents(vip.toNextTierCents)}
                </span>{' '}
                即升 {nextTierLabel}
              </p>
            </div>
          )}

          {/* 了解會員制度 */}
          <Link
            to="/vip"
            className="mt-4 inline-flex items-center gap-1 text-[13px] font-bold text-lavender underline underline-offset-4 transition-colors hover:text-txt-1"
          >
            了解會員制度 →
          </Link>
        </>
      )}
    </section>
  );
}

import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * VIP 級別 badge（v2.1.0 VIP+免運，2026-09-29）—— 導覽列／會員中心／後台會員列表共用
 * NONE：「會員」低調灰；SILVER：「VIP銀會員」銀色漸變 pill；GOLD：「VIP金會員」金色漸變 pill＋小星星閃爍。
 * 動畫只用 opacity（tailwind animate-pulse），唔用會影響排版嘅屬性。
 */

export type VipTier = 'NONE' | 'SILVER' | 'GOLD';

export const VIP_TIER_LABEL: Record<VipTier, string> = {
  NONE: '會員',
  SILVER: 'VIP銀會員',
  GOLD: 'VIP金會員',
};

/** 未知/未載入嘅值一律當普通會員顯示（後端列表未回欄位時唔會炸） */
export function normalizeVipTier(tier: unknown): VipTier {
  return tier === 'SILVER' || tier === 'GOLD' ? tier : 'NONE';
}

const SIZE_CLS = {
  sm: 'px-2 py-0.5 text-[11px] gap-1',
  md: 'px-2.5 py-1 text-[12px] gap-1.5',
  lg: 'px-4 py-1.5 text-[15px] gap-1.5',
} as const;

export default function VipBadge({
  tier,
  size = 'sm',
  className,
}: {
  tier: VipTier;
  size?: keyof typeof SIZE_CLS;
  className?: string;
}) {
  const base =
    'inline-flex items-center whitespace-nowrap rounded-full border font-bold leading-none';
  if (tier === 'GOLD') {
    return (
      <span
        className={cn(base, SIZE_CLS[size], className)}
        style={{
          background: 'linear-gradient(135deg, #F7D774 0%, #F5C518 45%, #D9A514 100%)',
          borderColor: '#F5C518',
          color: '#3A2A00',
          boxShadow: '0 0 10px rgba(245, 197, 24, 0.35)',
        }}
      >
        <Sparkles
          size={size === 'lg' ? 15 : 12}
          strokeWidth={2.5}
          aria-hidden="true"
          className="animate-pulse"
        />
        VIP金會員
      </span>
    );
  }
  if (tier === 'SILVER') {
    return (
      <span
        className={cn(base, SIZE_CLS[size], className)}
        style={{
          background: 'linear-gradient(135deg, #F0F0F0 0%, #C0C0C0 50%, #A9A9A9 100%)',
          borderColor: '#C0C0C0',
          color: '#33333D',
        }}
      >
        VIP銀會員
      </span>
    );
  }
  return (
    <span
      className={cn(base, SIZE_CLS[size], 'font-medium', className)}
      style={{ borderColor: 'var(--space-line)', color: 'var(--text-3)' }}
    >
      會員
    </span>
  );
}

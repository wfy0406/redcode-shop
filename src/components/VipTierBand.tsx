import { Link } from 'react-router';
import { vipTierTheme, type VipTierKey } from '@/lib/vipTheme';
import { trpc } from '@/providers/trpc';

/**
 * v2.2.0 級別格調帶（購物車／結帳／付款頁頂共用）
 * 老闆指示：VIP 銀／金／普通會員喺全網介面要有唔同格調。
 * - VIP：hairline 金線框 + 級別淡底 wash + tier 專屬短句（克制，唔浮誇）
 * - NONE：唔出帶，淨係一行低調升級提示連去 /#/vip
 * ⚠ 主題色／class 全部來自 src/lib/vipTheme.ts 字面量，唔准自己創色。
 * v2.2.0 門檻凍結：短句嘅折扣數由 vip.getPublicVipConfig derive（後台改全網跟）；
 * config 未返嚟之前唔顯示折扣數（淨級別名，唔准閃舊數字）。
 */

/** 付款比率 bps → 中文折頭（9200 →「92 折」、9000 →「9 折」）：v=bps/100，v 整除 10 就除多一個 0 */
function bpsToDiscountLabel(bps: number): string {
  const v = bps / 100;
  return v % 10 === 0 ? `${v / 10} 折` : `${v} 折`;
}

export default function VipTierBand({ tier }: { tier: VipTierKey }) {
  const t = vipTierTheme(tier);
  const configQuery = trpc.vip.getPublicVipConfig.useQuery(undefined, {
    staleTime: 60_000,
    retry: 1,
  });
  const cfg = configQuery.data ?? null;

  /* tier 專屬短句（由後台規則 derive；config 未返就淨級別名，唔顯示折扣數） */
  const tierLine =
    t.key === 'GOLD'
      ? cfg
        ? `金會員・全年 ${bpsToDiscountLabel(cfg.goldDiscountBps)}・全年免運`
        : '金會員'
      : cfg
        ? `銀會員・全年 ${bpsToDiscountLabel(cfg.silverDiscountBps)}`
        : '銀會員';

  // 普通會員：低調升級提示（一行文字連結，唔出框唔出 chip）
  if (!t.isVip) {
    return (
      <p className="mt-5 text-[13px] tracking-wide text-txt-3">
        <Link
          to="/vip"
          className="underline underline-offset-4 transition-colors hover:text-txt-1"
          aria-label="了解 VIP 會員制度"
        >
          了解 VIP 會員制度：全年折扣・金會員全年免運 →
        </Link>
      </p>
    );
  }

  return (
    <div
      className={`mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-5 py-3.5 ${t.hairlineClass} ${t.washClass}`}
      aria-label={`會員級別：${t.label}`}
    >
      <span className={t.chipClass}>
        {t.seal} {t.shortLabel}
      </span>
      <span className="text-[13px] tracking-[0.12em]" style={{ color: t.softText }}>
        {tierLine}
      </span>
      <Link
        to="/vip"
        className="ml-auto text-[12px] tracking-[0.1em] underline underline-offset-4"
        style={{ color: t.accentDeep }}
        aria-label={`了解${t.label}禮遇`}
      >
        會員禮遇 →
      </Link>
    </div>
  );
}

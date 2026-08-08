import { useState } from 'react';
import { Link } from 'react-router';
import { Check, Copy, Landmark, Lock, LogIn, Receipt, Smartphone, Zap } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useReveal } from '@/hooks/useReveal';
import WishingStar from '@/components/shop/WishingStar';
import { trpc } from '@/providers/trpc';
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHODS_SETTING_KEY,
  parsePaymentMethods,
} from '@contracts/paymentMethods';

/**
 * 付款方式 /payment（會員限定）
 * 登入會員先睇到 RedCode 收款資料：中銀／PayMe／Alipay／FPS 識別碼
 * 每項資料一撳複製；底部提示付款後留低收據或截圖。
 * 2026-08-08（Glo 要求）：收款資料改由 siteSettings「payment_methods」讀（後台業務分析 → 收款方式，
 * 管理員限定），同結帳頁同一來源全網同步；冇設定就用 contracts 入面嘅預設值。
 */

/** 4 個固定 id 嘅 icon＋色映射（資料可以改，icon 款式跟 id） */
const ICON_MAP: Record<string, { icon: React.ReactNode; color: string }> = {
  boc: { icon: <Landmark size={22} aria-hidden="true" />, color: 'var(--gold)' },
  payme: { icon: <Smartphone size={22} aria-hidden="true" />, color: 'var(--pink-soft)' },
  alipay: { icon: <Zap size={22} aria-hidden="true" />, color: 'var(--lavender)' },
  fps: { icon: <Receipt size={22} aria-hidden="true" />, color: 'var(--success)' },
};

interface CopyButtonProps {
  value: string;
  label: string;
}

function CopyButton({ value, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard API 唔 work（舊瀏覽器/非 https）就用 fallback
      const el = document.createElement('textarea');
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      className="btn btn-secondary !px-4 !py-2 text-[13px]"
      aria-label={`複製${label}`}
    >
      {copied ? (
        <>
          <Check size={14} aria-hidden="true" className="text-success" />
          已複製
        </>
      ) : (
        <>
          <Copy size={14} aria-hidden="true" />
          複製
        </>
      )}
    </button>
  );
}

interface MethodCardProps {
  icon: React.ReactNode;
  iconColor: string;
  title: string;
  subtitle: string;
  rows: { label: string; value: string; copyable?: boolean }[];
  delay: number;
}

function MethodCard({ icon, iconColor, title, subtitle, rows, delay }: MethodCardProps) {
  return (
    <div
      className="reveal rounded-[24px] border p-6 backdrop-blur-xl md:p-8"
      style={{
        borderColor: 'var(--glass-border)',
        background: 'var(--glass-bg)',
        transitionDelay: `${delay}ms`,
      }}
    >
      <div className="flex items-center gap-4">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: iconColor, color: iconColor }}
        >
          {icon}
        </span>
        <div>
          <h2 className="font-serif-tc text-xl font-bold leading-[1.3] text-txt-1">{title}</h2>
          <p className="text-sm text-txt-3">{subtitle}</p>
        </div>
      </div>
      <div className="mt-6 space-y-4">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border px-5 py-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <div className="min-w-0">
              <p className="text-[12px] tracking-wide text-txt-3">{row.label}</p>
              <p className="mt-1 break-all font-mono text-lg font-medium leading-[1.2] text-starlight md:text-xl">
                {row.value}
              </p>
            </div>
            {row.copyable !== false && <CopyButton value={row.value} label={row.label} />}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Payment() {
  const { user, isLoading } = useAuth();
  const gridRef = useReveal<HTMLDivElement>();
  // 收款方式（全網統一來源）：後台改咗呢度同結帳頁一齊更新；冇設定用預設
  const methodsQuery = trpc.settings.get.useQuery({ key: PAYMENT_METHODS_SETTING_KEY });
  const methodsEntry = methodsQuery.data as { key: string; value: string } | null | undefined;
  const methods = methodsEntry?.value ? parsePaymentMethods(methodsEntry.value) : DEFAULT_PAYMENT_METHODS;

  /* ---------- Loading：核實緊會員身份 ---------- */
  if (isLoading) {
    return (
      <section className="flex min-h-[60dvh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <WishingStar size={32} />
          <p className="text-[14px] text-txt-3">核實緊會員身份…</p>
        </div>
      </section>
    );
  }

  /* ---------- 未登入：擋住，提示登入 ---------- */
  if (!user) {
    return (
      <section className="mx-auto flex max-w-[1280px] justify-center px-5 py-24 md:px-8">
        <div
          className="w-full max-w-[420px] rounded-3xl border p-8 text-center backdrop-blur-xl"
          style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
        >
          <span
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border"
            style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
          >
            <Lock size={20} aria-hidden="true" />
          </span>
          <p className="script mt-4 text-3xl">members only ✦</p>
          <h1 className="mt-2 font-serif-tc text-2xl font-bold leading-[1.3] text-txt-1">
            付款方式只限會員睇
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-txt-2">
            為咗保障收款資料安全，請先登入會員，登入後即刻睇到全部付款方法。
          </p>
          <div className="mt-6">
            <Link to="/login" state={{ from: '/payment' }} className="btn btn-primary w-full">
              <LogIn size={16} aria-hidden="true" />
              登入會員
            </Link>
          </div>
        </div>
      </section>
    );
  }

  /* ---------- 已登入：付款方式 ---------- */
  return (
    <section className="mx-auto max-w-[1280px] px-5 py-16 md:px-8 md:py-24 xl:px-12">
      <header className="text-center">
        <p className="script text-3xl md:text-4xl">pay with love ✦</p>
        <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
          付款方式
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-[1.75] text-txt-2">
          以下係 RedCode 官方收款資料，揀你最方便嘅方法付款就得。
          記得核對清楚戶名先好過數 ♡
        </p>
      </header>

      <div ref={gridRef} className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
        {methods.map((m, i) => {
          const meta = ICON_MAP[m.id] ?? {
            icon: <Receipt size={22} aria-hidden="true" />,
            color: 'var(--gold)',
          };
          return (
            <MethodCard
              key={m.id}
              icon={meta.icon}
              iconColor={meta.color}
              title={`${m.label} 🌟`}
              subtitle={m.subtitle}
              delay={i * 80}
              rows={[
                { label: m.accountLabel, value: m.account },
                ...(m.extraLabel && m.extraValue
                  ? [{ label: m.extraLabel, value: m.extraValue, copyable: false }]
                  : []),
              ]}
            />
          );
        })}
      </div>

      {/* 付款後提示 */}
      <div
        className="reveal mx-auto mt-10 max-w-4xl rounded-[24px] border px-6 py-8 text-center md:px-10"
        style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
      >
        <p className="font-mono text-xs tracking-[0.2em] text-gold">AFTER PAYMENT</p>
        <p className="mt-3 font-serif-tc text-xl font-semibold leading-[1.5] text-starlight md:text-2xl">
          付款後請留下收據或截圖 🧾
        </p>
        <p className="mx-auto mt-3 max-w-lg text-[14px] leading-[1.75] text-txt-2">
          過數後記得 cap 低入數紙或截圖，去「會員中心 → 我嘅訂單」上傳付款截圖，
          我哋確認後就會即刻安排發貨。
        </p>
        {/* 2026-07-30 落單規則：48 小時內要傳截圖，否則訂單自動取消（2026-08-04 起收緊做 48 小時） */}
        <p
          className="mx-auto mt-5 max-w-lg rounded-2xl border px-5 py-4 text-[13px] leading-[1.75]"
          style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}
        >
          ⏳ 溫馨提示：許願後請於 <strong>48 小時內</strong>過數並上傳付款截圖。
          逾期待付款訂單會自動取消，心水貨品唔會留貨，記得趁早呀 ♡
        </p>
        <Link to="/account" className="btn btn-primary mt-6">
          去會員中心上傳截圖
        </Link>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { RefreshCw, Save, Shirt, TriangleAlert } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import { fmtDateTime } from './format';
import type { ToastKind } from './useToasts';

/**
 * AI 試穿設定及用量面板（admin 專用）
 * ─ 設定：trpc.tryon.getAdminConfig / setAdminConfig（後端 tryOnSettingsSchema 會再驗證開放閘口）
 * ─ 用量：trpc.tryon.getAdminStats（today/month/year 三桶＋最近 20 單工作）
 * 金額後端係整數仙，畫面輸入／顯示用港元（×100 / ÷100）。
 * 預設全部由 API 帶入，唔會假設已開放；開關只係意願，真正開放仲要過品質批准、
 * 成本單價、每月預算、provider（FASHN_API_KEY）及 APP_SECRET 五重閘口。
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none';
const labelCls = 'mb-1.5 block text-[13px] text-txt-2';
const btnCls =
  'btn btn-primary min-h-[44px] !px-6 text-[14px] disabled:opacity-60';

type Tier = 'NONE' | 'SILVER' | 'GOLD';
const TIERS: { value: Tier; label: string }[] = [
  { value: 'NONE', label: '全部會員（包括普通）' },
  { value: 'SILVER', label: '銀會員或以上' },
  { value: 'GOLD', label: '只限金會員' },
];

const STATUS_META: Record<string, { label: string; color: string }> = {
  queued: { label: '排隊中', color: 'var(--gold)' },
  processing: { label: '生成中', color: 'var(--lavender)' },
  completed: { label: '完成', color: 'var(--success)' },
  failed: { label: '失敗', color: 'var(--pink-soft)' },
};

/** 港元字串 → 整數仙；唔係非負數字回 null */
function hkdToCents(s: string): number | null {
  const n = Number(s);
  if (!s.trim() || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** 仙 → 港元顯示（HK$1.23）；null 顯示 — */
function fmtCents(cents: number | null): string {
  if (cents === null) return '—';
  return `HK$${(cents / 100).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 非負整數字串 → number；無效回 null */
function parseIntField(s: string): number | null {
  const n = Number(s);
  if (!s.trim() || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** 開放狀態燈號：綠＝就緒／開放，紅＝未配置／未開放 */
function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px]"
      style={{
        borderColor: ok ? 'rgba(94, 224, 160, 0.45)' : 'rgba(255, 120, 170, 0.45)',
        background: ok ? 'rgba(94, 224, 160, 0.10)' : 'rgba(255, 120, 170, 0.10)',
        color: ok ? 'var(--success)' : 'var(--pink-soft)',
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: 'currentColor' }}
      />
      {label}
    </span>
  );
}

interface StatsBucketShape {
  total: number;
  completed: number;
  failed: number;
  processing: number;
  creditsUsed: number;
  reservedCredits: number;
  estimatedCostCents: number;
  reservedCostCents: number;
  unknownCostJobs: number;
  costUncertainJobs: number;
}

/** 單一時段用量桶：今日／今月／今年 */
function StatsBucketCard({ title, sub, bucket }: { title: string; sub: string; bucket: StatsBucketShape }) {
  const rows: { label: string; value: string; warn?: boolean }[] = [
    { label: '總工作數', value: String(bucket.total) },
    { label: '完成', value: String(bucket.completed) },
    { label: '失敗', value: String(bucket.failed) },
    { label: '排隊／生成中', value: String(bucket.processing) },
    { label: '已扣點數', value: String(bucket.creditsUsed) },
    { label: '已預留點數（處理中）', value: String(bucket.reservedCredits) },
    { label: '已結算估算成本', value: fmtCents(bucket.estimatedCostCents) },
    { label: '預留中估算成本', value: fmtCents(bucket.reservedCostCents) },
    { label: '成本未知工作', value: String(bucket.unknownCostJobs), warn: bucket.unknownCostJobs > 0 },
    { label: '成本待核實工作', value: String(bucket.costUncertainJobs), warn: bucket.costUncertainJobs > 0 },
  ];
  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <p className="text-[13px] font-bold text-txt-1">{title}</p>
      <p className="mt-0.5 font-mono text-[11px] text-txt-3">{sub}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-[11px] text-txt-3">{r.label}</dt>
            <dd
              className="font-mono text-[13px]"
              style={{ color: r.warn ? 'var(--gold)' : 'var(--text-1)' }}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function TryOnPanel({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const configQuery = trpc.tryon.getAdminConfig.useQuery();
  const statsQuery = trpc.tryon.getAdminStats.useQuery();
  const setAdminConfig = trpc.tryon.setAdminConfig.useMutation();

  // 表單狀態（金額用港元字串，儲存時先轉仙）
  const [memberEnabled, setMemberEnabled] = useState(false);
  const [qualityApproved, setQualityApproved] = useState(false);
  const [minimumTier, setMinimumTier] = useState<Tier>('NONE');
  const [dailyLimitNone, setDailyLimitNone] = useState('');
  const [dailyLimitSilver, setDailyLimitSilver] = useState('');
  const [dailyLimitGold, setDailyLimitGold] = useState('');
  const [staffDailyLimit, setStaffDailyLimit] = useState('');
  const [siteDailyLimit, setSiteDailyLimit] = useState('');
  const [creditCost, setCreditCost] = useState('');
  const [monthlyBudget, setMonthlyBudget] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 預設全部由 API 帶入（仙 ÷100 轉港元），唔自行假設已開放
  useEffect(() => {
    const s = configQuery.data?.settings;
    if (!s) return;
    setMemberEnabled(s.memberEnabled);
    setQualityApproved(s.qualityApproved);
    setMinimumTier(s.minimumTier);
    setDailyLimitNone(String(s.dailyLimitNone));
    setDailyLimitSilver(String(s.dailyLimitSilver));
    setDailyLimitGold(String(s.dailyLimitGold));
    setStaffDailyLimit(String(s.staffDailyLimit));
    setSiteDailyLimit(String(s.siteDailyLimit));
    setCreditCost(String(s.creditCostCents / 100));
    setMonthlyBudget(String(s.monthlyBudgetCents / 100));
  }, [configQuery.data]);

  const save = async () => {
    const limNone = parseIntField(dailyLimitNone);
    const limSilver = parseIntField(dailyLimitSilver);
    const limGold = parseIntField(dailyLimitGold);
    const limStaff = parseIntField(staffDailyLimit);
    const limSite = parseIntField(siteDailyLimit);
    const costCents = hkdToCents(creditCost);
    const budgetCents = hkdToCents(monthlyBudget);
    if (limNone === null || limNone > 100 || limSilver === null || limSilver > 100 || limGold === null || limGold > 100)
      return setFormError('會員每日額度要係 0–100 嘅整數');
    if (limStaff === null || limStaff < 1 || limStaff > 100)
      return setFormError('同事每日額度要係 1–100 嘅整數');
    if (limSite === null || limSite < 1 || limSite > 1000)
      return setFormError('全站每日上限要係 1–1000 嘅整數');
    if (costCents === null) return setFormError('每 credit 估算成本要係非負數金額（港元）');
    if (budgetCents === null) return setFormError('每月預算上限要係非負數金額（港元）');
    setFormError(null);
    setSaving(true);
    try {
      await setAdminConfig.mutateAsync({
        memberEnabled,
        qualityApproved,
        minimumTier,
        dailyLimitNone: limNone,
        dailyLimitSilver: limSilver,
        dailyLimitGold: limGold,
        staffDailyLimit: limStaff,
        siteDailyLimit: limSite,
        creditCostCents: costCents,
        monthlyBudgetCents: budgetCents,
      });
      toast('已儲存 AI 試穿設定 ✓ 即時生效', 'success');
      void utils.tryon.getAdminConfig.invalidate();
      void utils.tryon.getAdminStats.invalidate();
      void utils.tryon.getPublicConfig.invalidate();
    } catch (err) {
      // 顯示後端訊息（例如品質／成本閘口或未配置 provider）
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setSaving(false);
    }
  };

  const cfg = configQuery.data;

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Shirt size={16} aria-hidden="true" className="text-gold" />
        AI 試穿設定及用量
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        控制會員 AI 試穿開放、每日額度、成本同預算；下面可以睇用量同最近工作紀錄（私人圖片 URL 一律唔會喺度顯示）。
      </p>

      {/* ── 系統狀態燈號（唔會顯示任何 key）── */}
      {cfg && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusChip ok={cfg.providerConfigured} label={cfg.providerConfigured ? '試穿服務已配置' : '試穿服務未配置（伺服器缺 API key）'} />
          <StatusChip ok={cfg.mediaProtectionConfigured} label={cfg.mediaProtectionConfigured ? '私人圖片保護已配置' : '私人圖片保護未配置（缺 APP_SECRET）'} />
          <StatusChip ok={cfg.memberOpen} label={cfg.memberOpen ? '會員試穿真正開放中' : '會員試穿未真正開放'} />
          <span className="rounded-full border border-space-line bg-space-2 px-3 py-1 text-[12px] text-txt-2">
            每次生成 {cfg.creditsPerGeneration} credits・最多 {cfg.maxMixSteps} 步混搭配件
          </span>
        </div>
      )}

      {/* ── 設定表單 ── */}
      {configQuery.isLoading ? (
        <div className="mt-6 flex justify-center py-6">
          <WishingStar size={20} />
        </div>
      ) : configQuery.isError ? (
        <p className="py-6 text-center text-[14px] text-pink-soft">
          載入設定失敗：{configQuery.error.message}
        </p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="mt-5"
        >
          {/* 開放開關 */}
          <div
            className="rounded-xl border p-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={memberEnabled}
                onChange={(e) => setMemberEnabled(e.target.checked)}
                className="h-5 w-5 accent-[#F5C518]"
              />
              <span className="text-[14px] font-bold text-txt-1">開放會員使用 AI 試穿</span>
            </label>
            <p className="mt-2 text-[12px] leading-relaxed text-txt-3">
              剔咗呢個開關唔代表即刻開放：必須同時完成真人＋真商品品質驗收批准、填寫每 credit
              估算成本單價、設定每月預算上限，而且伺服器已配置試穿服務 provider（API key）同
              APP_SECRET 私人圖片保護，會員先真正用到。任何一項未就緒，前台都會保持關閉。
            </p>
            <label className="mt-3 flex min-h-[44px] cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={qualityApproved}
                onChange={(e) => setQualityApproved(e.target.checked)}
                className="mt-2.5 h-5 w-5 accent-[#F5C518]"
              />
              <span className="text-[13px] leading-relaxed text-txt-2">
                <span className="font-bold text-txt-1">已完成品質驗收（必填先可以開放）</span>
                <span className="mt-1 flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--gold)' }}>
                  <TriangleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                  只可以喺已用真人相＋真實在售商品完成驗收、確認生成效果合格之後先剔選；
                  未驗收就開放有機會令會員見到失真人像或錯誤商品效果，影響品牌同私隱。
                </span>
              </span>
            </label>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="tryon-min-tier" className={labelCls}>
                最低可用會員級別
              </label>
              <select
                id="tryon-min-tier"
                value={minimumTier}
                onChange={(e) => setMinimumTier(e.target.value as Tier)}
                className={inputCls}
              >
                {TIERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="tryon-site-limit" className={labelCls}>
                全站每日總上限（1–1000 次）
              </label>
              <input
                id="tryon-site-limit"
                type="number"
                min="1"
                max="1000"
                step="1"
                inputMode="numeric"
                value={siteDailyLimit}
                onChange={(e) => setSiteDailyLimit(e.target.value)}
                placeholder="20"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-limit-none" className={labelCls}>
                普通會員每日額度（0–100 次，0＝唔開放）
              </label>
              <input
                id="tryon-limit-none"
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={dailyLimitNone}
                onChange={(e) => setDailyLimitNone(e.target.value)}
                placeholder="0"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-limit-silver" className={labelCls}>
                銀會員每日額度（0–100 次）
              </label>
              <input
                id="tryon-limit-silver"
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={dailyLimitSilver}
                onChange={(e) => setDailyLimitSilver(e.target.value)}
                placeholder="1"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-limit-gold" className={labelCls}>
                金會員每日額度（0–100 次）
              </label>
              <input
                id="tryon-limit-gold"
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={dailyLimitGold}
                onChange={(e) => setDailyLimitGold(e.target.value)}
                placeholder="2"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-limit-staff" className={labelCls}>
                同事每日額度（1–100 次）
              </label>
              <input
                id="tryon-limit-staff"
                type="number"
                min="1"
                max="100"
                step="1"
                inputMode="numeric"
                value={staffDailyLimit}
                onChange={(e) => setStaffDailyLimit(e.target.value)}
                placeholder="5"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-credit-cost" className={labelCls}>
                每 credit 估算成本（HK$，開放前必填）
              </label>
              <input
                id="tryon-credit-cost"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={creditCost}
                onChange={(e) => setCreditCost(e.target.value)}
                placeholder="0.30"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="tryon-monthly-budget" className={labelCls}>
                每月預算上限（HK$，開放前必填）
              </label>
              <input
                id="tryon-monthly-budget"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={monthlyBudget}
                onChange={(e) => setMonthlyBudget(e.target.value)}
                placeholder="500"
                className={inputCls}
              />
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-txt-3">
            處理中嘅工作都會預留成本計落每月預算，超支就會自動暫停新生成；失敗生成唔會扣會員次數。
          </p>
          {formError && <p className="mt-2 text-[12px] text-pink-soft">{formError}</p>}
          <button type="submit" disabled={saving} className={`${btnCls} mt-4`}>
            {saving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
            儲存 AI 試穿設定
          </button>
        </form>
      )}

      {/* ── 用量統計 ── */}
      <div className="mt-6 border-t pt-5" style={{ borderColor: 'var(--space-line)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[13px] font-bold tracking-[0.08em] text-gold">
            用量統計（香港時間）
            {statsQuery.data && (
              <span className="ml-2 font-mono font-normal text-txt-3">
                {statsQuery.data.periods.date}
              </span>
            )}
          </h4>
          <button
            type="button"
            onClick={() => void statsQuery.refetch()}
            disabled={statsQuery.isFetching}
            className="btn btn-secondary min-h-[44px] !px-4 text-[13px] disabled:opacity-60"
          >
            <RefreshCw size={14} aria-hidden="true" className={statsQuery.isFetching ? 'animate-spin' : undefined} />
            重新整理
          </button>
        </div>

        {statsQuery.isLoading ? (
          <div className="mt-4 flex justify-center py-6">
            <WishingStar size={20} />
          </div>
        ) : statsQuery.isError ? (
          <p className="py-6 text-center text-[14px] text-pink-soft">
            載入用量失敗：{statsQuery.error.message}
          </p>
        ) : statsQuery.data ? (
          <>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <StatsBucketCard title="今日" sub={statsQuery.data.periods.date} bucket={statsQuery.data.today} />
              <StatsBucketCard title="今月" sub={statsQuery.data.periods.month} bucket={statsQuery.data.month} />
              <StatsBucketCard title="今年" sub={statsQuery.data.periods.year} bucket={statsQuery.data.year} />
            </div>

            {/* 最近工作（唔會顯示私人媒體 URL） */}
            <h4 className="mt-6 text-[13px] font-bold tracking-[0.08em] text-gold">最近工作（最新 20 單）</h4>
            {statsQuery.data.recentJobs.length === 0 ? (
              <p className="py-6 text-center text-[14px] text-txt-3">暫時未有試穿工作紀錄。</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-[13px]">
                  <thead>
                    <tr
                      className="border-b text-left text-[12px] text-txt-3"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <th className="w-32 py-2 pr-3 font-normal">建立時間</th>
                      <th className="w-20 py-2 pr-3 font-normal">狀態</th>
                      <th className="py-2 pr-3 font-normal">商品</th>
                      <th className="w-12 py-2 pr-3 font-normal">步數</th>
                      <th className="w-20 py-2 pr-3 font-normal">點數</th>
                      <th className="w-24 py-2 pr-3 font-normal">估算成本</th>
                      <th className="w-20 py-2 pr-3 font-normal">成本待核實</th>
                      <th className="w-32 py-2 font-normal">failureCode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statsQuery.data.recentJobs.map((j) => {
                      const meta = STATUS_META[j.status] ?? { label: j.status, color: 'var(--text-3)' };
                      return (
                        <tr
                          key={j.publicId}
                          className="border-b last:border-0"
                          style={{ borderColor: 'var(--space-line)' }}
                        >
                          <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-3">
                            {fmtDateTime(j.createdAt)}
                          </td>
                          <td className="py-2.5 pr-3" style={{ color: meta.color }}>
                            {meta.label}
                          </td>
                          <td className="max-w-0 truncate py-2.5 pr-3 text-txt-1">{j.productName}</td>
                          <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-2">{j.stepNumber}</td>
                          <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-2">
                            {j.status === 'queued' || j.status === 'processing'
                              ? `預留 ${j.creditsReserved}`
                              : `已扣 ${j.creditsUsed}`}
                          </td>
                          <td className="py-2.5 pr-3 font-mono text-[12px] text-txt-2">
                            {fmtCents(j.estimatedCostCents)}
                          </td>
                          <td className="py-2.5 pr-3 text-[12px]" style={{ color: j.costUncertain ? 'var(--gold)' : 'var(--text-3)' }}>
                            {j.costUncertain ? '待核實' : '—'}
                          </td>
                          <td className="py-2.5 font-mono text-[12px] text-lavender">
                            {j.failureCode ?? '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

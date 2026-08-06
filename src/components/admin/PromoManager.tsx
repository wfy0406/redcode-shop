import { useState } from 'react';
import type { FormEvent } from 'react';
import { TicketPercent, Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { fmtDate, fmtHKD } from './format';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 優惠碼管理（staff）—— promo.list / create / update（isActive toggle）/ remove
 * 左 5 欄：新增優惠碼表單；右 7 欄：全部優惠碼（包括停用，兩步確認刪除）。
 * 折扣顯示：percent → 「9折」（value=10 即減 10%）；fixed → 「減HK$20」。
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

/** promoRouter 未 merge 前嘅本地型別（同 spec §1 契約一致） */
type PromoRow = {
  id: number;
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
  minSpend: number;
  usageLimit: number | null;
  perUserLimit: number | null;
  usedCount: number;
  expiresAt: Date | string | null;
  isActive: boolean;
  createdAt: Date | string;
};

const initialForm = {
  code: '',
  kind: 'percent',
  value: '',
  minSpend: '',
  usageLimit: '',
  perUserLimit: '',
  expiresAt: '',
};

/** percent value（減幾多 %）→ 中文折頭，例如 10 → 9折、25 → 7.5折 */
function percentLabel(value: number): string {
  const zhe = (100 - value) / 10;
  return `${Number.isInteger(zhe) ? zhe : zhe.toFixed(1)}折`;
}

export default function PromoManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const listQuery = trpc.promo.list.useQuery(undefined);
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  const createMutation = trpc.promo.create.useMutation({
    onSuccess: (result) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if ((result as { pendingApproval?: boolean } | null)?.pendingApproval) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast(`已新增優惠碼「${form.code.trim().toUpperCase()}」`, 'success');
      setForm(initialForm);
      setFormError(null);
      void utils.promo.list.invalidate();
    },
    onError: (err) => toast(err.message || '新增優惠碼失敗', 'error'),
  });

  const toggleMutation = trpc.promo.update.useMutation({
    onSuccess: (result: unknown, vars: { id: number; isActive?: boolean }) => {
      // 三級制（2026-08-06）：員工提交會進入審批，唔係即時生效
      if ((result as { pendingApproval?: boolean } | null)?.pendingApproval) {
        toast('已提交審批，主管/管理員批准後先生效 ⏳', 'info');
        void utils.approvals.myRequests.invalidate();
        return;
      }
      toast(vars.isActive ? '已啟用優惠碼' : '已停用優惠碼', 'success');
      void utils.promo.list.invalidate();
    },
    onError: (err) => toast(err.message || '更新失敗', 'error'),
  });

  const removeMutation = trpc.promo.remove.useMutation({
    onSuccess: () => {
      toast('已刪除優惠碼', 'info');
      setConfirmRemoveId(null);
      void utils.promo.list.invalidate();
    },
    onError: (err) => {
      setConfirmRemoveId(null);
      toast(err.message || '刪除失敗', 'error');
    },
  });

  const set = (key: keyof typeof initialForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const code = form.code.trim().toUpperCase();
    if (!code) {
      setFormError('優惠碼必填');
      return;
    }
    const value = Number.parseInt(form.value, 10);
    if (!Number.isInteger(value) || value <= 0) {
      setFormError('折扣值要係正整數');
      return;
    }
    if (form.kind === 'percent' && (value < 1 || value > 90)) {
      setFormError('百分比折扣要喺 1-90 之間');
      return;
    }
    const minSpend = form.minSpend.trim() ? Number.parseInt(form.minSpend, 10) : undefined;
    if (minSpend !== undefined && (!Number.isInteger(minSpend) || minSpend < 0)) {
      setFormError('最低消費要係 0 或以上嘅整數');
      return;
    }
    const usageLimit = form.usageLimit.trim() ? Number.parseInt(form.usageLimit, 10) : undefined;
    if (usageLimit !== undefined && (!Number.isInteger(usageLimit) || usageLimit <= 0)) {
      setFormError('總限用次數要係正整數');
      return;
    }
    const perUserLimit = form.perUserLimit.trim()
      ? Number.parseInt(form.perUserLimit, 10)
      : undefined;
    if (perUserLimit !== undefined && (!Number.isInteger(perUserLimit) || perUserLimit <= 0)) {
      setFormError('每人限用次數要係正整數');
      return;
    }
    setFormError(null);
    createMutation.mutate({
      code,
      kind: form.kind as 'percent' | 'fixed',
      value,
      minSpend,
      usageLimit,
      perUserLimit,
      expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T00:00:00`) : undefined,
    });
  };

  const promos = (listQuery.data ?? []) as PromoRow[];

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：新增優惠碼表單（5） */}
      <form
        onSubmit={submit}
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-5"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          <TicketPercent size={16} className="text-gold" aria-hidden="true" />
          新增優惠碼
        </h3>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="np-code" className="mb-1.5 block text-[14px] text-txt-2">
              優惠碼 *
            </label>
            <input
              id="np-code"
              value={form.code}
              onChange={(e) => set('code')(e.target.value.toUpperCase())}
              className={`${inputCls} font-mono uppercase tracking-wider`}
              placeholder="例如：GLOGLO10"
              maxLength={32}
            />
          </div>
          <div>
            <label htmlFor="np-kind" className="mb-1.5 block text-[14px] text-txt-2">
              折扣類型 *
            </label>
            <select
              id="np-kind"
              value={form.kind}
              onChange={(e) => set('kind')(e.target.value)}
              className={inputCls}
            >
              <option value="percent">百分比折扣</option>
              <option value="fixed">定額折扣 HKD</option>
            </select>
          </div>
          <div>
            <label htmlFor="np-value" className="mb-1.5 block text-[14px] text-txt-2">
              折扣值 *
            </label>
            <input
              id="np-value"
              inputMode="numeric"
              value={form.value}
              onChange={(e) => set('value')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder={form.kind === 'percent' ? '1-90（例如 10 即 9 折）' : '例如 20（減 HK$20）'}
            />
          </div>
          <div>
            <label htmlFor="np-minspend" className="mb-1.5 block text-[14px] text-txt-2">
              最低消費（選填）
            </label>
            <input
              id="np-minspend"
              inputMode="numeric"
              value={form.minSpend}
              onChange={(e) => set('minSpend')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="留空即無門檻"
            />
          </div>
          <div>
            <label htmlFor="np-usagelimit" className="mb-1.5 block text-[14px] text-txt-2">
              總限用次數（選填）
            </label>
            <input
              id="np-usagelimit"
              inputMode="numeric"
              value={form.usageLimit}
              onChange={(e) => set('usagelimit' in form ? 'usageLimit' : 'usageLimit')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="留空即不限次數"
            />
          </div>
          <div>
            <label htmlFor="np-peruser" className="mb-1.5 block text-[14px] text-txt-2">
              每人限用次數（選填）
            </label>
            <input
              id="np-peruser"
              inputMode="numeric"
              value={form.perUserLimit}
              onChange={(e) => set('perUserLimit')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="留空即每人不限"
            />
          </div>
          <div>
            <label htmlFor="np-expires" className="mb-1.5 block text-[14px] text-txt-2">
              到期日（選填）
            </label>
            <input
              id="np-expires"
              type="date"
              value={form.expiresAt}
              onChange={(e) => set('expiresAt')(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>
        </div>
        {formError && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-pink-soft" role="alert">
            <span
              className="inline-block h-2 w-2 rotate-45"
              style={{ background: 'var(--gold)' }}
              aria-hidden="true"
            />
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="btn btn-primary mt-5 w-full disabled:opacity-60"
        >
          {createMutation.isPending ? (
            <WishingStar size={16} />
          ) : (
            <TicketPercent size={16} aria-hidden="true" />
          )}
          新增優惠碼
        </button>
      </form>

      {/* 右：優惠碼列表（7） */}
      <div className="xl:col-span-7">
        <h3 className="text-[16px] font-bold text-txt-1">
          全部優惠碼
          <span className="ml-2 font-mono text-[13px] font-normal text-txt-3">
            {promos.length} 個
          </span>
        </h3>
        {listQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊優惠碼…" />
        ) : promos.length === 0 ? (
          <p className="py-14 text-center text-[14px] text-txt-3">未有優惠碼，左手邊新增第一個啦。</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {promos.map((p) => {
              const removing = removeMutation.isPending && confirmRemoveId === p.id;
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border px-4 py-3.5"
                  style={{
                    borderColor: 'var(--space-line)',
                    background: 'var(--space-2)',
                    opacity: p.isActive ? 1 : 0.55,
                  }}
                >
                  {/* code chip（mono 金邊） */}
                  <span
                    className="shrink-0 rounded-lg border px-3 py-1.5 font-mono text-[13px] font-bold tracking-wider text-gold"
                    style={{ borderColor: 'var(--gold)', background: 'var(--glass-bg)' }}
                  >
                    {p.code}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-bold text-txt-1">
                      {p.kind === 'percent' ? percentLabel(p.value) : `減${fmtHKD(p.value)}`}
                      <span className="ml-2 font-mono text-[12px] font-normal text-txt-3">
                        {p.minSpend > 0 ? `滿 ${fmtHKD(p.minSpend)} 可用` : '無門檻'}
                      </span>
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      已用 {p.usedCount}
                      {p.usageLimit != null ? `/${p.usageLimit}` : ''} 次
                      {p.perUserLimit != null ? ` · 每人限 ${p.perUserLimit} 次` : ''} ·{' '}
                      {p.expiresAt ? `${fmtDate(p.expiresAt)} 到期` : '無限期'}
                    </p>
                  </div>
                  {/* isActive toggle（仿 ProductManager switch） */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.isActive}
                    aria-label={`${p.code} 啟用狀態`}
                    disabled={toggleMutation.isPending}
                    onClick={() => toggleMutation.mutate({ id: p.id, isActive: !p.isActive })}
                    className="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60"
                    style={{
                      background: p.isActive ? 'var(--success)' : 'var(--space-4)',
                      borderColor: p.isActive ? 'var(--success)' : 'var(--space-line)',
                    }}
                  >
                    <span
                      className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                      style={{
                        background: p.isActive ? 'var(--space-1)' : 'var(--text-3)',
                        transform: p.isActive ? 'translateX(22px)' : 'translateX(2px)',
                      }}
                      aria-hidden="true"
                    />
                  </button>
                  {/* 刪除（兩步確認） */}
                  {confirmRemoveId === p.id ? (
                    <button
                      type="button"
                      disabled={removing}
                      onClick={() =>
                        removeMutation.mutate(
                          { id: p.id },
                          { onError: () => setConfirmRemoveId(null) },
                        )
                      }
                      className="btn btn-primary shrink-0 !px-4 !py-2 text-[12px] disabled:opacity-60"
                    >
                      {removing ? <WishingStar size={13} /> : null}
                      確認刪除？
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(p.id)}
                      aria-label={`刪除優惠碼 ${p.code}`}
                      className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

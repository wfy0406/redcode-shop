import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CreditCard, Save } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import {
  DEFAULT_PAYMENT_METHODS,
  PAYMENT_METHODS_SETTING_KEY,
  parsePaymentMethods,
} from '@contracts/paymentMethods';
import type { PaymentMethodEntry } from '@contracts/paymentMethods';
import WishingStar from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 收款方式編輯卡（2026-08-08 Glo 要求）—— 全網統一來源，**淨係管理員**改得
 * （呢張卡放喺 admin 限定嘅「業務分析」；後端 settings.setPaymentMethods 係 adminProcedure，雙重把關）。
 * 4 個固定方式（中銀／PayMe／Alipay／FPS）逐個改：名稱、副題、帳號名稱、帳號、附加資料。
 * 儲存後 /payment 頁同埋結帳步驟② 即時一齊更新，唔使逐頁改。
 */

type SettingEntry = { key: string; value: string };

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

const METHOD_NAME: Record<string, string> = {
  boc: '中銀香港（銀行轉帳）',
  payme: 'PayMe',
  alipay: 'Alipay 支付寶',
  fps: 'FPS 轉數快',
};

export default function PaymentMethodsCard({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const query = trpc.settings.get.useQuery({ key: PAYMENT_METHODS_SETTING_KEY });
  const [methods, setMethods] = useState<PaymentMethodEntry[]>(DEFAULT_PAYMENT_METHODS);
  const [saving, setSaving] = useState(false);

  // 載入現有設定做預填（冇設定就係預設嗰 4 個）
  useEffect(() => {
    const entry = query.data as SettingEntry | null | undefined;
    if (entry?.value != null) setMethods(parsePaymentMethods(entry.value));
  }, [query.data]);

  const setField = (id: string, field: keyof PaymentMethodEntry, value: string) =>
    setMethods((ms) => ms.map((m) => (m.id === id ? { ...m, [field]: value } : m)));

  const saveMutation = trpc.settings.setPaymentMethods.useMutation();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await saveMutation.mutateAsync({
        methods: methods.map((m) => ({
          id: m.id as 'boc' | 'payme' | 'alipay' | 'fps',
          label: m.label,
          subtitle: m.subtitle ?? '',
          accountLabel: m.accountLabel,
          account: m.account,
          extraLabel: m.extraLabel ?? '',
          extraValue: m.extraValue ?? '',
        })),
      });
      toast('已儲存收款方式，全網同步更新', 'success');
      void utils.settings.get.invalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <CreditCard size={16} aria-hidden="true" className="text-gold" />
        收款方式
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        客人喺「付款方式」頁同埋結帳嗰頁見到嘅收款資料就係呢度。改一次全網同步，唔使逐頁改。
        附加資料（例如戶口名稱）兩欄要齊先會顯示。
      </p>
      <form onSubmit={(e) => void save(e)} className="mt-4 flex flex-col gap-5">
        {methods.map((m) => (
          <fieldset
            key={m.id}
            className="rounded-xl border p-4"
            style={{ borderColor: 'var(--space-line)' }}
          >
            <legend className="px-1.5 text-[13px] font-bold text-txt-2">
              {METHOD_NAME[m.id] ?? m.id}
            </legend>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label htmlFor={`pm-${m.id}-label`} className="mb-1.5 block text-[13px] text-txt-2">
                  顯示名稱
                </label>
                <input
                  id={`pm-${m.id}-label`}
                  type="text"
                  value={m.label}
                  onChange={(e) => setField(m.id, 'label', e.target.value)}
                  maxLength={40}
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor={`pm-${m.id}-subtitle`} className="mb-1.5 block text-[13px] text-txt-2">
                  副題（可以留空）
                </label>
                <input
                  id={`pm-${m.id}-subtitle`}
                  type="text"
                  value={m.subtitle ?? ''}
                  onChange={(e) => setField(m.id, 'subtitle', e.target.value)}
                  maxLength={40}
                  placeholder="例如：銀行轉帳"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor={`pm-${m.id}-accountlabel`} className="mb-1.5 block text-[13px] text-txt-2">
                  帳號名稱
                </label>
                <input
                  id={`pm-${m.id}-accountlabel`}
                  type="text"
                  value={m.accountLabel}
                  onChange={(e) => setField(m.id, 'accountLabel', e.target.value)}
                  maxLength={20}
                  placeholder="例如：戶口號碼"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor={`pm-${m.id}-account`} className="mb-1.5 block text-[13px] text-txt-2">
                  帳號（客人一撳複製嘅就係佢）
                </label>
                <input
                  id={`pm-${m.id}-account`}
                  type="text"
                  value={m.account}
                  onChange={(e) => setField(m.id, 'account', e.target.value)}
                  maxLength={64}
                  className={`${inputCls} font-mono`}
                />
              </div>
              <div>
                <label htmlFor={`pm-${m.id}-extralabel`} className="mb-1.5 block text-[13px] text-txt-2">
                  附加資料名（選填）
                </label>
                <input
                  id={`pm-${m.id}-extralabel`}
                  type="text"
                  value={m.extraLabel ?? ''}
                  onChange={(e) => setField(m.id, 'extraLabel', e.target.value)}
                  maxLength={20}
                  placeholder="例如：戶口名稱"
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor={`pm-${m.id}-extravalue`} className="mb-1.5 block text-[13px] text-txt-2">
                  附加資料內容（選填）
                </label>
                <input
                  id={`pm-${m.id}-extravalue`}
                  type="text"
                  value={m.extraValue ?? ''}
                  onChange={(e) => setField(m.id, 'extraValue', e.target.value)}
                  maxLength={64}
                  placeholder="例如：RED CODE HK LIMITED"
                  className={inputCls}
                />
              </div>
            </div>
          </fieldset>
        ))}
        <div>
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
          >
            {saving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
            儲存收款方式
          </button>
        </div>
      </form>
    </section>
  );
}

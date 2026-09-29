import { useEffect, useState } from 'react';
import { Crown, Save, Truck } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * VIP＋免運規則設定面板（v2.1.0，2026-09-29，admin 專用）
 * ─ VIP 規則：銀/金年度消費門檻、折扣、會籍期限 → settings.getVipRules / setVipRules
 * ─ 免運規則：滿額免運門檻＋適用取貨方式 checkboxes、金會員全年免運方式 → getShippingRules / setShippingRules
 * 輸入全部用港元／百分比（後端係整數仙同 bps）：$ ×100 轉仙；折扣 92（＝92折）×100 轉 9200 bps。
 * 規則改咗即時生效（後端會 reset cache）；前台 /vip 介紹頁同結帳頁跟住變。
 */

/** 取貨方式（契約大寫值） */
const METHODS = [
  { value: 'SF_STATION', label: '順豐站自取' },
  { value: 'SF_LOCKER', label: '順豐智能櫃' },
  { value: 'HOME', label: '送貨上門' },
] as const;
type MethodValue = (typeof METHODS)[number]['value'];

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none';
const labelCls = 'mb-1.5 block text-[13px] text-txt-2';

/** 港元字串 → 整數仙；唔係非負數字回 null */
function hkdToCents(s: string): number | null {
  const n = Number(s);
  if (!s.trim() || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** 折扣百分比字串（92＝92折）→ bps；0–100 以外回 null */
function pctToBps(s: string): number | null {
  const n = Number(s);
  if (!s.trim() || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** checkbox 群組：剔選即加/減 method */
function MethodChecks({
  legend,
  selected,
  onToggle,
}: {
  legend: string;
  selected: ReadonlySet<MethodValue>;
  onToggle: (m: MethodValue) => void;
}) {
  return (
    <fieldset>
      <legend className={labelCls}>{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {METHODS.map((m) => {
          const checked = selected.has(m.value);
          return (
            <label
              key={m.value}
              className="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-[13px] transition-colors"
              style={{
                borderColor: checked ? 'var(--gold)' : 'var(--space-line)',
                background: checked ? 'rgba(245, 197, 24, 0.08)' : 'var(--space-2)',
                color: checked ? 'var(--text-1)' : 'var(--text-3)',
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(m.value)}
                className="accent-[#F5C518]"
              />
              {m.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function toggleIn(set: ReadonlySet<MethodValue>, m: MethodValue): Set<MethodValue> {
  const next = new Set(set);
  if (next.has(m)) next.delete(m);
  else next.add(m);
  return next;
}

export default function VipSettingsPanel({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const vipQuery = trpc.settings.getVipRules.useQuery();
  const shippingQuery = trpc.settings.getShippingRules.useQuery();

  // VIP 規則表單（港元／百分比字串，儲存時先轉仙/bps）
  const [silverThreshold, setSilverThreshold] = useState('');
  const [goldThreshold, setGoldThreshold] = useState('');
  const [silverPct, setSilverPct] = useState('');
  const [goldPct, setGoldPct] = useState('');
  const [durationMonths, setDurationMonths] = useState('');
  const [vipSaving, setVipSaving] = useState(false);
  const [vipError, setVipError] = useState<string | null>(null);

  // 免運規則表單
  const [freeThreshold, setFreeThreshold] = useState('');
  const [freeMethods, setFreeMethods] = useState<ReadonlySet<MethodValue>>(new Set());
  const [goldFreeMethods, setGoldFreeMethods] = useState<ReadonlySet<MethodValue>>(new Set());
  const [shipSaving, setShipSaving] = useState(false);
  const [shipError, setShipError] = useState<string | null>(null);

  // 載入現況預填（仙 ÷100 轉港元；bps ÷100 轉百分比）
  useEffect(() => {
    const r = vipQuery.data;
    if (!r) return;
    setSilverThreshold(String(r.silverThresholdCents / 100));
    setGoldThreshold(String(r.goldThresholdCents / 100));
    setSilverPct(String(r.silverDiscountBps / 100));
    setGoldPct(String(r.goldDiscountBps / 100));
    setDurationMonths(String(r.durationMonths));
  }, [vipQuery.data]);

  useEffect(() => {
    const r = shippingQuery.data;
    if (!r) return;
    setFreeThreshold(String(r.freeThresholdCents / 100));
    setFreeMethods(new Set(r.freeMethods as MethodValue[]));
    setGoldFreeMethods(new Set(r.goldVipFreeMethods as MethodValue[]));
  }, [shippingQuery.data]);

  const setVipRules = trpc.settings.setVipRules.useMutation();
  const setShippingRules = trpc.settings.setShippingRules.useMutation();

  const saveVip = async () => {
    const silverCents = hkdToCents(silverThreshold);
    const goldCents = hkdToCents(goldThreshold);
    const silverBps = pctToBps(silverPct);
    const goldBps = pctToBps(goldPct);
    const months = Number(durationMonths);
    if (silverCents === null || goldCents === null) return setVipError('門檻要係非負數金額');
    if (silverBps === null || goldBps === null) return setVipError('折扣要係 0–100 嘅數字（92 即 92 折）');
    if (!Number.isInteger(months) || months < 1 || months > 120)
      return setVipError('會籍期限要係 1–120 個月嘅整數');
    if (silverCents > goldCents) return setVipError('銀會員門檻唔可以高過金會員門檻');
    setVipError(null);
    setVipSaving(true);
    try {
      await setVipRules.mutateAsync({
        silverThresholdCents: silverCents,
        goldThresholdCents: goldCents,
        silverDiscountBps: silverBps,
        goldDiscountBps: goldBps,
        durationMonths: months,
      });
      toast('已儲存 VIP 規則 ✓ 即時生效', 'success');
      void utils.settings.getVipRules.invalidate();
      void utils.vip.getPublicVipConfig.invalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setVipSaving(false);
    }
  };

  const saveShipping = async () => {
    const thresholdCents = hkdToCents(freeThreshold);
    if (thresholdCents === null) return setShipError('免運門檻要係非負數金額');
    setShipError(null);
    setShipSaving(true);
    try {
      await setShippingRules.mutateAsync({
        freeThresholdCents: thresholdCents,
        freeMethods: [...freeMethods],
        goldVipFreeMethods: [...goldFreeMethods],
      });
      toast('已儲存免運規則 ✓ 即時生效', 'success');
      void utils.settings.getShippingRules.invalidate();
      void utils.vip.getPublicVipConfig.invalidate();
    } catch (err) {
      toast(err instanceof Error ? err.message : '儲存失敗，請再試', 'error');
    } finally {
      setShipSaving(false);
    }
  };

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Crown size={16} aria-hidden="true" className="text-gold" />
        VIP＋免運規則
      </h3>
      <p className="mt-1.5 text-[13px] text-txt-3">
        改 VIP 門檻／折扣／會籍期限同免運規則；儲存後即時生效，前台介紹頁同結帳頁會跟住變。
      </p>

      {/* ── VIP 規則 ── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveVip();
        }}
        className="mt-5"
      >
        <h4 className="text-[13px] font-bold tracking-[0.08em] text-gold">VIP 會員制度</h4>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="vip-silver-threshold" className={labelCls}>
              銀會員年度消費門檻（HK$）
            </label>
            <input
              id="vip-silver-threshold"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={silverThreshold}
              onChange={(e) => setSilverThreshold(e.target.value)}
              placeholder="3000"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="vip-gold-threshold" className={labelCls}>
              金會員年度消費門檻（HK$）
            </label>
            <input
              id="vip-gold-threshold"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={goldThreshold}
              onChange={(e) => setGoldThreshold(e.target.value)}
              placeholder="5000"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="vip-silver-pct" className={labelCls}>
              銀會員折扣（92 ＝ 92 折，即俾 92%）
            </label>
            <input
              id="vip-silver-pct"
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputMode="decimal"
              value={silverPct}
              onChange={(e) => setSilverPct(e.target.value)}
              placeholder="92"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="vip-gold-pct" className={labelCls}>
              金會員折扣（90 ＝ 9 折，即俾 90%）
            </label>
            <input
              id="vip-gold-pct"
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputMode="decimal"
              value={goldPct}
              onChange={(e) => setGoldPct(e.target.value)}
              placeholder="90"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="vip-duration" className={labelCls}>
              會籍期限（月，由生效日起計）
            </label>
            <input
              id="vip-duration"
              type="number"
              min="1"
              max="120"
              step="1"
              inputMode="numeric"
              value={durationMonths}
              onChange={(e) => setDurationMonths(e.target.value)}
              placeholder="12"
              className={inputCls}
            />
          </div>
        </div>
        {vipError && <p className="mt-2 text-[12px] text-pink-soft">{vipError}</p>}
        <button
          type="submit"
          disabled={vipSaving || vipQuery.isLoading}
          className="btn btn-primary mt-4 !px-6 !py-2.5 text-[14px] disabled:opacity-60"
        >
          {vipSaving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
          儲存 VIP 規則
        </button>
      </form>

      {/* ── 免運規則 ── */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveShipping();
        }}
        className="mt-6 border-t pt-5"
        style={{ borderColor: 'var(--space-line)' }}
      >
        <h4 className="flex items-center gap-1.5 text-[13px] font-bold tracking-[0.08em] text-gold">
          <Truck size={14} aria-hidden="true" />
          免運制度
        </h4>
        <div className="mt-3 grid grid-cols-1 gap-4">
          <div className="sm:max-w-xs">
            <label htmlFor="ship-free-threshold" className={labelCls}>
              滿額免運門檻（HK$，唔夠就順豐到付）
            </label>
            <input
              id="ship-free-threshold"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={freeThreshold}
              onChange={(e) => setFreeThreshold(e.target.value)}
              placeholder="350"
              className={inputCls}
            />
          </div>
          <MethodChecks
            legend="滿額免運適用嘅取貨方式"
            selected={freeMethods}
            onToggle={(m) => setFreeMethods((s) => toggleIn(s, m))}
          />
          <MethodChecks
            legend="VIP 金會員全年免運適用嘅取貨方式（一件都免）"
            selected={goldFreeMethods}
            onToggle={(m) => setGoldFreeMethods((s) => toggleIn(s, m))}
          />
          <p className="text-[12px] leading-relaxed text-txt-3">
            備註：澳門／國外單永遠不包郵（到付），唔受呢度設定影響。
          </p>
        </div>
        {shipError && <p className="mt-2 text-[12px] text-pink-soft">{shipError}</p>}
        <button
          type="submit"
          disabled={shipSaving || shippingQuery.isLoading}
          className="btn btn-primary mt-4 !px-6 !py-2.5 text-[14px] disabled:opacity-60"
        >
          {shipSaving ? <WishingStar size={14} /> : <Save size={15} aria-hidden="true" />}
          儲存免運規則
        </button>
      </form>
    </section>
  );
}

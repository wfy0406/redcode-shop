import { useState } from 'react';
import { Truck } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * 預設取貨方式卡（2026-08-08 Glo 要求）
 * 會員喺度揀默認 送貨上門／順豐站自取／順豐智能櫃自取（自取可以填站點名稱/編號）。
 * 結帳時會自動帶入呢個選項，客人到時照樣可以臨時改、自己打地址。
 * 送貨上門用嘅地址喺上面資料卡嘅「地址」行改。
 */

type Method = 'address' | 'sf_station' | 'sf_locker';

const METHOD_OPTIONS: readonly [Method, string][] = [
  ['address', '送貨上門'],
  ['sf_station', '順豐站'],
  ['sf_locker', '智能櫃'],
];

const METHOD_FULL_LABEL: Record<Method, string> = {
  address: '送貨上門',
  sf_station: '順豐站自取',
  sf_locker: '順豐智能櫃自取',
};

interface DeliveryPrefUser {
  deliveryMethod?: Method | null;
  pickupPoint?: string | null;
  address?: string | null;
}

export default function DeliveryPrefCard({
  user,
  pushToast,
}: {
  user: DeliveryPrefUser;
  pushToast: (text: string) => void;
}) {
  const utils = trpc.useUtils();
  const updateProfile = trpc.auth.updateProfile.useMutation();

  const [editing, setEditing] = useState(false);
  const [method, setMethod] = useState<Method>('address');
  const [pickupPoint, setPickupPoint] = useState('');
  const [error, setError] = useState<string | null>(null);

  const currentMethod: Method =
    user.deliveryMethod === 'sf_station' || user.deliveryMethod === 'sf_locker'
      ? user.deliveryMethod
      : 'address';
  const summary =
    currentMethod === 'address'
      ? user.address?.trim()
        ? `送貨上門（${user.address.trim()}）`
        : '送貨上門（地址未填寫，可以喺上面資料卡「地址」行填）'
      : `${METHOD_FULL_LABEL[currentMethod]}${user.pickupPoint?.trim() ? `：${user.pickupPoint.trim()}` : '（未填站點）'}`;

  const startEdit = () => {
    setEditing(true);
    setError(null);
    setMethod(currentMethod);
    setPickupPoint(user.pickupPoint ?? '');
  };

  const save = async () => {
    setError(null);
    try {
      await updateProfile.mutateAsync({
        deliveryMethod: method,
        pickupPoint: method === 'address' ? null : pickupPoint.trim() || null,
      });
      await utils.auth.me.invalidate();
      pushToast('預設取貨方式已更新');
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '儲存失敗，請稍後再試');
    }
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-serif-tc text-xl font-semibold text-txt-1">
            <Truck size={18} aria-hidden="true" className="text-gold" />
            預設取貨方式
          </h2>
          <p className="mt-1 text-[13px] text-txt-3">
            結帳時會自動用呢個取貨方式，你到時照樣可以改、自己打地址。
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEdit}
            className="shrink-0 text-sm text-pink-soft transition-colors duration-200 hover:text-pink-tint"
          >
            編輯
          </button>
        )}
      </div>

      {!editing ? (
        <p className="mt-4 text-[15px] leading-relaxed text-txt-1">{summary}</p>
      ) : (
        <div className="mt-4">
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="預設取貨方式">
            {METHOD_OPTIONS.map(([value, label]) => {
              const active = method === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMethod(value)}
                  aria-pressed={active}
                  className="h-11 rounded-xl border text-[13px] transition-colors"
                  style={
                    active
                      ? {
                          borderColor: 'var(--pink)',
                          background: 'var(--pink-haze)',
                          color: 'var(--txt-1)',
                          fontWeight: 600,
                        }
                      : {
                          borderColor: 'var(--space-line)',
                          background: 'var(--space-2)',
                          color: 'var(--txt-3)',
                        }
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          {method !== 'address' && (
            <input
              type="text"
              value={pickupPoint}
              onChange={(e) => {
                setPickupPoint(e.target.value);
                if (error) setError(null);
              }}
              placeholder={
                method === 'sf_station'
                  ? '順豐站名稱／編號（選填），例如：大埔廣場順豐站'
                  : '智能櫃名稱／編號（選填），例如：852L110 大埔超級城智能櫃'
              }
              aria-label="自取站點"
              maxLength={255}
              autoFocus
              className="mt-3 h-12 w-full rounded-xl border bg-space-2 px-4 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink"
              style={{ borderColor: 'var(--space-line)' }}
            />
          )}
          {method === 'address' && (
            <p className="mt-3 text-[13px] leading-[1.7] text-txt-3">
              送貨上門用嘅地址，喺上面資料卡嘅「地址」行改。
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-[13px] text-pink-soft">
              {error}
            </p>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={updateProfile.isPending}
              className="btn btn-primary !px-5 !py-2.5 text-[13px] disabled:opacity-50"
            >
              {updateProfile.isPending ? '儲存中…' : '儲存'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={updateProfile.isPending}
              className="text-sm text-txt-3 transition-colors duration-200 hover:text-txt-1 disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

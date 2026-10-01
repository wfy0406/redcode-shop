import { useState } from 'react';
import { Truck } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import RegionStationPicker from '@/components/shop/RegionStationPicker';

/**
 * 預設取貨方式卡（2026-08-08 Glo 要求）
 * 會員喺度揀默認 送貨上門／自取（順豐站／自提點／智能櫃一粒制，v2.2.27 統一）；
 * 揀站時按站點類型自動歸類 sf_station／sf_locker（同註冊／結帳一致）。
 * v2.1.0（2026-09-29 VIP+免運）：自取站點改用 RegionStationPicker 下拉（先揀地區 HK/MO 再揀站），
 * 唔再自由填字；save 埋 region + stationId（authRouter updateProfile 已接）。
 * 結帳時會自動帶入呢個選項，客人到時照樣可以臨時改、自己打地址。
 * 送貨上門用嘅地址喺上面資料卡嘅「地址」行改。
 */

type Method = 'address' | 'sf_station' | 'sf_locker';
type Region = 'HK' | 'MO';

// v2.2.27（老闆指令「會員中心都要同註冊一樣」）：自取一粒制搞掂，
// 揀站時按站點類型自動歸類 sf_station／sf_locker；附近搜尋＋手動輸入都保留
const METHOD_OPTIONS: readonly [Method, string][] = [
  ['address', '送貨上門'],
  ['sf_station', '順豐站／自提點／智能櫃'],
];

const METHOD_FULL_LABEL: Record<Method, string> = {
  address: '送貨上門',
  sf_station: '順豐站自取',
  sf_locker: '順豐智能櫃自取',
};

const REGION_OPTIONS: readonly [Region, string][] = [
  ['HK', '香港'],
  ['MO', '澳門'],
];

interface DeliveryPrefUser {
  deliveryMethod?: Method | null;
  pickupPoint?: string | null;
  address?: string | null;
  // v2.1.0：預設收件地區＋預設站點 ID（auth.me 已回呢兩個欄）
  defaultRegion?: 'HK' | 'MO' | 'OVERSEAS' | null;
  defaultStationId?: string | null;
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
  const [region, setRegion] = useState<Region>('HK');
  const [stationId, setStationId] = useState<string | undefined>(undefined);
  const [stationName, setStationName] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const currentMethod: Method =
    user.deliveryMethod === 'sf_station' || user.deliveryMethod === 'sf_locker'
      ? user.deliveryMethod
      : 'address';
  // v2.2.28（老闆回報「註冊揀咗站但會員中心寫未揀」）：舊路線可能得 defaultStationId
  // 冇 pickupPoint 站名快照；摘要用站點清單反查站名補位（淨喺缺快照時先查）
  const needResolve =
    currentMethod !== 'address' && !user.pickupPoint?.trim() && !!user.defaultStationId;
  const resolveQuery = trpc.vip.listStations.useQuery(
    { region: user.defaultRegion === 'MO' ? 'MO' : 'HK' },
    { enabled: needResolve, retry: false },
  );
  const resolvedStationName = needResolve
    ? ((resolveQuery.data ?? []) as { id: string; name: string }[]).find(
        (s) => s.id === user.defaultStationId,
      )?.name
    : undefined;
  const stationLabel = user.pickupPoint?.trim() || resolvedStationName || '';
  const summary =
    currentMethod === 'address'
      ? user.address?.trim()
        ? `送貨上門（${user.address.trim()}）`
        : '送貨上門（地址未填寫，可以喺上面資料卡「地址」行填）'
      : `${METHOD_FULL_LABEL[currentMethod]}${stationLabel ? `：${stationLabel}` : '（未揀站點）'}${user.defaultRegion === 'MO' ? '（澳門）' : ''}`;

  const startEdit = () => {
    setEditing(true);
    setError(null);
    setMethod(currentMethod);
    setRegion(user.defaultRegion === 'MO' ? 'MO' : 'HK');
    setStationId(user.defaultStationId ?? undefined);
    // v2.2.28：冇站名快照就用反查返嚟嘅名，儲存時順手補寫返快照
    setStationName(user.pickupPoint?.trim() || resolvedStationName || undefined);
  };

  const save = async () => {
    setError(null);
    // 自取必揀站點（同結帳頁一致）
    if (method !== 'address' && !stationId) {
      setError('請先揀返自取站點（順豐站／自提點／智能櫃）');
      return;
    }
    try {
      await updateProfile.mutateAsync({
        deliveryMethod: method,
        // pickupPoint 繼續存站名快照（兼容舊嘅結帳顯示／WMS／email 流程）
        pickupPoint: method === 'address' ? null : (stationName ?? null),
        // v2.1.0：自取先存地區＋站點 ID；送貨上門後端會自動清 stationId，唔使傳
        ...(method !== 'address' ? { region, stationId: stationId ?? null } : {}),
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
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="預設取貨方式">
            {METHOD_OPTIONS.map(([value, label]) => {
              // v2.2.27：自取一粒制——亮起條件＝非送貨上門（自動歸類去 sf_locker 都照樣亮）
              const active =
                value === 'address' ? method === 'address' : method !== 'address';
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    if (active) return;
                    setMethod(value);
                    // 轉方式 → 舊站點唔啱用，要重新揀
                    setStationId(undefined);
                    setStationName(undefined);
                  }}
                  aria-pressed={active}
                  className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border px-2 text-center text-[13px] leading-[1.25] transition-colors"
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
                  {/* 選中提示點（radar-node 式發光環） */}
                  {active && value !== 'address' && (
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: 'var(--pink)',
                        boxShadow: '0 0 0 3px rgba(254,1,126,0.22)',
                      }}
                      aria-hidden="true"
                    />
                  )}
                  {label}
                </button>
              );
            })}
          </div>
          {method !== 'address' && (
            <div className="mt-3">
              {/* 地區揀選（HK／MO）：決定下拉出邊區嘅站；澳門單不包郵 */}
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="自取地區">
                {REGION_OPTIONS.map(([value, label]) => {
                  const active = region === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setRegion(value);
                        setStationId(undefined);
                        setStationName(undefined);
                      }}
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
              <div className="mt-3">
                <RegionStationPicker
                  region={region}
                  method={method === 'sf_locker' ? 'sf_locker' : 'sf_station'}
                  value={stationId}
                  onChange={(id, name, type) => {
                    setStationId(id);
                    setStationName(name);
                    if (error) setError(null);
                    // v2.2.27：揀咗邊型，類別自動跟（同註冊／結帳一致）
                    if (type === 'SF_LOCKER') setMethod('sf_locker');
                    else if (type === 'SF_STATION' || type === 'SERVICE_POINT') setMethod('sf_station');
                  }}
                />
              </div>
              {region === 'MO' && (
                <p className="mt-2 text-[13px] leading-relaxed text-txt-3">
                  澳門單・不包郵・順豐到付
                </p>
              )}
            </div>
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

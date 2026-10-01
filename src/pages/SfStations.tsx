import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { keepPreviousData } from '@tanstack/react-query';
import { ChevronDown, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import AccountToastStack, { useAccountToasts } from '@/components/account/Toast';

/**
 * v2.2.0 公開順豐站點查詢頁（/#/sf-stations，客人同員工都用）
 * 1. 頁頭：大寫闊字距英文 label「PICKUP POINTS」+ serif 中文大標 + hairline 金線
 * 2. 地址搵最近卡：vip.geocodeAddress → vip.nearestStations（top 5＋距離＋步行分鐘）；
 *    另有「用我而家嘅位置」（navigator.geolocation）副掣
 * 3. 篩選 bar：HK/MO pill tabs＋地區下拉（v2.2.2 老闆指令：揀完香港/澳門可以再揀區）
 *    ＋類型 chips（全部／順豐站／智能櫃／服務點）＋即時搜尋
 * 4. 列表：按 district 分組嘅 editorial hairline row（預設展開首 3 區）；
 *    搜尋／類型篩選中改平鋪（cap 200＋「顯示更多」）
 * 5. 會員每站「設為預設」底線文字掣 → auth.updateProfile → invalidate auth.me → toast；
 *    現時預設站顯示 ✦ 預設金標；未登入顯示「登入後可設預設」（Link /login）
 *
 * 鐵律：繁體中文；中文唔准 italic；動畫淨 opacity/transform（載入用 opacity 呼吸）；
 * Tailwind class 全部完整字面量；色用現有 site theme／vipTheme 色系
 * （金 #c9a35f 系／鉑銀 #7e8794 系／中性灰跟 --text-*／--space-line）。
 */

/* ===== 合約色（取自 VipVerify heritage 金 + vipTheme 鉑銀，唔准自己創色） ===== */
const HERITAGE_GOLD = '#c9a35f';
const GOLD_HAIRLINE = 'rgba(201, 163, 95, 0.35)';
const GOLD_TINT = 'rgba(201, 163, 95, 0.14)';
/* 鉑銀系（vipTheme SILVER）：#7e8794 邊框／底，#e8ebef 文字 */
const PLATINUM_LIGHT = '#e8ebef';
const CREAM = '#f5ead6';

type Region = 'HK' | 'MO';
type StationType = 'SF_STATION' | 'SF_LOCKER' | 'SERVICE_POINT';
type TypeFilter = 'ALL' | StationType;

interface Station {
  id: string;
  region: string;
  type: string;
  name: string;
  district: string | null;
  address: string | null;
  officialCode: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  serviceTime: string | null;
}

interface NearestStation extends Station {
  distanceKm: number;
}

/* 站點類型中文名＋徽章色（順豐站=金系／智能櫃=鉑銀系／服務點=中性灰） */
const TYPE_META: Record<string, { label: string; color: string; border: string; bg: string }> = {
  SF_STATION: {
    label: '順豐站',
    color: HERITAGE_GOLD,
    border: 'rgba(201, 163, 95, 0.5)',
    bg: 'rgba(201, 163, 95, 0.10)',
  },
  SF_LOCKER: {
    label: '智能櫃',
    color: PLATINUM_LIGHT,
    border: 'rgba(126, 135, 148, 0.55)',
    bg: 'rgba(126, 135, 148, 0.14)',
  },
  SERVICE_POINT: {
    label: '服務點',
    color: 'var(--text-2)',
    border: 'var(--space-line)',
    bg: 'var(--space-2)',
  },
};

const REGION_TABS: readonly [Region, string][] = [
  ['HK', '香港'],
  ['MO', '澳門'],
];

const TYPE_CHIPS: readonly [TypeFilter, string][] = [
  ['ALL', '全部'],
  ['SF_STATION', '順豐站'],
  ['SF_LOCKER', '智能櫃'],
  ['SERVICE_POINT', '服務點'],
];

/* 平鋪模式每次顯示嘅行數（cap 200＋「顯示更多」） */
const FLAT_PAGE = 200;

/* ===== 地址搵最近：狀態機 ===== */
type NearestState =
  | { status: 'idle' }
  | { status: 'busy'; mode: 'address' | 'geo' }
  | { status: 'done'; label: string; items: NearestStation[] }
  | { status: 'error'; message: string };

/** 步行分鐘：步速 5km/h，四捨五入 */
function walkingMinutes(distanceKm: number): number {
  return Math.round((distanceKm / 5) * 60);
}

/* ---------- 類型徽章 ---------- */
function TypeBadge({ type }: { type: string }) {
  const meta = TYPE_META[type] ?? TYPE_META.SERVICE_POINT;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] tracking-[0.14em]"
      style={{ color: meta.color, borderColor: meta.border, background: meta.bg }}
    >
      {meta.label}
    </span>
  );
}

/* ---------- 站點 row（最近模式／分組列表／平鋪共用；hairline 分隔，唔准卡叠卡） ---------- */
function StationRow({
  station,
  distanceKm,
  isLoggedIn,
  isDefault,
  setting,
  onSetDefault,
  last,
}: {
  station: Station;
  distanceKm?: number;
  isLoggedIn: boolean;
  isDefault: boolean;
  setting: boolean;
  onSetDefault: (station: Station) => void;
  last?: boolean;
}) {
  const metaLine = [station.phone, station.serviceTime].filter(Boolean).join('・');
  return (
    <div
      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
      style={last ? undefined : { borderBottom: '1px solid var(--space-line)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="font-serif-tc text-[16px] font-semibold leading-snug text-txt-1">
            {station.name}
          </h3>
          <TypeBadge type={station.type} />
          {isDefault && (
            <span
              className="inline-flex items-center gap-1 text-[12px] tracking-[0.12em]"
              style={{ color: HERITAGE_GOLD }}
            >
              ✦ 預設
            </span>
          )}
        </div>
        {distanceKm !== undefined && (
          <p className="mt-1 text-[13px]" style={{ color: HERITAGE_GOLD }}>
            約 {distanceKm.toFixed(1)} km・步行約 {walkingMinutes(distanceKm)} 分鐘
          </p>
        )}
        {station.address && (
          <p className="mt-1 text-[13px] leading-relaxed text-txt-3">
            {[station.district, station.address].filter(Boolean).join('・')}
          </p>
        )}
        {metaLine && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-txt-disabled">{metaLine}</p>
        )}
      </div>
      <div className="shrink-0 sm:pt-1 sm:text-right">
        {isLoggedIn ? (
          isDefault ? (
            <span className="text-[13px] text-txt-disabled">現時預設</span>
          ) : (
            <button
              type="button"
              onClick={() => onSetDefault(station)}
              disabled={setting}
              className="text-[13px] text-gold underline decoration-gold/50 underline-offset-4 transition-colors duration-150 hover:text-gold-soft disabled:opacity-40"
            >
              {setting ? '設定中…' : '設為預設'}
            </button>
          )
        ) : (
          <Link
            to="/login"
            className="text-[13px] text-txt-3 underline decoration-gold/40 underline-offset-4 transition-colors duration-150 hover:text-txt-1"
          >
            登入後可設預設
          </Link>
        )}
      </div>
    </div>
  );
}

export default function SfStations() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const updateProfile = trpc.auth.updateProfile.useMutation();
  const { toasts, push: pushToast } = useAccountToasts();

  /* ---------- 篩選狀態 ---------- */
  const [region, setRegion] = useState<Region>('HK');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  // v2.2.2（老闆指令）：揀完 HK/MO 再下拉揀區（'ALL'＝全部區）
  const [districtFilter, setDistrictFilter] = useState<string>('ALL');
  const [query, setQuery] = useState('');

  /* ---------- 分組摺疊狀態（預設展開首 3 區；toggled 記用戶手動覆蓋） ---------- */
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  /* ---------- 地址搵最近狀態 ---------- */
  const [addressInput, setAddressInput] = useState('');
  const [nearest, setNearest] = useState<NearestState>({ status: 'idle' });

  /* ---------- 設預設進行中嘅站 id ---------- */
  const [settingId, setSettingId] = useState<string | null>(null);

  /* ---------- 平鋪顯示更多 ---------- */
  const [flatCap, setFlatCap] = useState(FLAT_PAGE);

  /* 資料：一次過撈該區全部類型（type 唔傳=全部），類型 chips／搜尋喺前端即時過濾 */
  const stationsQuery = trpc.vip.listStations.useQuery(
    { region },
    { placeholderData: keepPreviousData },
  );
  const stations = (stationsQuery.data ?? []) as Station[];

  const isLoggedIn = !!user;
  const defaultStationId = user?.defaultStationId ?? null;

  /* 地區下拉選項：由當前 region 嘅站點衍生（去重＋中文排序＋站數），轉 region 自動重算 */
  const districtOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of stations) {
      const d = s.district?.trim();
      if (!d) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-HK'));
  }, [stations]);

  /* 類型 chips＋地區下拉＋搜尋即時過濾（名／地址／編號／地區，唔分大細楷） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stations.filter((s) => {
      if (districtFilter !== 'ALL' && (s.district?.trim() ?? '') !== districtFilter) return false;
      if (typeFilter !== 'ALL' && s.type !== typeFilter) return false;
      if (!q) return true;
      return [s.name, s.address ?? '', s.officialCode ?? '', s.district ?? ''].some((f) =>
        f.toLowerCase().includes(q),
      );
    });
  }, [stations, typeFilter, districtFilter, query]);

  /* 搜尋／類型篩選／揀咗區 → 平鋪；否則按 district 分組 */
  const flatMode = query.trim() !== '' || typeFilter !== 'ALL' || districtFilter !== 'ALL';

  const groups = useMemo(() => {
    const map = new Map<string, Station[]>();
    for (const s of filtered) {
      const key = s.district?.trim() || '其他';
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()];
  }, [filtered]);

  const isGroupExpanded = (district: string, index: number): boolean =>
    toggled[district] ?? expandAll ?? index < 3;

  const toggleGroup = (district: string, index: number) => {
    setToggled((prev) => ({
      ...prev,
      [district]: !(prev[district] ?? expandAll ?? index < 3),
    }));
  };

  /* 轉地區／類型／搜尋：重設摺疊同平鋪頁數（轉 HK/MO 埋區下拉一齊重設） */
  const switchRegion = (r: Region) => {
    setRegion(r);
    setDistrictFilter('ALL');
    setExpandAll(null);
    setToggled({});
    setFlatCap(FLAT_PAGE);
  };

  /* ---------- 設為預設收貨地址 ---------- */
  const setDefault = async (station: Station) => {
    if (settingId) return;
    setSettingId(station.id);
    try {
      await updateProfile.mutateAsync({
        deliveryMethod: station.type === 'SF_LOCKER' ? 'sf_locker' : 'sf_station',
        pickupPoint: station.name,
        region: station.region as Region,
        stationId: station.id,
      });
      await utils.auth.me.invalidate();
      pushToast('已設為預設收貨地址');
    } catch (err) {
      pushToast(err instanceof Error && err.message ? err.message : '設定失敗，請稍後再試');
    } finally {
      setSettingId(null);
    }
  };

  /* ---------- 打地址搵最近 ---------- */
  const findByAddress = async () => {
    const q = addressInput.trim();
    if (!q || nearest.status === 'busy') return;
    setNearest({ status: 'busy', mode: 'address' });
    try {
      const geo = await utils.vip.geocodeAddress.fetch({ q });
      if (!geo.ok) {
        setNearest({ status: 'error', message: geo.reason || '地址服務暫時唔可用，請稍後再試' });
        return;
      }
      if (geo.results.length === 0) {
        setNearest({
          status: 'error',
          message: `搵唔到「${q}」呢個地址，試下寫詳細少少（例如加返地區或街道名；中文／英文地址都打得）`,
        });
        return;
      }
      const hit = geo.results[0];
      const items = (await utils.vip.nearestStations.fetch({
        lat: hit.lat,
        lng: hit.lng,
        limit: 5,
      })) as NearestStation[];
      if (items.length === 0) {
        setNearest({
          status: 'error',
          message: '呢個位置附近暫時未有已登記坐標嘅站點，可以試下用下面嘅地區同類型篩選搵',
        });
        return;
      }
      setNearest({ status: 'done', label: hit.label, items });
    } catch {
      setNearest({ status: 'error', message: '網絡唔穩定，請稍後再試' });
    }
  };

  /* ---------- 用我而家嘅位置 ---------- */
  const findByGeolocation = async () => {
    if (nearest.status === 'busy') return;
    if (!('geolocation' in navigator)) {
      setNearest({ status: 'error', message: '你嘅瀏覽器唔支援定位，可以試下打地址搵' });
      return;
    }
    setNearest({ status: 'busy', mode: 'geo' });

    const usePosition = async (pos: GeolocationPosition) => {
      try {
        const items = (await utils.vip.nearestStations.fetch({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          limit: 5,
        })) as NearestStation[];
        if (items.length === 0) {
          setNearest({
            status: 'error',
            message: '你附近暫時未有已登記坐標嘅站點，可以試下打地址或者用下面嘅篩選搵',
          });
          return;
        }
        setNearest({ status: 'done', label: '你而家嘅位置', items });
      } catch {
        setNearest({ status: 'error', message: '網絡唔穩定，請稍後再試' });
      }
    };

    // v2.2.2 加強（老闆實測：第一次定位失敗、過陣再試又得）：
    // 手機 GPS 冷啟動要十幾廿秒先攞到衞星定位，舊版一刀切 10 秒 timeout → 初次必死、
    // 之後瀏覽器有咗暖身快取先「突然得返」。而家兩段式：
    // ① 快取/network 定位（enableHighAccuracy:false，通常 1–2 秒有，誤差幾十米夠搵站用）
    // ② ① 逾時先開 GPS 高精度重試（25 秒），中間畀用戶見到「轉咗用 GPS 精準定位…」
    // 錯誤訊息按 error.code 分開：拒絕授權／收唔到／逾時，各有各嘅補救提示。
    const requestPosition = (opts: PositionOptions) =>
      new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, opts);
      });

    const explainError = (code: number): string => {
      if (code === 1)
        return '你拒絕咗定位授權。想用得返：撳瀏覽器地址欄左邊嘅鎖形 icon → 權限 → 位置 → 允許，然後再撳一次；或者直接打地址搵';
      if (code === 2)
        return '而家收唔到定位訊號（室內／地庫會咁），行近窗邊或出面再試，或者直接打地址搵';
      return '定位逾時，試多一次或者直接打地址搵';
    };

    try {
      // ① 快速定位：准用 5 分鐘內快取；network-based 定位唔使等衞星
      const pos = await requestPosition({
        enableHighAccuracy: false,
        timeout: 12000,
        maximumAge: 300000,
      });
      await usePosition(pos);
    } catch (e1) {
      const err1 = e1 as GeolocationPositionError;
      // 只有「逾時」先自動重試高精度；拒絕授權／收唔到即刻報
      if (err1.code !== 3) {
        setNearest({ status: 'error', message: explainError(err1.code) });
        return;
      }
      try {
        const pos = await requestPosition({
          enableHighAccuracy: true,
          timeout: 25000,
          maximumAge: 60000,
        });
        await usePosition(pos);
      } catch (e2) {
        const err2 = e2 as GeolocationPositionError;
        setNearest({ status: 'error', message: explainError(err2.code) });
      }
    }
  };

  const busy = nearest.status === 'busy';

  return (
    <div className="pb-24">
      {/* ============ 1. 頁頭：PICKUP POINTS + serif 大標 + hairline 金線 ============ */}
      <header className="mx-auto w-full max-w-[1280px] px-5 pt-12 md:px-8 md:pt-16 xl:px-12">
        <p className="font-display text-[11px] uppercase tracking-[0.34em] text-gold">
          Pickup Points
        </p>
        <h1 className="mt-3 font-serif-tc text-3xl font-semibold leading-tight text-txt-1 md:text-4xl">
          順豐站點查詢
        </h1>
        <div
          aria-hidden="true"
          className="mt-6 h-px w-24"
          style={{
            background: `linear-gradient(90deg, ${HERITAGE_GOLD}, rgba(201, 163, 95, 0))`,
          }}
        />
        <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-txt-3">
          查全港澳順豐站、智能櫃同服務點；登入會員仲可以將常用站點設為預設，結帳時自動帶入。
        </p>
      </header>

      {/* ============ 2. 地址搵最近卡（hairline 金框，唔准卡叠卡） ============ */}
      <section className="mx-auto mt-10 w-full max-w-[1280px] px-5 md:px-8 xl:px-12">
        <div
          className="border p-5 md:p-7"
          style={{
            borderColor: GOLD_HAIRLINE,
            background:
              'linear-gradient(180deg, var(--space-2) 0%, var(--space-1) 100%)',
          }}
        >
          <p className="font-display text-[10px] uppercase tracking-[0.3em] text-gold-soft">
            Find Nearest
          </p>
          <h2 className="mt-2 font-serif-tc text-lg font-semibold text-txt-1">
            打地址搵最近站點
          </h2>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <MapPin
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-disabled"
                aria-hidden="true"
              />
              <input
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void findByAddress();
                }}
                aria-label="輸入地址搵最近站點"
                placeholder="打地址（中／英都得），例如：土瓜灣傲雲峰 / Nathan Road Mong Kok…"
                className="h-12 w-full border bg-space-2 pl-11 pr-4 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-gold"
                style={{ borderColor: 'var(--space-line)' }}
              />
            </div>
            <button
              type="button"
              onClick={() => void findByAddress()}
              disabled={busy || !addressInput.trim()}
              className="shrink-0 self-start text-sm font-medium tracking-wide text-gold underline decoration-gold/60 underline-offset-8 transition-colors duration-150 hover:text-gold-soft disabled:opacity-40 sm:self-auto"
            >
              {busy && nearest.mode === 'address' ? '搵緊…' : '搵最近站點'}
            </button>
            {/* v2.2.28（老闆指令「GPS logo 整靚啲，站點查詢都要」）：
                雷達 GPS 晶片＋聲納光圈，同註冊／結帳／會員中心嘅定位制同一套設計 */}
            <button
              type="button"
              onClick={findByGeolocation}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-2 self-start text-[13px] font-medium text-gold transition-colors duration-150 hover:text-gold-soft disabled:opacity-40 sm:self-auto"
            >
              <span
                className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                style={{
                  background: 'rgba(245,197,24,0.10)',
                  border: '1px solid rgba(245,197,24,0.4)',
                }}
              >
                <LocateFixed size={14} aria-hidden="true" />
                {!busy && (
                  <span
                    className="sfst-geo-ring pointer-events-none absolute inset-0 rounded-full"
                    style={{ border: '1px solid rgba(245,197,24,0.45)' }}
                    aria-hidden="true"
                  />
                )}
              </span>
              {busy && nearest.mode === 'geo' ? '定位中…' : '用我而家嘅位置'}
            </button>
          </div>

          {/* 狀態提示：載入用 opacity 呼吸；失敗友善提示；成功 banner＋top 5 */}
          {nearest.status === 'busy' && (
            <p className="mt-4 animate-pulse text-[13px] text-txt-3" aria-live="polite">
              {nearest.mode === 'geo' ? '定位中，搵緊你附近嘅站點…' : '搵緊最近嘅站點…'}
            </p>
          )}
          {nearest.status === 'error' && (
            <p role="alert" className="mt-4 text-[13px] leading-relaxed text-pink-soft">
              {nearest.message}
            </p>
          )}
          {nearest.status === 'done' && (
            <div className="mt-5 border-t pt-5" style={{ borderColor: 'rgba(201, 163, 95, 0.22)' }}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] text-txt-3">
                  距離
                  <span className="mx-1 text-gold-soft">「{nearest.label}」</span>
                  最近嘅站點
                </p>
                <button
                  type="button"
                  onClick={() => setNearest({ status: 'idle' })}
                  className="inline-flex items-center gap-1 text-[12px] text-txt-disabled transition-colors duration-150 hover:text-txt-2"
                >
                  <X size={12} aria-hidden="true" />
                  收起結果
                </button>
              </div>
              <div className="mt-1">
                {nearest.items.map((s, i) => (
                  <StationRow
                    key={s.id}
                    station={s}
                    distanceKm={s.distanceKm}
                    isLoggedIn={isLoggedIn}
                    isDefault={defaultStationId === s.id}
                    setting={settingId === s.id}
                    onSetDefault={(st) => void setDefault(st)}
                    last={i === nearest.items.length - 1}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ============ 3. 篩選 bar：HK/MO tabs＋類型 chips＋搜尋＋結果數 ============ */}
      <section className="mx-auto mt-12 w-full max-w-[1280px] px-5 md:px-8 xl:px-12">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
            {/* HK/MO pill segmented tabs */}
            <div
              role="group"
              aria-label="地區"
              className="inline-flex rounded-full border p-1"
              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
            >
              {REGION_TABS.map(([value, label]) => {
                const active = region === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => switchRegion(value)}
                    aria-pressed={active}
                    className="rounded-full px-5 py-1.5 text-sm transition-colors duration-150"
                    style={
                      active
                        ? { background: GOLD_TINT, color: CREAM, fontWeight: 600 }
                        : { color: 'var(--text-3)' }
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* 地區下拉（v2.2.2 老闆指令）：揀完香港/澳門再揀區；淨顯示有站嘅區 */}
            <div className="relative">
              <select
                value={districtFilter}
                onChange={(e) => {
                  setDistrictFilter(e.target.value);
                  setFlatCap(FLAT_PAGE);
                }}
                aria-label="揀地區"
                className="h-10 w-full appearance-none rounded-full border bg-space-2 pl-4 pr-10 text-[13px] text-txt-1 focus:border-gold focus:outline-none sm:w-48"
                style={{
                  borderColor:
                    districtFilter !== 'ALL' ? 'rgba(201, 163, 95, 0.65)' : 'var(--space-line)',
                }}
              >
                <option value="ALL">全部地區</option>
                {districtOptions.map(([d, n]) => (
                  <option key={d} value={d}>
                    {d}（{n}）
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-txt-disabled"
              />
            </div>

            {/* 類型 pill chips（active 金框） */}
            <div role="group" aria-label="站點類型" className="flex flex-wrap gap-2">
              {TYPE_CHIPS.map(([value, label]) => {
                const active = typeFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setTypeFilter(value);
                      setFlatCap(FLAT_PAGE);
                    }}
                    aria-pressed={active}
                    className="rounded-full border px-3.5 py-1.5 text-[13px] transition-colors duration-150"
                    style={
                      active
                        ? {
                            borderColor: 'rgba(201, 163, 95, 0.65)',
                            background: GOLD_TINT,
                            color: 'var(--gold-soft)',
                          }
                        : { borderColor: 'var(--space-line)', color: 'var(--text-3)' }
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* 搜尋框（名／地址／編號／地區 即時過濾） */}
            <div className="relative w-full sm:ml-auto sm:w-72">
              <Search
                size={15}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-disabled"
                aria-hidden="true"
              />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFlatCap(FLAT_PAGE);
                }}
                aria-label="搜尋站點"
                placeholder="搜尋名稱／地址／編號／地區…"
                className="h-11 w-full rounded-full border bg-space-2 pl-10 pr-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-gold"
                style={{ borderColor: 'var(--space-line)' }}
              />
            </div>
          </div>

          {/* 結果數＋全部展開/收起（分組模式先出） */}
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[13px] text-txt-3" aria-live="polite">
              {stationsQuery.isLoading ? '載入中…' : `共 ${filtered.length} 個站點`}
            </p>
            {!flatMode && groups.length > 1 && (
              <div className="flex items-center gap-4 text-[12px]">
                <button
                  type="button"
                  onClick={() => {
                    setExpandAll(true);
                    setToggled({});
                  }}
                  className="text-txt-3 underline underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
                >
                  全部展開
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExpandAll(false);
                    setToggled({});
                  }}
                  className="text-txt-3 underline underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
                >
                  全部收起
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ============ 4. 站點列表 ============ */}
        <div className="mt-4">
          {stationsQuery.isLoading ? (
            /* 載入態：opacity 呼吸（唔用預設 spinner） */
            <div className="space-y-3 py-2" aria-label="站點載入中">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="animate-pulse space-y-2 py-2">
                  <div className="h-4 w-2/5 rounded bg-space-3" />
                  <div className="h-3 w-3/5 rounded bg-space-3" />
                </div>
              ))}
            </div>
          ) : stationsQuery.isError ? (
            <div className="py-10 text-center">
              <p role="alert" className="text-[13px] text-pink-soft">
                站點清單載入失敗，請再試一次
              </p>
              <button
                type="button"
                onClick={() => void stationsQuery.refetch()}
                className="mt-2 text-[13px] text-gold underline decoration-gold underline-offset-4 hover:text-gold-soft"
              >
                重新載入
              </button>
            </div>
          ) : filtered.length === 0 ? (
            /* 空態（澳門站少／搜尋無結果 都照顧到） */
            <p className="py-12 text-center text-[13px] leading-relaxed text-txt-3">
              {query.trim()
                ? `搵唔到「${query.trim()}」相關嘅站點，試下其他關鍵字`
                : typeFilter !== 'ALL'
                  ? `呢個地區暫時未有${TYPE_META[typeFilter]?.label ?? ''}資料`
                  : '呢個地區暫時未有站點資料'}
            </p>
          ) : flatMode ? (
            /* 搜尋／類型篩選中：平鋪（cap 200＋顯示更多） */
            <div>
              {filtered.slice(0, flatCap).map((s, i, arr) => (
                <StationRow
                  key={s.id}
                  station={s}
                  isLoggedIn={isLoggedIn}
                  isDefault={defaultStationId === s.id}
                  setting={settingId === s.id}
                  onSetDefault={(st) => void setDefault(st)}
                  last={i === arr.length - 1 && filtered.length <= flatCap}
                />
              ))}
              {filtered.length > flatCap && (
                <div className="py-6 text-center">
                  <button
                    type="button"
                    onClick={() => setFlatCap((c) => c + FLAT_PAGE)}
                    className="text-[13px] text-gold underline decoration-gold/60 underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
                  >
                    顯示更多（仲有 {filtered.length - flatCap} 個）
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* 預設：按 district 分組嘅 editorial hairline row（首 3 區展開） */
            <div>
              {groups.map(([district, arr], gi) => {
                const expanded = isGroupExpanded(district, gi);
                return (
                  <div key={district} className="mb-2">
                    <button
                      type="button"
                      onClick={() => toggleGroup(district, gi)}
                      aria-expanded={expanded}
                      className="flex w-full items-baseline justify-between gap-3 border-b py-3 text-left"
                      style={{ borderColor: GOLD_HAIRLINE }}
                    >
                      <span className="flex items-baseline gap-3">
                        <span
                          className="font-serif-tc text-[15px] font-semibold tracking-[0.08em]"
                          style={{ color: HERITAGE_GOLD }}
                        >
                          {district}
                        </span>
                        <span className="text-[12px] text-txt-disabled">{arr.length} 個站點</span>
                      </span>
                      <ChevronDown
                        size={15}
                        aria-hidden="true"
                        className="shrink-0 self-center text-txt-disabled transition-transform duration-200"
                        style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                      />
                    </button>
                    {expanded && (
                      <div className="px-1">
                        {arr.map((s, i) => (
                          <StationRow
                            key={s.id}
                            station={s}
                            isLoggedIn={isLoggedIn}
                            isDefault={defaultStationId === s.id}
                            setting={settingId === s.id}
                            onSetDefault={(st) => void setDefault(st)}
                            last={i === arr.length - 1}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* 設預設成功 toast（跟會員中心玻璃 toast pattern） */}
      <AccountToastStack toasts={toasts} />

      {/* GPS 聲納光圈：淨 transform/opacity（老闆鐵律）；reduced-motion 停 */}
      <style>{`
        .sfst-geo-ring { animation: sfst-geo-sonar 2s cubic-bezier(0, 0, 0.2, 1) infinite; will-change: transform, opacity; }
        @keyframes sfst-geo-sonar {
          0% { transform: scale(1); opacity: 0.85; }
          80%, 100% { transform: scale(1.8); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .sfst-geo-ring { animation: none; }
        }
      `}</style>
    </div>
  );
}

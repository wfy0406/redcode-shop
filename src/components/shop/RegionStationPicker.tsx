import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { ChevronDown, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * 順豐站點揀選器（2026-09-29 VIP+免運，技術契約：RegionStationPicker）
 * 結帳／註冊／會員中心共用：揀咗自取（順豐站／智能櫃）就要喺度揀返個站，唔再自由填字。
 * - region 由 parent 控制（HK／MO；國外單唔會用到呢個組件，parent 唔好 render）
 * - 類型跟取貨方式：sf_station → SF_STATION＋SERVICE_POINT（服務點都可以自取，v2.2.7）；
 *   sf_locker → SF_LOCKER
 * - v2.2.25（老闆指令）：「搵最近」三類站一齊顯示（順豐站／自提點／智能櫃逐行有類型 badge），
 *   客人揀邊個型，onChange 第三參數回傳 type，parent 自動轉對應取貨方式類別；
 *   唔想揀可以照舊自己打字搜尋（全部站點清單仍跟類別範圍）
 * - 資料：vip.listStations（公開，後台 DB 可改）；按 district 分組 + 搜尋過濾
 * - 揀咗之後收埋做一張站點卡（站名＋地址＋「更改」）；站喺後台被刪/停用會自動叫 parent 清返
 */

type Region = 'HK' | 'MO';
type Method = 'sf_station' | 'sf_locker';

interface Station {
  id: string;
  name: string;
  district: string | null;
  address: string | null;
  type: string;
}

/** 最近站點：vip.nearestStations 回嚟每個多咗 distanceKm（公里） */
interface NearestStation extends Station {
  distanceKm: number;
}

/** 「搵最近」狀態機（簡化自 SfStations.tsx）：idle=正常分組清單；busy=定位／geocode 中 */
type NearestState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'done'; items: NearestStation[] }
  | { status: 'error'; message: string; retry?: boolean };

interface RegionStationPickerProps {
  region: Region;
  method: Method;
  value: string | undefined;
  /** v2.2.25：第三參數回傳站點類型（SF_STATION／SERVICE_POINT／SF_LOCKER），parent 自動轉類別用 */
  onChange: (stationId: string | undefined, stationName: string | undefined, stationType?: string) => void;
  /** 外層 label（預設跟 method：順豐站／智能櫃） */
  label?: string;
}

// v2.2.7（老闆指令「預設咗服務點結帳見唔到」）：順豐站方式要包埋服務點，
// 否則喺站點頁預設咗服務點嘅會員，結帳清單永遠載唔到佢個站 → 自我修復會清走預設
const TYPE_BY_METHOD: Record<Method, string[]> = {
  sf_station: ['SF_STATION', 'SERVICE_POINT'],
  sf_locker: ['SF_LOCKER'],
};

const DEFAULT_LABEL: Record<Method, string> = {
  sf_station: '順豐站',
  sf_locker: '智能櫃',
};

// v2.2.25：站點類型 badge（附近搜尋三類混排時逐行標示；全部站點清單都加埋，一望知係咩型）
const STATION_TYPE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  SF_STATION: { label: '順豐站', color: '#FF8FBF', bg: 'var(--pink-haze)', border: 'rgba(254,1,126,0.35)' },
  SERVICE_POINT: { label: '自提點', color: 'var(--gold)', bg: 'rgba(245,197,24,0.10)', border: 'rgba(245,197,24,0.38)' },
  SF_LOCKER: { label: '智能櫃', color: '#7DD3FC', bg: 'rgba(125,211,252,0.10)', border: 'rgba(125,211,252,0.35)' },
};

function TypeBadge({ type }: { type: string }) {
  const meta = STATION_TYPE_META[type];
  if (!meta) return null;
  return (
    <span
      className="inline-block shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold leading-[1.7]"
      style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
    >
      {meta.label}
    </span>
  );
}

export default function RegionStationPicker({
  region,
  method,
  value,
  onChange,
  label,
}: RegionStationPickerProps) {
  // 唔傳 type：攞全區再喺度 filter（sf_station 要同時包 SF_STATION＋SERVICE_POINT）
  const stationsQuery = trpc.vip.listStations.useQuery(
    { region },
    { placeholderData: keepPreviousData },
  );
  const stations = useMemo(
    () =>
      ((stationsQuery.data ?? []) as Station[]).filter((s) =>
        TYPE_BY_METHOD[method].includes(s.type),
      ),
    [stationsQuery.data, method],
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [nearest, setNearest] = useState<NearestState>({ status: 'idle' });
  const listRef = useRef<HTMLDivElement | null>(null);
  // 記低最後一次「搵最近」嘅觸發方式，fetch 失敗時俾「重試」掣重撳
  const lastNearestAction = useRef<(() => void) | null>(null);
  const utils = trpc.useUtils();

  const fieldLabel = label ?? DEFAULT_LABEL[method];
  const selected = value ? stations.find((s) => s.id === value) : undefined;

  // region／method 轉咗：舊揀落嘅站未必喺新清單，重開揀站介面（清 value 由下面嘅 effect 做）
  useEffect(() => {
    setQuery('');
    setActiveIndex(-1);
    setNearest({ status: 'idle' });
  }, [region, method]);

  // 自我修復：清單載完而揀咗嘅站唔存在（後台刪咗／停用咗／地區唔啱）→ 話畀 parent 清返
  useEffect(() => {
    if (!value) return;
    if (stationsQuery.isLoading || stationsQuery.isPlaceholderData || stationsQuery.isError) return;
    if (!stations.some((s) => s.id === value)) {
      onChange(undefined, undefined);
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, stations, stationsQuery.isLoading, stationsQuery.isPlaceholderData, stationsQuery.isError]);

  // 搜尋過濾：站名／地區／地址／編號 含關鍵字即中（唔分大細楷）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stations;
    return stations.filter((s) =>
      [s.name, s.district ?? '', s.address ?? '', s.id].some((f) =>
        f.toLowerCase().includes(q),
      ),
    );
  }, [stations, query]);

  // 按 district 分組（冇地區歸「其他」），保持 server 排序
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

  const flatFiltered = useMemo(() => groups.flatMap(([, arr]) => arr), [groups]);

  const pick = (station: Station) => {
    onChange(station.id, station.name, station.type);
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    setNearest({ status: 'idle' });
  };

  /* ---------- 搵最近：攞到坐標之後共用嘅撈站步驟（top 5，跟當前 region） ---------- */
  const runNearest = async (lat: number, lng: number) => {
    try {
      const items = (await utils.vip.nearestStations.fetch({
        lat,
        lng,
        region,
        limit: 5,
      })) as NearestStation[];
      if (items.length === 0) {
        setNearest({
          status: 'error',
          message: '附近暫時未有已登記坐標嘅站點，可以試下用關鍵字搵',
        });
        return;
      }
      setNearest({ status: 'done', items });
    } catch {
      setNearest({ status: 'error', message: '查詢失敗，請再試', retry: true });
    }
  };

  /* ---------- 用我位置搵最近（8 秒 timeout；拒絕／唔支援一律行內提示，唔彈窗） ---------- */
  const findByGeolocation = () => {
    if (nearest.status === 'busy') return;
    lastNearestAction.current = findByGeolocation;
    if (!('geolocation' in navigator)) {
      setNearest({ status: 'error', message: '開唔到定位，可以打地址搵附近' });
      return;
    }
    setNearest({ status: 'busy' });
    navigator.geolocation.getCurrentPosition(
      (pos) => void runNearest(pos.coords.latitude, pos.coords.longitude),
      () => setNearest({ status: 'error', message: '開唔到定位，可以打地址搵附近' }),
      { timeout: 8000 },
    );
  };

  /* ---------- 用搜尋框嘅地址／地區名搵附近（geocode 取第一個結果嘅坐標） ---------- */
  const findByAddress = async () => {
    const q = query.trim();
    if (q.length < 2 || nearest.status === 'busy') return;
    lastNearestAction.current = () => void findByAddress();
    setNearest({ status: 'busy' });
    try {
      const geo = await utils.vip.geocodeAddress.fetch({ q });
      if (!geo.ok || geo.results.length === 0) {
        setNearest({
          status: 'error',
          message: '搵唔到呢個地址，試下打附近地區名，例如『屯門』',
        });
        return;
      }
      const hit = geo.results[0];
      await runNearest(hit.lat, hit.lng);
    } catch {
      setNearest({ status: 'error', message: '查詢失敗，請再試', retry: true });
    }
  };

  // 鍵盤：↑↓ 移動、Enter 揀、Esc 收埋
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    // 最近模式／查詢中：清單已切走，↑↓／Enter 唔再對應分組清單
    if (nearest.status !== 'idle' && nearest.status !== 'error') return;
    if (flatFiltered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, flatFiltered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      pick(flatFiltered[activeIndex]);
    }
  };

  // active 項轉入可見範圍
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-station-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  /* ---------- 已揀：收埋做站點卡 ---------- */
  if (value && selected && !open) {
    return (
      <div className="w-full">
        <span className="mb-2 block text-sm text-txt-2">{fieldLabel}</span>
        <div
          className="flex items-start justify-between gap-3 rounded-xl border p-3.5"
          style={{ borderColor: 'var(--pink)', background: 'var(--pink-haze)' }}
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <MapPin size={16} className="mt-0.5 shrink-0 text-pink" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block text-[14px] font-medium leading-snug text-txt-1">
                {selected.name}
              </span>
              {(selected.district || selected.address) && (
                <span className="mt-0.5 block text-[13px] leading-relaxed text-txt-3">
                  {[selected.district, selected.address].filter(Boolean).join('・')}
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 text-[13px] text-pink-soft transition-colors duration-150 hover:text-pink-tint"
          >
            更改
          </button>
        </div>
      </div>
    );
  }

  /* ---------- 未揀／更改中：搜尋 + 分組清單 ---------- */
  let optionIndex = -1; // render 時逐個遞增，對返 flatFiltered 嘅 index
  return (
    <div className="w-full">
      <span className="mb-2 flex items-baseline justify-between gap-2 text-sm text-txt-2">
        <span>{fieldLabel}</span>
        <span className="text-[13px] text-txt-3">
          {region === 'MO' ? '澳門站點' : '香港站點'}
        </span>
      </span>

      <div className="relative">
        <Search
          size={16}
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-disabled"
          aria-hidden="true"
        />
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-label={`搜尋${fieldLabel}`}
          placeholder={`搜尋${fieldLabel}名稱／地區…`}
          className="h-12 w-full rounded-xl border bg-space-2 pl-11 pr-10 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink"
          style={{ borderColor: 'var(--space-line)' }}
        />
        {value && selected ? (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setQuery('');
            }}
            aria-label="收起站點清單"
            className="absolute right-3 top-1/2 flex min-h-8 min-w-8 -translate-y-1/2 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-txt-1"
          >
            <X size={15} aria-hidden="true" />
          </button>
        ) : (
          <ChevronDown
            size={16}
            className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-txt-disabled"
            aria-hidden="true"
          />
        )}
      </div>

      {/* 搵最近行：定位入口＋行內提示（最近模式／查詢中收埋，避免重複觸發） */}
      {open && nearest.status !== 'done' && nearest.status !== 'busy' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={findByGeolocation}
            className="inline-flex items-center gap-1.5 text-[13px] text-gold underline decoration-gold/50 underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
          >
            <LocateFixed size={13} aria-hidden="true" />
            用我位置搵最近
          </button>
          {nearest.status === 'error' && (
            <span
              role="alert"
              className={`inline-flex items-center gap-2 text-[12px] leading-relaxed ${
                nearest.retry ? 'text-pink-soft' : 'text-txt-3'
              }`}
            >
              {nearest.message}
              {nearest.retry && (
                <button
                  type="button"
                  onClick={() => lastNearestAction.current?.()}
                  className="text-[12px] text-gold underline decoration-gold/50 underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
                >
                  重試
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={`${fieldLabel}清單`}
          className="mt-2 max-h-64 overflow-y-auto rounded-xl border bg-space-2"
          style={{ borderColor: 'var(--space-line)' }}
        >
          {nearest.status === 'busy' ? (
            <div className="space-y-2 p-3" aria-label="搵最近站點中">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-space-3" />
              ))}
            </div>
          ) : nearest.status === 'done' ? (
            <div>
              <div className="sticky top-0 flex items-center justify-between gap-2 bg-space-2 px-4 pb-1 pt-2.5">
                <p className="text-[12px] font-medium tracking-wide text-gold">
                  最近你嘅站點<span className="ml-1.5 font-normal text-txt-3">（順豐站／自提點／智能櫃一齊顯示）</span>
                </p>
                <button
                  type="button"
                  onClick={() => setNearest({ status: 'idle' })}
                  className="shrink-0 text-[12px] text-txt-3 transition-colors duration-150 hover:text-txt-1"
                >
                  ← 返回全部站點
                </button>
              </div>
              <ul>
                {nearest.items.map((s) => {
                  const isSelected = s.id === value;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => pick(s)}
                        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-[var(--pink-haze)]"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <TypeBadge type={s.type} />
                            <span
                              className={`truncate text-[14px] leading-snug ${
                                isSelected ? 'font-medium text-pink-soft' : 'text-txt-1'
                              }`}
                            >
                              {s.name}
                            </span>
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-relaxed text-gold">
                            約 {s.distanceKm.toFixed(1)} 公里
                          </span>
                          {s.address && (
                            <span className="mt-0.5 block text-[12px] leading-relaxed text-txt-3">
                              {s.address}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : stationsQuery.isLoading ? (
            <div className="space-y-2 p-3" aria-label="站點載入中">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-space-3" />
              ))}
            </div>
          ) : stationsQuery.isError ? (
            <div className="p-4 text-center">
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
          ) : (
            <>
              {/* 打咗 ≥2 個字：頂部俾用戶改用地址／地區名搵附近站點 */}
              {query.trim().length >= 2 && (
                <div
                  className="border-b px-4 py-2"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <button
                    type="button"
                    onClick={() => void findByAddress()}
                    className="inline-flex items-center gap-1.5 text-[13px] text-gold underline decoration-gold/50 underline-offset-4 transition-colors duration-150 hover:text-gold-soft"
                  >
                    <Search size={13} aria-hidden="true" />
                    用「{query.trim()}」搵附近站點
                  </button>
                </div>
              )}
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-[13px] text-txt-3">
                  {query.trim()
                    ? `搵唔到「${query.trim()}」相關嘅站點，試下其他關鍵字`
                    : `呢個地區暫時未有${fieldLabel}資料`}
                </p>
              ) : (
            groups.map(([district, arr]) => (
              <div key={district}>
                <p className="sticky top-0 bg-space-2 px-4 pb-1 pt-2.5 text-[12px] font-medium tracking-wide text-gold">
                  {district}
                </p>
                <ul>
                  {arr.map((s) => {
                    optionIndex += 1;
                    const idx = optionIndex;
                    const active = idx === activeIndex;
                    const isSelected = s.id === value;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          data-station-index={idx}
                          onClick={() => pick(s)}
                          onMouseEnter={() => setActiveIndex(idx)}
                          className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors"
                          style={{
                            background: active ? 'var(--pink-haze)' : 'transparent',
                          }}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <TypeBadge type={s.type} />
                              <span
                                className={`truncate text-[14px] leading-snug ${
                                  isSelected ? 'font-medium text-pink-soft' : 'text-txt-1'
                                }`}
                              >
                                {s.name}
                              </span>
                            </span>
                            {s.address && (
                              <span className="mt-0.5 block text-[12px] leading-relaxed text-txt-3">
                                {s.address}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

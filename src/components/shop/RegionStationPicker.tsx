import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { ChevronDown, MapPin, Search, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';

/**
 * 順豐站點揀選器（2026-09-29 VIP+免運，技術契約：RegionStationPicker）
 * 結帳／註冊／會員中心共用：揀咗自取（順豐站／智能櫃）就要喺度揀返個站，唔再自由填字。
 * - region 由 parent 控制（HK／MO；國外單唔會用到呢個組件，parent 唔好 render）
 * - 類型跟取貨方式：sf_station → SF_STATION＋SERVICE_POINT（服務點都可以自取，v2.2.7）；
 *   sf_locker → SF_LOCKER
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

interface RegionStationPickerProps {
  region: Region;
  method: Method;
  value: string | undefined;
  onChange: (stationId: string | undefined, stationName: string | undefined) => void;
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
  const listRef = useRef<HTMLDivElement | null>(null);

  const fieldLabel = label ?? DEFAULT_LABEL[method];
  const selected = value ? stations.find((s) => s.id === value) : undefined;

  // region／method 轉咗：舊揀落嘅站未必喺新清單，重開揀站介面（清 value 由下面嘅 effect 做）
  useEffect(() => {
    setQuery('');
    setActiveIndex(-1);
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
    onChange(station.id, station.name);
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
  };

  // 鍵盤：↑↓ 移動、Enter 揀、Esc 收埋
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
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

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={`${fieldLabel}清單`}
          className="mt-2 max-h-64 overflow-y-auto rounded-xl border bg-space-2"
          style={{ borderColor: 'var(--space-line)' }}
        >
          {stationsQuery.isLoading ? (
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
          ) : filtered.length === 0 ? (
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
                            <span
                              className={`block truncate text-[14px] leading-snug ${
                                isSelected ? 'font-medium text-pink-soft' : 'text-txt-1'
                              }`}
                            >
                              {s.name}
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
        </div>
      )}
    </div>
  );
}

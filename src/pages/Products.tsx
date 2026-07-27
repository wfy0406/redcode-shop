import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRODUCT_CATEGORIES } from '@contracts/types';
import { trpc } from '@/providers/trpc';
import ProductCard from '@/components/ProductCard';
import WishingStar from '@/components/admin/WishingStar';
import CategoryTiles from '@/components/shop/CategoryTiles';
import SortSelect, { SORT_OPTIONS, type SortValue } from '@/components/shop/SortSelect';
import { demoShopProducts, toCardProduct, effectivePrice } from '@/components/shop/shop-utils';
import { useRevealDep } from '@/hooks/useReveal';

/**
 * §P2 商品列表 /products —— trpc.products.list
 * - 類別磁貼（一撳即篩，可收埋）＋ compact 搜尋欄＋排序（最新/價低→高/價高→低）
 * - 上架日期 chips：全部/今日/近3日/近7日/較早（client-side filter，疊加類別篩選）
 * - 關鍵字 300ms debounce 後即刻 refetch（server-side 篩 name+description）
 * - API 失敗 → demo 數據 fallback +「睇緊示範款」橫額
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type DateFilter = 'all' | 'today' | '3d' | '7d' | 'older';

const DATE_OPTIONS: { value: DateFilter; label: string }[] = [
  { value: 'all', label: '全部日期' },
  { value: 'today', label: '今日上架' },
  { value: '3d', label: '近 3 日' },
  { value: '7d', label: '近 7 日' },
  { value: 'older', label: '較早' },
];

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function matchDateFilter(listedDate: Date | string, filter: DateFilter): boolean {
  if (filter === 'all') return true;
  const listed = new Date(listedDate).getTime();
  const today0 = startOfToday();
  const age = Date.now() - listed;
  switch (filter) {
    case 'today':
      return listed >= today0;
    case '3d':
      return age < 3 * DAY_MS;
    case '7d':
      return age < 7 * DAY_MS;
    case 'older':
      return age >= 7 * DAY_MS;
  }
}

/** 指定日期篩選：listedDate 嘅本地年月日 == 揀咗嘅 YYYY-MM-DD（例如揀返某場直播上架日） */
function sameLocalDay(listedDate: Date | string, ymd: string): boolean {
  const d = new Date(listedDate);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === ymd;
}

export default function Products() {
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<SortValue>('latest');
  const [category, setCategory] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  // 指定日期（YYYY-MM-DD）：揀咗就蓋過上面嘅範圍 chips（今日/近3日嗰啲）
  const [pickedDate, setPickedDate] = useState('');
  const kw = keyword.trim();

  // 關鍵字 300ms debounce —— 停止輸入先打 API，即刻回應但唔會狂 call
  const [debouncedKw, setDebouncedKw] = useState('');
  useMemo(() => {
    const t = window.setTimeout(() => setDebouncedKw(kw), 300);
    return () => window.clearTimeout(t);
  }, [kw]);

  const listQuery = trpc.products.list.useQuery(
    debouncedKw
      ? { keyword: debouncedKw, ...(category !== 'all' ? { category } : {}) }
      : category !== 'all'
        ? { category }
        : undefined,
    { keepPreviousData: true },
  );

  // API 失敗 → demo 數據 fallback
  const allQuery = trpc.products.list.useQuery(undefined, {
    enabled: listQuery.isError,
    retry: false,
  });

  const products = useMemo(() => {
    // demo fallback：API 失敗時用示範數據（同樣行 client-side 篩選）
    if (listQuery.isError) {
      let demo = demoShopProducts();
      if (kw) {
        const k = kw.toLowerCase();
        demo = demo.filter((p) => p.name.toLowerCase().includes(k));
      }
      if (category !== 'all') demo = demo.filter((p) => p.category === category);
      demo = demo.filter((p) =>
        pickedDate ? sameLocalDay(p.listedDate, pickedDate) : matchDateFilter(p.listedDate, dateFilter),
      );
      return demo.map((p) => toCardProduct(p));
    }
    const merged = new Map<number, ReturnType<typeof toCardProduct>>();
    for (const p of listQuery.data ?? []) {
      merged.set(p.id, toCardProduct(p as never));
    }
    let list = [...merged.values()];
    // 上架日期篩選（client-side，同類別篩選疊加；指定日期優先過範圍 chips）
    list = list.filter((p) =>
      pickedDate ? sameLocalDay(p.listedDate, pickedDate) : matchDateFilter(p.listedDate, dateFilter),
    );
    if (sort === 'price-asc') list.sort((a, b) => effectivePrice(a) - effectivePrice(b));
    else if (sort === 'price-desc') list.sort((a, b) => effectivePrice(b) - effectivePrice(a));
    // 'latest'：server 已按 listedDate desc 排
    return list;
  }, [kw, sort, category, dateFilter, pickedDate, listQuery.data, listQuery.isError, allQuery.data]);

  const isInitialLoading = listQuery.isLoading && !listQuery.data;
  const gridRef = useRevealDep<HTMLDivElement>([kw, category, dateFilter, pickedDate, products.length]);
  const filtering = kw || category !== 'all' || dateFilter !== 'all' || pickedDate !== '';

  return (
    <section className="mx-auto max-w-[1280px] px-5 pb-24 pt-10 md:px-8 xl:px-12">
      {/* 頁首 */}
      <header className="text-center">
        <p className="script text-4xl">New arrivals ✦</p>
        <h1 className="mt-1 font-serif-tc text-[36px] font-bold leading-[1.25] text-txt-1 md:text-[44px]">
          全部商品
        </h1>
        <p className="mt-3 text-[14px] text-txt-2 md:text-[15px]">
          啱晒香港女生嘅日常穿搭，直播同款呢度都搵到
        </p>
      </header>

      {/* 類別磁貼 */}
      <div className="mt-8">
        <CategoryTiles value={category} onChange={setCategory} />
      </div>

      {/* 工具行：搜尋 + 排序（對齊 §P2 compact） */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div
          className="flex h-11 flex-1 items-center gap-2.5 rounded-full border px-4 backdrop-blur-xl"
          style={{
            minWidth: 200,
            borderColor: 'var(--glass-border)',
            background: 'var(--glass-bg)',
          }}
        >
          <Search size={16} aria-hidden="true" className="shrink-0 text-txt-3" />
          <input
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋商品名稱／描述…"
            aria-label="搜尋商品"
            className="w-full bg-transparent text-[14px] text-txt-1 placeholder:text-txt-disabled focus:outline-none"
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword('')}
              aria-label="清除搜尋"
              className="flex min-h-8 min-w-8 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-txt-1"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <SortSelect value={sort} onChange={setSort} options={SORT_OPTIONS} />
      </div>

      {/* 上架日期 chips（client filter；指定日期揀咗會蓋過呢排） */}
      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="按上架日期篩選">
        {DATE_OPTIONS.map((opt) => {
          const active = !pickedDate && dateFilter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setDateFilter(opt.value);
                setPickedDate('');
              }}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3.5 py-1.5 font-mono text-[12px] transition-colors duration-200',
                active
                  ? 'border-purple-text bg-space-3 font-bold text-lavender'
                  : 'text-txt-3 hover:border-purple-text hover:text-txt-2',
              )}
              style={
                active
                  ? undefined
                  : {
                      background: 'var(--glass-bg)',
                      backdropFilter: 'blur(12px)',
                      WebkitBackdropFilter: 'blur(12px)',
                      borderColor: 'var(--glass-border)',
                    }
              }
            >
              {opt.label}
            </button>
          );
        })}
        {/* 指定日期：揀返某一場直播／某一日上架嘅貨（揀咗會蓋過範圍 chips） */}
        <label className="ml-1 flex items-center gap-1.5 font-mono text-[12px] text-txt-3">
          指定日期
          <input
            type="date"
            value={pickedDate}
            onChange={(e) => {
              setPickedDate(e.target.value);
              if (e.target.value) setDateFilter('all');
            }}
            aria-label="揀選指定上架日期"
            className="h-8 rounded-lg border bg-space-2 px-2 font-mono text-[12px] text-txt-2 transition-colors focus:border-pink"
            style={{ borderColor: pickedDate ? 'var(--purple-text)' : 'var(--space-line)' }}
          />
          {pickedDate && (
            <button
              type="button"
              onClick={() => setPickedDate('')}
              aria-label="清除指定日期"
              className="flex min-h-8 min-w-8 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-txt-1"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>
      </div>

      {/* demo 橫額 */}
      {listQuery.isError && (
        <p
          className="mt-6 rounded-xl border px-4 py-2.5 text-[13px] text-gold-soft"
          style={{ borderColor: 'var(--glass-border)' }}
        >
          伺服器暫時連唔到，你而家睇緊示範款，落單功能暫停。
        </p>
      )}

      {/* 結果統計 */}
      {!isInitialLoading && (
        <p className="mt-6 font-mono text-[12px] text-txt-3" aria-live="polite">
            {products.length} 件商品
            {kw ? `（關鍵字「${kw}」）` : ''}
            {category !== 'all' ? `（${PRODUCT_CATEGORIES.find((c) => c.value === category)?.label ?? ''}）` : ''}
            {pickedDate ? `（${pickedDate} 上架）` : ''}
        </p>
      )}

      {/* 商品 grid：手機 2 欄 → md 3 欄 → xl 4 欄 */}
      {isInitialLoading ? (
        <div className="flex flex-col items-center gap-3 py-24">
          <WishingStar size={32} />
          <p className="text-[14px] text-txt-3">許願星搬緊貨…</p>
        </div>
      ) : products.length === 0 ? (
        <div className="py-24 text-center">
          <p className="script text-4xl">No result ✦</p>
          <p className="mt-3 text-[14px] text-txt-3">
            {filtering
              ? '呢個篩選組合暫時冇商品，試吓放寬條件。'
              : '暫時未有商品，遲啲再嚟睇吓。'}
          </p>
          {filtering && (
            <button
              type="button"
              onClick={() => {
                setKeyword('');
                setCategory('all');
                setDateFilter('all');
                setPickedDate('');
              }}
              className="btn btn-secondary mt-6 !px-6 !py-2.5 text-[14px]"
            >
              清除全部篩選
            </button>
          )}
        </div>
      ) : (
        <div ref={gridRef} className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-6 xl:grid-cols-4">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </section>
  );
}

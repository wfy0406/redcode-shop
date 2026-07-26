import { useMemo, useState } from 'react';
import { keepPreviousData } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import ProductCard from '@/components/ProductCard';
import WishingStar from '@/components/shop/WishingStar';
import { toCardProduct, demoShopProducts } from '@/components/shop/shop-utils';
import type { ShopProduct } from '@/components/shop/shop-utils';
import { useRevealDep } from '@/components/shop/useRevealDep';
import { cn } from '@/lib/utils';

/**
 * 全部商品 /products（design-system.md §P2）
 * - trpc.products.list.useQuery({ keyword }) 攞真數據；server 篩名稱/描述，
 *   另用全量 cache 補貨號 sku 匹配（list API 唔包 sku 欄位搜尋）
 * - 頂：H1 + 花體副標「pick your star」；玻璃工具列（搜尋框 §4.6 + DM Mono 排序 dropdown）
 * - 格網 §4.1：desktop 4 欄 / 平板 3 欄 / 手機 2 欄；卡片重用 shared <ProductCard>（§4.4 duotone hover）
 * - loading 用許願星（§3.7）；空結果用 empty-cart.png 插畫
 * - 篩選生效時格網 300ms opacity 過渡，唔好閃爍重排
 */

type SortKey = 'latest' | 'price-asc' | 'price-desc';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'latest', label: '最新上架' },
  { value: 'price-asc', label: '價錢 低 → 高' },
  { value: 'price-desc', label: '價錢 高 → 低' },
];

function effectivePrice(p: ShopProduct): number {
  return p.discountPrice ?? p.price;
}

export default function Products() {
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState<SortKey>('latest');
  const kw = keyword.trim();

  // 主查詢：server 按 keyword 篩名稱/描述；keepPreviousData 避免打字時格網閃爍重排
  const listQuery = trpc.products.list.useQuery(kw ? { keyword: kw } : undefined, {
    placeholderData: keepPreviousData,
    retry: false,
  });
  // 全量 cache：補返 sku 貨號搜尋（server list 只 LIKE name/description）
  const allQuery = trpc.products.list.useQuery(undefined, { staleTime: 5 * 60_000, retry: false });

  const products = useMemo<ShopProduct[]>(() => {
    // 靜態示範模式：後端連唔到（API error）→ 用內建示範商品
    if (listQuery.isError) {
      let demo = demoShopProducts();
      if (kw) {
        const lower = kw.toLowerCase();
        demo = demo.filter(
          (p) => p.name.toLowerCase().includes(lower) || p.sku.toLowerCase().includes(lower),
        );
      }
      if (sort === 'price-asc') demo.sort((a, b) => effectivePrice(a) - effectivePrice(b));
      else if (sort === 'price-desc') demo.sort((a, b) => effectivePrice(b) - effectivePrice(a));
      return demo;
    }
    const merged = new Map<number, ShopProduct>();
    for (const p of (listQuery.data ?? []) as ShopProduct[]) merged.set(p.id, p);
    if (kw) {
      const lower = kw.toLowerCase();
      for (const p of (allQuery.data ?? []) as ShopProduct[]) {
        if (!merged.has(p.id) && p.sku.toLowerCase().includes(lower)) merged.set(p.id, p);
      }
    }
    const list = [...merged.values()];
    if (sort === 'price-asc') list.sort((a, b) => effectivePrice(a) - effectivePrice(b));
    else if (sort === 'price-desc') list.sort((a, b) => effectivePrice(b) - effectivePrice(a));
    // 'latest'：server 已按 listedDate desc 排
    return list;
  }, [kw, sort, listQuery.data, allQuery.data]);

  const isInitialLoading = listQuery.isLoading && !listQuery.data;
  const gridRef = useRevealDep<HTMLDivElement>([kw, products.length]);

  return (
    <section className="mx-auto max-w-[1280px] px-5 py-16 md:px-8 md:py-24 xl:px-12">
      {/* 頁首：H1 + 花體副標（§P2） */}
      <header>
        <p className="script text-3xl md:text-4xl">pick your star ✦</p>
        <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
          全部商品
        </h1>
      </header>

      {/* 玻璃工具列：搜尋框 + 排序 */}
      <div
        className="mt-8 flex flex-col gap-3 rounded-2xl border p-3 sm:flex-row sm:items-center"
        style={{
          background: 'var(--glass-bg)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        {/* 搜尋框（§4.6：space-2 底、1px space-line、圓角 12px、高 48px、focus 粉邊 + 粉光） */}
        <div className="relative flex-1">
          <Search
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-txt-3"
          />
          <input
            type="search"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋商品名稱、描述或貨號…"
            aria-label="搜尋商品"
            className="h-12 w-full rounded-xl border bg-space-2 pl-11 pr-10 text-[15px] text-txt-1 transition-[border-color,box-shadow] duration-200 placeholder:text-txt-3 focus:border-pink focus:shadow-[0_0_0_3px_rgba(255,0,84,.15)]"
            style={{ borderColor: 'var(--space-line)' }}
          />
          {keyword && (
            <button
              type="button"
              onClick={() => setKeyword('')}
              aria-label="清除搜尋"
              className="absolute right-2 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-txt-1"
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* 排序：DM Mono 細 dropdown（§P2） */}
        <label className="flex items-center gap-2">
          <span className="whitespace-nowrap text-sm text-txt-3">排序</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="商品排序"
            className="h-12 rounded-xl border bg-space-2 px-4 font-mono text-sm text-txt-2 transition-colors duration-200 focus:border-pink"
            style={{ borderColor: 'var(--space-line)' }}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* 結果 */}
      {isInitialLoading ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <WishingStar size={48} label="許願星載入中…" />
        </div>
      ) : products.length === 0 ? (
        /* 空結果：empty-cart.png 插畫 */
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 py-16 text-center">
          <img src="/empty-cart.png" alt="" className="w-48 max-w-full opacity-90 md:w-64" />
          <p className="font-serif-tc text-xl font-semibold text-txt-1">
            {kw ? `搵唔到同「${kw}」相關嘅商品` : '暫時未有商品上架'}
          </p>
          <p className="max-w-sm text-sm text-txt-3">
            {kw ? '試下其他關鍵字，或者清除搜尋睇返全部商品。' : '遲啲再嚟睇下，Glo Glo 會繼續上架新貨。'}
          </p>
          {kw && (
            <button type="button" onClick={() => setKeyword('')} className="btn btn-secondary mt-2 !py-2.5 text-sm">
              清除搜尋
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="mt-6 font-mono text-sm text-txt-3" aria-live="polite">
            {products.length} 件商品{kw ? `（關鍵字「${kw}」）` : ''}
          </p>

          {/* 商品格網 §4.1：4 / 3 / 2 欄；篩選時 300ms opacity 過渡 */}
          <div ref={gridRef} className="mt-6">
            <div
              className={cn(
                'grid grid-cols-2 gap-4 transition-opacity duration-300 md:grid-cols-3 md:gap-6 xl:grid-cols-4',
                listQuery.isFetching && 'opacity-40',
              )}
            >
              {products.map((p, i) => (
                <div
                  key={p.id}
                  className="reveal"
                  style={{ transitionDelay: `${Math.min(i * 80, 400)}ms` }}
                >
                  <ProductCard product={toCardProduct(p)} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

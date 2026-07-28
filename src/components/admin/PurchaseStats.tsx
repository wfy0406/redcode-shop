import { useMemo, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { LoadingBlock } from './WishingStar';

/**
 * 訂貨統計（採購用）—— 按上架日期分組，數每款貨要訂幾件
 * - 需求＝有效訂單（排除已取消／已拒絕）嘅貨品件數，server 按 產品×尺寸 聚合好
 * - 每組有「全部−1」「全部−3」剔選（撳一次成組扣、再撳取消；兩個齊剔＝成組 −4），
 *   要訂＝需求−扣減（最低 0）
 * - 剔選只係呢個畫面嘅工作狀態，refresh 會重設；庫存欄只供參考，唔會自動扣
 * - 每組有「複製清單」掣，撳一下就可以直接貼落 WhatsApp 畀供應商
 */

const HKT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** UTC Date → HKT 嘅 YYYY-MM-DD（上架日期分組用） */
function hktDateKey(d: Date | string): string {
  return new Date(new Date(d).getTime() + HKT_OFFSET_MS).toISOString().slice(0, 10);
}

interface SizeLine {
  size: string | null;
  units: number;
}
interface ProductGroup {
  productId: number;
  name: string;
  sku: string;
  stock: number;
  sizes: SizeLine[];
  total: number;
}
interface DateGroup {
  date: string;
  products: ProductGroup[];
  units: number;
}

/** 扣減值只有 0／1／3／4（−1 同 −3 可以疊加） */
function hasDeduct(current: number, v: 1 | 3): boolean {
  return v === 1 ? current === 1 || current === 4 : current === 3 || current === 4;
}

export default function PurchaseStats() {
  const q = trpc.orders.purchaseStats.useQuery(undefined, { refetchOnWindowFocus: false });
  const [deduct, setDeduct] = useState<Record<string, number>>({});
  const [copiedDate, setCopiedDate] = useState<string | null>(null);

  // server 回嚟係「產品×尺寸」逐列；呢度砌成 日期 → 產品 → 尺寸 三層
  const groups = useMemo<DateGroup[]>(() => {
    const byDate = new Map<string, Map<number, ProductGroup>>();
    for (const r of q.data ?? []) {
      const date = hktDateKey(r.listedDate);
      let byProduct = byDate.get(date);
      if (!byProduct) byDate.set(date, (byProduct = new Map()));
      let p = byProduct.get(r.productId);
      if (!p) {
        p = { productId: r.productId, name: r.name, sku: r.sku, stock: r.stock, sizes: [], total: 0 };
        byProduct.set(r.productId, p);
      }
      p.sizes.push({ size: r.size, units: r.units });
      p.total += r.units;
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1)) // 最新上架排最上
      .map(([date, byProduct]) => {
        const products = [...byProduct.values()].sort((a, b) => b.total - a.total);
        for (const p of products) {
          p.sizes.sort((a, b) => String(a.size ?? '').localeCompare(String(b.size ?? '')));
        }
        return { date, products, units: products.reduce((s, p) => s + p.total, 0) };
      });
  }, [q.data]);

  const needOf = (date: string, p: ProductGroup) =>
    Math.max(0, p.total - (deduct[`${date}|${p.productId}`] ?? 0));
  const grandNeed = groups.reduce(
    (s, g) => s + g.products.reduce((s2, p) => s2 + needOf(g.date, p), 0),
    0,
  );

  // 成組剔選：組內全部款都有嗰個扣減 → 再撳＝成組取消；否則＝成組加上（唔郁另一個扣減嘅狀態）
  const groupHas = (g: DateGroup, v: 1 | 3) =>
    g.products.every((p) => hasDeduct(deduct[`${g.date}|${p.productId}`] ?? 0, v));
  const toggleGroupDeduct = (g: DateGroup, v: 1 | 3) => {
    const on = groupHas(g, v);
    setDeduct((m) => {
      const next = { ...m };
      for (const p of g.products) {
        const k = `${g.date}|${p.productId}`;
        const cur = next[k] ?? 0;
        const has = hasDeduct(cur, v);
        if (on && has) next[k] = cur - v;
        else if (!on && !has) next[k] = cur + v;
      }
      return next;
    });
  };

  const copyGroup = async (g: DateGroup) => {
    const lines = g.products.map((p) => {
      const d = deduct[`${g.date}|${p.productId}`] ?? 0;
      const sizesText = p.sizes.map((s) => `${s.size ?? '唔分尺寸'}×${s.units}`).join('、');
      return `${p.sku} ${p.name}：${sizesText} → 要訂 ${needOf(g.date, p)} 件${d > 0 ? `（需求 ${p.total}，扣 ${d}）` : ''}`;
    });
    const needSum = g.products.reduce((s, p) => s + needOf(g.date, p), 0);
    const text = [
      `【${g.date} 上架】訂貨清單`,
      ...lines,
      `合共 ${needSum} 件（${g.products.length} 款）`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopiedDate(g.date);
    window.setTimeout(() => setCopiedDate((c) => (c === g.date ? null : c)), 2000);
  };

  if (q.isLoading) return <LoadingBlock text="許願星數緊貨…" />;
  if (q.isError) {
    return (
      <div
        className="rounded-2xl border px-6 py-10 text-center"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <p className="text-[15px] text-pink-soft">載入訂貨統計失敗：{q.error.message}</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          className="btn btn-secondary mt-5 !px-6 !py-2.5 text-[14px]"
        >
          重試
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 頂部總結 + 重新整理 */}
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-4"
        style={{ borderColor: 'var(--gold)', background: 'var(--space-1)' }}
      >
        <p className="text-[14px] text-txt-2">
          全部要訂合共{' '}
          <span className="font-mono text-[24px] font-bold leading-none text-gold">{grandNeed}</span>{' '}
          件
        </p>
        <p className="text-[12px] text-txt-3">需求來自有效訂單（已取消／已拒絕唔計）</p>
        <button
          type="button"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
          className="btn btn-secondary ml-auto !px-4 !py-1.5 text-[12px] disabled:opacity-50"
        >
          <RefreshCw size={13} aria-hidden="true" />
          {q.isFetching ? '更新緊…' : '重新整理'}
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="py-14 text-center text-[14px] text-txt-3">而家冇有效訂單貨物要統計。</p>
      ) : (
        groups.map((g) => (
          <section
            key={g.date}
            className="overflow-hidden rounded-2xl border"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            {/* 上架日期組頭 */}
            <header
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3"
              style={{ borderColor: 'var(--space-line)' }}
            >
              <h3 className="font-mono text-[14px] font-bold text-txt-1">{g.date} 上架</h3>
              <span className="text-[12px] text-txt-3">
                {g.products.length} 款・需求 {g.units} 件
              </span>
              {([1, 3] as const).map((v) => {
                const on = groupHas(g, v);
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleGroupDeduct(g, v)}
                    className="rounded-full border px-3 py-1.5 font-mono text-[12px] transition-colors"
                    style={
                      on
                        ? {
                            background: 'var(--pink)',
                            borderColor: 'var(--pink)',
                            color: 'var(--space-1)',
                            fontWeight: 700,
                          }
                        : { borderColor: 'var(--space-line)', color: 'var(--text-2)' }
                    }
                  >
                    全部−{v}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => void copyGroup(g)}
                className="btn btn-secondary ml-auto !px-3 !py-1.5 text-[12px]"
              >
                {copiedDate === g.date ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <Copy size={13} aria-hidden="true" />
                )}
                {copiedDate === g.date ? '已複製' : '複製清單'}
              </button>
            </header>

            <ul className="flex flex-col">
              {g.products.map((p, idx) => {
                const key = `${g.date}|${p.productId}`;
                const d = deduct[key] ?? 0;
                const need = needOf(g.date, p);
                return (
                  <li
                    key={p.productId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                    style={idx > 0 ? { borderTop: '1px solid var(--space-line)' } : undefined}
                  >
                    {/* 品名 + 貨號 + 尺寸明細 chips */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14px] font-bold text-txt-1">
                        {p.name}
                        <span className="ml-2 font-mono text-[12px] font-normal text-txt-3">
                          {p.sku}
                        </span>
                      </p>
                      <p className="mt-1 flex flex-wrap gap-1.5">
                        {p.sizes.map((s) => (
                          <span
                            key={s.size ?? '-'}
                            className="rounded-full border px-2 py-0.5 font-mono text-[12px] text-txt-2"
                            style={{ borderColor: 'var(--space-line)' }}
                          >
                            {s.size ?? '唔分尺寸'}×{s.units}
                          </span>
                        ))}
                      </p>
                    </div>

                    <span className="font-mono text-[12px] text-txt-3">存 {p.stock}</span>
                    <span className="font-mono text-[13px] text-txt-2">需求 {p.total}</span>
                    {d > 0 && <span className="font-mono text-[12px] text-pink-soft">−{d}</span>}

                    <span
                      className="font-mono text-[15px] font-bold"
                      style={{ color: need > 0 ? 'var(--gold)' : 'var(--txt-3)' }}
                    >
                      要訂 {need}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <p className="text-[12px] leading-relaxed text-txt-3">
        要訂數＝需求−扣減（最低 0）。「全部−1／全部−3」撳一次成組扣、再撳一次取消，兩個可以同時用（＝成組−4）；剔選只係呢個畫面嘅工作狀態，refresh 後會重設。庫存欄只供參考，唔會自動扣。
      </p>
    </div>
  );
}

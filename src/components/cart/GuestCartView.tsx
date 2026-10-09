/**
 * 訪客購物車視圖（2026-10-09 訪客購買）—— Cart.tsx 未登入分支用。
 * 資料：localStorage `rc_guest_cart`（數量）＋ trpc.products.list（圖/名/價對照，價錢永遠 server 計）。
 * CTA：主「訪客快速結帳 →」去 /guest-checkout；次「登入會員」文字連結（唔搶主 CTA，design.md §2）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import {
  getGuestCart,
  subscribeGuestCart,
  updateGuestCartQuantity,
  removeFromGuestCart,
  type GuestCartItem,
} from '@/lib/guestCart';
import DuotoneImage from '@/components/DuotoneImage';
import QuantityStepper from '@/components/cart/QuantityStepper';
import { formatHKD } from '@/components/cart/format';

interface GuestLine extends GuestCartItem {
  name: string;
  sku: string;
  image: string | null;
  unit: number;
  missing: boolean;
}

export default function GuestCartView() {
  const [items, setItems] = useState<GuestCartItem[]>(() => getGuestCart());
  const productsQuery = trpc.products.list.useQuery();

  // localStorage 車變化（其他 tab／呢頁操作）即時刷新
  useEffect(() => subscribeGuestCart(() => setItems(getGuestCart())), []);

  const lines: GuestLine[] = useMemo(() => {
    const byId = new Map((productsQuery.data ?? []).map((p) => [p.id, p]));
    return items.map((it) => {
      const p = byId.get(it.productId);
      return {
        ...it,
        name: p?.name ?? `商品 #${it.productId}`,
        sku: p?.sku ?? '',
        image: p?.image ?? null,
        unit: p ? (p.discountPrice ?? p.price) : 0,
        missing: !p,
      };
    });
  }, [items, productsQuery.data]);

  const subtotal = lines.reduce((s, l) => s + (l.missing ? 0 : l.unit * l.quantity), 0);

  if (items.length === 0) {
    return (
      <div className="mt-8 flex flex-col items-center gap-5 rounded-2xl border border-space-line bg-space-2 px-6 py-16 text-center">
        <img src="/empty-cart.svg" alt="" className="h-32 w-auto opacity-90" loading="lazy" />
        <p className="script text-3xl">Your wishlist is still a wish…</p>
        <p className="max-w-sm text-[15px] text-txt-2">購物車係空嘅。去揀件啱心水嘅衫，許個願先啦。</p>
        <Link to="/products" className="btn btn-secondary">
          去逛逛
        </Link>
        <p className="text-[13px] text-txt-3">
          已經係會員？<Link to="/login" state={{ from: '/cart' }} className="text-gold underline underline-offset-4">登入</Link>睇返你嘅會員購物車。
        </p>
      </div>
    );
  }

  return (
    <div className="mt-10 lg:grid lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)] lg:gap-10">
      {/* 左：商品行列 */}
      <ul>
        {lines.map((l) => (
          <li
            key={`${l.productId}-${l.size ?? ''}`}
            className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b py-6"
            style={{ borderColor: 'var(--space-line)' }}
          >
            {l.image ? (
              <Link to={`/products/${l.productId}`} className="shrink-0" aria-label={`睇 ${l.name} 詳情`}>
                <DuotoneImage
                  src={l.image}
                  alt={l.name}
                  wrapperClassName="h-24 w-24 rounded-xl border"
                  className="h-full w-full object-cover"
                />
              </Link>
            ) : (
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl border text-[12px] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
                已下架
              </div>
            )}
            <div className="min-w-0 flex-1 basis-40">
              <p className="font-medium leading-snug text-txt-1">{l.name}</p>
              {l.sku && <p className="mt-1 font-mono text-[13px] text-txt-3">貨號 {l.sku}</p>}
              {l.size && <p className="mt-0.5 text-[13px] text-txt-3">尺寸 {l.size}</p>}
              <p className="mt-1 font-mono text-[14px] text-txt-2">{l.missing ? '—' : formatHKD(l.unit)}</p>
            </div>
            <QuantityStepper
              quantity={l.quantity}
              onChange={(next) => updateGuestCartQuantity(l.productId, l.size, next)}
            />
            <span className="min-w-16 text-right font-mono tabular-nums text-txt-1">
              {l.missing ? '—' : formatHKD(l.unit * l.quantity)}
            </span>
            <button
              type="button"
              onClick={() => removeFromGuestCart(l.productId, l.size)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-pink-soft"
              aria-label={`移除 ${l.name}`}
            >
              <Trash2 size={17} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {/* 右：結算面板 */}
      <aside className="mt-10 lg:mt-0">
        <div
          className="rounded-2xl border p-6 lg:sticky lg:top-24"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderColor: 'var(--glass-border)',
          }}
        >
          <h2 className="font-serif-tc text-xl font-semibold text-txt-1">訂單摘要</h2>
          <div className="mt-5 space-y-3 text-[15px]">
            <div className="flex items-baseline justify-between">
              <span className="text-txt-2">小計</span>
              <span className="font-mono text-txt-1">{formatHKD(subtotal)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-txt-2">運費</span>
              <span className="text-sm text-txt-3">自取滿額免運／到付</span>
            </div>
            <div className="flex items-baseline justify-between border-t pt-4" style={{ borderColor: 'var(--space-line)' }}>
              <span className="font-medium text-txt-1">總計</span>
              <span className="font-mono text-2xl text-pink">{formatHKD(subtotal)}</span>
            </div>
          </div>
          <Link to="/guest-checkout" className="btn btn-primary mt-6 w-full">
            訪客快速結帳 →
          </Link>
          <p className="mt-3 text-center text-[13px] text-txt-3">
            唔使開帳號，填名、電話、email 就落得單
          </p>
          <p className="mt-3 text-center text-[13px] text-txt-3">
            已經係會員？
            <Link to="/login" state={{ from: '/cart' }} className="text-gold underline underline-offset-4">
              登入
            </Link>
            享有 VIP 折扣
          </p>
        </div>
      </aside>
    </div>
  );
}

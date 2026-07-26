import { useState } from 'react';
import { Link } from 'react-router';
import { Trash2 } from 'lucide-react';
import DuotoneImage from '@/components/DuotoneImage';
import LoginPrompt from '@/components/cart/LoginPrompt';
import QuantityStepper from '@/components/cart/QuantityStepper';
import { WishStarSpinner } from '@/components/cart/WishingStar';
import { formatHKD } from '@/components/cart/format';
import { cartSubtotal, lineTotal, unitPrice } from '@/components/cart/types';
import type { CartLine } from '@/components/cart/types';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';

/**
 * RedCode 購物車（design-system.md §P6）
 * 左 65%：商品行列（圖 96px duotone + 品名 + 貨號 + DM Mono 單價 + 步進器 + 行小計）
 * 右 35%：結算面板（--glass-bg-strong，sticky top 96px）：小計／運費／總計 → Primary「去結帳」
 * 手機：結算面板轉底部 sticky 結算條（§6.2）
 * 空車：empty-cart.png + 花體「Your wishlist is still a wish…」+ Secondary「去逛逛」
 * 未登入：玻璃卡提示（唔好 hard redirect）
 */

/* ---------- 單行商品 ---------- */
interface CartLineRowProps {
  line: CartLine;
  pending: boolean;
  onQuantityChange: (line: CartLine, next: number) => void;
  onRemove: (line: CartLine) => void;
}

function CartLineRow({ line, pending, onQuantityChange, onRemove }: CartLineRowProps) {
  const { product } = line;
  const unit = unitPrice(line);
  const discounted = product.discountPrice !== null && product.discountPrice < product.price;

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b py-6"
      style={{ borderColor: 'var(--space-line)' }}
    >
      {/* 產品圖 96px duotone（hover 上色） */}
      <Link
        to={`/products/${product.id}`}
        className="shrink-0"
        aria-label={`睇 ${product.name} 詳情`}
      >
        <DuotoneImage
          src={product.image}
          alt={product.name}
          wrapperClassName="h-24 w-24 rounded-xl border"
          className="h-full w-full object-cover"
        />
      </Link>

      {/* 品名 + 貨號 + size + 單價 */}
      <div className="min-w-0 flex-1 basis-40">
        <p className="font-medium leading-snug text-txt-1">{product.name}</p>
        <p className="mt-1 font-mono text-[13px] text-txt-3">貨號 {product.sku}</p>
        {line.size && (
          <p className="mt-0.5 font-mono text-[13px] text-txt-3">尺寸 {line.size}</p>
        )}
        <p className="mt-2 font-mono text-[15px] text-pink">
          {formatHKD(unit)}
          {discounted && (
            <span className="ml-2 text-[13px] text-txt-3 line-through">
              {formatHKD(product.price)}
            </span>
          )}
        </p>
      </div>

      {/* 步進器（0 = 刪除） */}
      <QuantityStepper
        quantity={line.quantity}
        disabled={pending}
        onChange={(next) => onQuantityChange(line, next)}
      />

      {/* 行小計 */}
      <p className="w-24 text-right font-mono text-base text-txt-1">
        {formatHKD(lineTotal(line))}
      </p>

      {/* 移除 */}
      <button
        type="button"
        className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-txt-3 transition-colors hover:text-pink-soft"
        onClick={() => onRemove(line)}
        disabled={pending}
        aria-label={`移除 ${product.name}`}
      >
        <Trash2 size={18} aria-hidden="true" />
      </button>
    </li>
  );
}

/* ---------- 空車狀態（§P6） ---------- */
function EmptyCart() {
  return (
    <div className="mt-14 flex flex-col items-center pb-8 text-center">
      <img src="/empty-cart.jpg" alt="" className="w-52 max-w-full md:w-64" />
      <p className="script mt-6 text-3xl md:text-4xl">Your wishlist is still a wish…</p>
      <p className="mt-3 max-w-sm text-[15px] text-txt-2">
        購物車仲係空嘅。今晚直播款唔等人，去揀件啱心水嘅先。
      </p>
      <Link to="/products" className="btn btn-secondary mt-8">
        去逛逛
      </Link>
    </div>
  );
}

/* ---------- 載入 skeleton ---------- */
function CartSkeleton() {
  return (
    <div className="mt-10 space-y-4" aria-label="購物車載入中">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-[120px] animate-pulse rounded-2xl bg-space-2" />
      ))}
    </div>
  );
}

export default function Cart() {
  const { user, isLoading: authLoading } = useAuth();
  const utils = trpc.useUtils();

  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const [pendingId, setPendingId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const updateQuantity = trpc.cart.updateQuantity.useMutation({
    onSuccess: () => void utils.cart.list.invalidate(),
    onError: (err) => setMutationError(err.message),
    onSettled: () => setPendingId(null),
  });
  const removeItem = trpc.cart.remove.useMutation({
    onSuccess: () => void utils.cart.list.invalidate(),
    onError: (err) => setMutationError(err.message),
    onSettled: () => setPendingId(null),
  });

  const onQuantityChange = (line: CartLine, next: number) => {
    if (next < 0) return;
    setMutationError(null);
    setPendingId(line.id);
    // 後端規格：quantity = 0 即刪除
    updateQuantity.mutate({ cartItemId: line.id, quantity: next });
  };

  const onRemove = (line: CartLine) => {
    setMutationError(null);
    setPendingId(line.id);
    removeItem.mutate({ cartItemId: line.id });
  };

  const items = (cartQuery.data ?? []) as CartLine[];
  const subtotal = cartSubtotal(items);

  return (
    <section className="mx-auto max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">Your Wishes</p>
      <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
        購物車
      </h1>

      {authLoading ? (
        <CartSkeleton />
      ) : !user ? (
        <LoginPrompt message="登入會員之後，先可以睇到自己嘅購物車。" />
      ) : cartQuery.isLoading ? (
        <CartSkeleton />
      ) : cartQuery.isError ? (
        <div
          className="mx-auto mt-12 max-w-[420px] rounded-3xl border p-8 text-center"
          style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
        >
          <p role="alert" className="text-[15px] text-pink-soft">
            購物車載入失敗：{cartQuery.error.message}
          </p>
          <button
            type="button"
            className="btn btn-secondary mt-6"
            onClick={() => void cartQuery.refetch()}
          >
            再試一次
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyCart />
      ) : (
        <>
          {mutationError && (
            <p
              role="alert"
              className="mt-6 rounded-xl border px-4 py-3 text-[13px] text-pink-soft"
              style={{ borderColor: 'var(--pink)', background: 'var(--pink-haze)' }}
            >
              {mutationError}
            </p>
          )}

          {/* 手機預留底部 sticky 結算條嘅位 */}
          <div className="mt-10 pb-24 lg:grid lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)] lg:gap-10 lg:pb-0">
            {/* 左 65%：商品行列 */}
            <ul>
              {items.map((line) => (
                <CartLineRow
                  key={line.id}
                  line={line}
                  pending={pendingId === line.id}
                  onQuantityChange={onQuantityChange}
                  onRemove={onRemove}
                />
              ))}
            </ul>

            {/* 右 35%：結算面板（desktop sticky top 96px） */}
            <aside className="mt-10 hidden lg:mt-0 lg:block">
              <div
                className="sticky top-24 rounded-2xl border p-6"
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
                    {/* TODO: 同 RedCode 確認運費政策（而家照直播慣例順豐到付） */}
                    <span className="text-sm text-txt-3">順豐到付</span>
                  </div>
                  <div
                    className="flex items-baseline justify-between border-t pt-4"
                    style={{ borderColor: 'var(--space-line)' }}
                  >
                    <span className="font-medium text-txt-1">總計</span>
                    <span className="font-mono text-2xl text-pink">{formatHKD(subtotal)}</span>
                  </div>
                </div>
                <Link to="/checkout" className="btn btn-primary mt-6 w-full">
                  去結帳
                </Link>
                <p className="mt-4 text-center text-[13px] text-txt-3">
                  付款方式同截圖上傳喺下一步搞掂
                </p>
              </div>
            </aside>
          </div>

          {/* 手機：底部 sticky 結算條（§6.2） */}
          <div
            className="fixed inset-x-0 bottom-0 z-40 border-t lg:hidden"
            style={{
              background: 'var(--glass-bg-strong)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              borderColor: 'var(--glass-border)',
            }}
          >
            <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-5 py-3">
              <div>
                <p className="text-[13px] text-txt-3">總計（運費到付）</p>
                <p className="font-mono text-xl leading-tight text-pink">{formatHKD(subtotal)}</p>
              </div>
              <Link to="/checkout" className="btn btn-primary !px-7 !py-3">
                去結帳
              </Link>
            </div>
          </div>
        </>
      )}

      {/* 靜靜哋喺角落嘅 loading 星（query 背景 refetch 時唔閃成版） */}
      {cartQuery.isFetching && !cartQuery.isLoading && (
        <div className="pointer-events-none fixed bottom-6 left-6 z-40">
          <WishStarSpinner size={18} />
        </div>
      )}
    </section>
  );
}

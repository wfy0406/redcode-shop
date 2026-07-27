import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Heart, Minus, Plus, ShoppingBag } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import ProductCard from '@/components/ProductCard';
import WishingStar from '@/components/admin/WishingStar';
import {
  demoShopProducts,
  effectivePrice,
  formatHKD,
  hasDiscount,
  parseSizes,
  toCardProduct,
} from '@/components/shop/shop-utils';
import { useReveal, useRevealDep } from '@/hooks/useReveal';

/**
 * §P3 商品詳情 /product/:id —— trpc.products.byId
 * 左圖右資訊（手機上下）：折扣 badge、價錢、尺寸 pill 選擇（必填）、數量 stepper、
 * 加入購物車（真 mutation + toast）、心心收藏（本地）、描述、相關商品（同類別隨機 4 件）。
 * 讀取失敗 → demo fallback +「睇緊示範款」橫額；load 唔到 id → 搵唔到頁。
 */

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const productId = Number(id);
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const productQuery = trpc.products.byId.useQuery(
    { id: productId },
    { enabled: Number.isInteger(productId) && productId > 0, retry: 1 },
  );
  const relatedQuery = trpc.products.list.useQuery(undefined, { retry: 1 });

  // API 失敗 → demo fallback（「睇緊示範款」橫額）
  const product = useMemo(() => {
    if (productQuery.data) return productQuery.data;
    if (productQuery.isError) {
      return demoShopProducts().find((p) => p.id === productId) ?? null;
    }
    return undefined; // loading
  }, [productQuery.data, productQuery.isError, productId]);
  const isDemo = productQuery.isError && product !== null;

  const sizes = useMemo(() => parseSizes(product?.sizes), [product?.sizes]);
  // 尺寸開關閂咗（冇尺寸嘅貨，例如袋/飾物）→ 唔顯示尺寸、落單唔使揀
  const sizeEnabled = product?.sizeEnabled ?? true;
  const needSize = sizeEnabled && sizes.length > 0;

  const [size, setSize] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [wished, setWished] = useState(false);
  const [sizeError, setSizeError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const addCart = trpc.cart.add.useMutation({
    onSuccess: () => {
      void utils.cart.list.invalidate();
      setToast('已加入購物車 ✓');
      window.setTimeout(() => setToast(null), 2000);
    },
    onError: (err) => {
      setToast(err.message || '加入失敗，請再試');
      window.setTimeout(() => setToast(null), 2500);
    },
  });

  const related = useMemo(() => {
    const source = relatedQuery.data ?? demoShopProducts();
    const cards = source.map((p) => toCardProduct(p as never));
    return cards
      .filter((p) => p.id !== productId)
      .sort((a, b) => {
        // 同類別優先，其餘補位
        const ca = a.category === product?.category ? 0 : 1;
        const cb = b.category === product?.category ? 0 : 1;
        return ca - cb;
      })
      .slice(0, 4);
  }, [relatedQuery.data, productId, product?.category]);

  const infoRef = useReveal<HTMLDivElement>({ variant: 'right', delay: 100 });
  const gridRef = useRevealDep<HTMLDivElement>([productId]);

  const handleAdd = () => {
    if (!product) return;
    if (needSize && !size) {
      setSizeError(true);
      return;
    }
    if (!user) {
      setToast('請先登入會員先可以加入購物車');
      window.setTimeout(() => setToast(null), 2500);
      return;
    }
    addCart.mutate({ productId: product.id, size: size ?? undefined, quantity: qty });
  };

  if (product === undefined) {
    return (
      <section className="mx-auto max-w-[1280px] px-5 py-24 md:px-8">
        <div className="flex flex-col items-center gap-3">
          <WishingStar size={32} />
          <p className="text-[14px] text-txt-3">許願星搬緊商品資料…</p>
        </div>
      </section>
    );
  }

  if (product === null) {
    return (
      <section className="mx-auto max-w-[1280px] px-5 py-24 text-center md:px-8">
        <p className="script text-4xl">Not found ✦</p>
        <h1 className="mt-2 font-serif-tc text-2xl font-bold text-txt-1">搵唔到呢件商品</h1>
        <p className="mt-3 text-[14px] text-txt-3">可能已經賣晒落架啦，去睇吓其他新款啦。</p>
        <Link to="/products" className="btn btn-primary mt-8">
          全部商品
        </Link>
      </section>
    );
  }

  const discounted = hasDiscount(product);
  const effPrice = effectivePrice(product);
  const outOfStock = product.stock <= 0;

  return (
    <section className="mx-auto max-w-[1280px] px-5 pb-24 pt-10 md:px-8 xl:px-12">
      {/* 麵包屑 */}
      <nav aria-label="麵包屑" className="text-[13px] text-txt-3">
        <Link to="/" className="transition-colors hover:text-txt-1">
          首頁
        </Link>
        <span aria-hidden="true"> / </span>
        <Link to="/products" className="transition-colors hover:text-txt-1">
          商品
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-txt-2">{product.name}</span>
      </nav>

      {isDemo && (
        <p className="mt-4 rounded-xl border px-4 py-2.5 text-[13px] text-gold-soft" style={{ borderColor: 'var(--glass-border)' }}>
          伺服器暫時連唔到，你而家睇緊示範款，落單功能暫停。
        </p>
      )}

      <div className="mt-8 grid grid-cols-1 gap-10 md:grid-cols-2 md:gap-14">
        {/* 左：大圖 */}
        <div className="relative overflow-hidden rounded-3xl border" style={{ borderColor: 'var(--glass-border)' }}>
          {discounted && (
            <span className="absolute left-4 top-4 z-10 rounded-full bg-pink px-3 py-1 text-[12px] font-bold text-space-1">
              優惠中
            </span>
          )}
          {outOfStock && (
            <span className="absolute right-4 top-4 z-10 rounded-full border px-3 py-1 text-[12px] text-txt-2 backdrop-blur" style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}>
              暫時售罄
            </span>
          )}
          <img
            src={product.image}
            alt={product.name}
            className="aspect-[3/4] w-full object-cover"
            style={{ background: 'var(--space-2)' }}
          />
        </div>

        {/* 右：資訊 */}
        <div ref={infoRef} className="reveal">
          <p className="font-mono text-[12px] uppercase tracking-wider text-txt-3">
            {product.sku}
          </p>
          <h1 className="mt-2 font-serif-tc text-[32px] font-bold leading-[1.25] text-txt-1">
            {product.name}
          </h1>

          <p className="mt-4 flex items-baseline gap-3">
            <span className="font-mono text-[30px] font-medium text-pink">
              {formatHKD(effPrice)}
            </span>
            {discounted && (
              <span className="font-mono text-[16px] text-txt-3 line-through">
                {formatHKD(product.price)}
              </span>
            )}
          </p>

          {/* 尺寸 pill 選擇（後台開咗尺寸選項 + 有 sizes 時必填；閂咗就冚呢段） */}
          {needSize && (
            <fieldset className="mt-7">
              <legend className="text-[14px] text-txt-2">
                尺寸
                <span className="ml-1 text-[12px] text-txt-3">（必填）</span>
              </legend>
              <div className="mt-3 flex flex-wrap gap-2.5" role="radiogroup" aria-label="選擇尺寸">
                {sizes.map((s) => {
                  const active = size === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setSize(s);
                        setSizeError(false);
                      }}
                      className="flex min-h-11 min-w-11 items-center justify-center rounded-full border font-mono text-[14px] transition-all duration-200"
                      style={{
                        borderColor: active ? 'var(--pink)' : 'var(--space-line)',
                        background: active ? 'var(--glass-bg-strong)' : 'transparent',
                        color: active ? 'var(--pink)' : 'var(--text-2)',
                        boxShadow: active ? '0 0 12px rgba(255, 77, 141, 0.35)' : 'none',
                      }}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              {sizeError && (
                <p className="mt-2.5 flex items-center gap-1.5 text-[13px] text-pink-soft" role="alert">
                  <span className="inline-block h-2 w-2 rotate-45" style={{ background: 'var(--gold)' }} aria-hidden="true" />
                  請揀返個尺寸先
                </p>
              )}
            </fieldset>
          )}

          {/* 數量 stepper */}
          <div className="mt-7">
            <p className="text-[14px] text-txt-2">數量</p>
            <div
              className="mt-3 inline-flex items-center rounded-full border"
              style={{ borderColor: 'var(--space-line)' }}
            >
              <button
                type="button"
                onClick={() => setQty((q) => Math.max(1, q - 1))}
                disabled={qty <= 1}
                aria-label="減少數量"
                className="flex min-h-11 min-w-11 items-center justify-center text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
              >
                <Minus size={16} aria-hidden="true" />
              </button>
              <span className="min-w-10 text-center font-mono text-[16px] text-txt-1" aria-live="polite">
                {qty}
              </span>
              <button
                type="button"
                onClick={() => setQty((q) => Math.min(Math.max(product.stock, 1), q + 1))}
                disabled={outOfStock || qty >= product.stock}
                aria-label="增加數量"
                className="flex min-h-11 min-w-11 items-center justify-center text-txt-2 transition-colors hover:text-txt-1 disabled:opacity-40"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
            <span className="ml-3 font-mono text-[12px] text-txt-3">
              存貨 {product.stock} 件
            </span>
          </div>

          {/* CTA 行：加入購物車 + 心心 */}
          <div className="mt-8 flex items-center gap-3">
            <button
              type="button"
              onClick={handleAdd}
              disabled={addCart.isPending || outOfStock || isDemo}
              className="btn btn-primary flex-1 !py-3.5 text-[16px] font-bold disabled:opacity-50"
            >
              {addCart.isPending ? (
                <WishingStar size={18} />
              ) : (
                <ShoppingBag size={18} aria-hidden="true" />
              )}
              {outOfStock ? '暫時售罄' : '加入購物車'}
            </button>
            <button
              type="button"
              onClick={() => setWished((w) => !w)}
              aria-pressed={wished}
              aria-label={wished ? '移出願望清單' : '加入願望清單'}
              className="btn btn-secondary !h-[52px] !w-[52px] !rounded-full !p-0"
            >
              <Heart
                size={20}
                aria-hidden="true"
                className="transition-all duration-200"
                style={{
                  fill: wished ? 'var(--pink)' : 'transparent',
                  color: wished ? 'var(--pink)' : 'var(--text-2)',
                }}
              />
            </button>
          </div>

          {/* 描述 */}
          {product.description && (
            <div className="mt-9 border-t pt-7" style={{ borderColor: 'var(--space-line)' }}>
              <h2 className="text-[15px] font-bold text-txt-1">商品描述</h2>
              <p className="mt-3 whitespace-pre-line text-[14px] leading-[1.9] text-txt-2">
                {product.description}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 相關商品 */}
      <div className="mt-20">
        <h2 className="font-serif-tc text-[24px] font-bold text-txt-1">你可能都鍾意</h2>
        <div ref={gridRef} className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4 md:gap-6">
          {related.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full border px-6 py-3 text-[14px] text-txt-1 backdrop-blur-xl"
          style={{
            borderColor: 'var(--glass-border)',
            background: 'var(--glass-bg-strong)',
            animation: 'mobile-nav-in 300ms var(--ease-expo) both',
          }}
        >
          {toast}
        </div>
      )}
    </section>
  );
}

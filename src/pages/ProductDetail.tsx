import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, MessageCircle, Minus, Plus, ShoppingBag } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import DuotoneImage from '@/components/DuotoneImage';
import ProductCard from '@/components/ProductCard';
import WishingStar from '@/components/shop/WishingStar';
import AddedToast from '@/components/shop/AddedToast';
import {
  formatHKD,
  formatListedDate,
  isNewWithin7Days,
  parseSizes,
  toCardProduct,
} from '@/components/shop/shop-utils';
import type { ShopProduct } from '@/components/shop/shop-utils';
import { useRevealDep } from '@/components/shop/useRevealDep';
import { cn } from '@/lib/utils';

/**
 * 商品詳情 /products/:id（design-system.md §P3）
 * - trpc.products.byId.useQuery({ id }) 攞真數據
 * - 左 55%：主圖 duotone → 進入視窗上色（DuotoneImage reveal，全站 signature）
 * - 右 45%：品名 Serif TC 32px → 貨號/上架日期 → DM Mono 價錢（詳情尺寸，有折扣刪除線原價）
 *   → 尺寸 pill 選擇（有 sizes 時必填）→ 數量步進器（± 玻璃圓鈕）
 *   → Primary「加入購物車」全寬 → WhatsApp 鈕「問 Glo Glo 著身效果」全寬
 * - 加入購物車：未登入 → navigate /login（state.from 記返邊度嚟）；
 *   已登入 → trpc.cart.add.useMutation，成功後細玻璃提示 + 導購物車連結
 * - 底部：商品故事（Serif TC 引文式）+ 相關商品 4 卡（list 前 4 件排除自己）
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85200000000';

export default function ProductDetail() {
  const { id } = useParams();
  const productId = Number(id);
  const validId = Number.isInteger(productId) && productId > 0;

  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const productQuery = trpc.products.byId.useQuery(
    { id: productId },
    { enabled: validId, retry: false },
  );
  // 相關商品：同 list 排序（listedDate desc），排除自己，取前 4 件
  const relatedQuery = trpc.products.list.useQuery(undefined, { staleTime: 5 * 60_000 });

  const product = productQuery.data as ShopProduct | undefined;
  const sizes = useMemo(() => parseSizes(product?.sizes), [product?.sizes]);
  const needSize = sizes.length > 0;

  const [size, setSize] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const [sizeHint, setSizeHint] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const addMutation = trpc.cart.add.useMutation({
    onSuccess: async () => {
      setErrorMsg(null);
      setAdded(true);
      await utils.cart.list.invalidate();
    },
    onError: (err) => setErrorMsg(err.message),
  });

  const related = useMemo<ShopProduct[]>(() => {
    const list = (relatedQuery.data ?? []) as ShopProduct[];
    return list.filter((p) => p.id !== productId).slice(0, 4);
  }, [relatedQuery.data, productId]);
  const relatedRef = useRevealDep<HTMLDivElement>([related.map((p) => p.id).join(',')]);

  const onAdd = () => {
    if (!product) return;
    if (needSize && !size) {
      setSizeHint(true);
      return;
    }
    if (!user) {
      // 未登入：導去登入頁，state 記返邊度嚟
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    addMutation.mutate({
      productId: product.id,
      size: size ?? undefined,
      quantity,
    });
  };

  /* ---------- Loading：許願星（§3.7） ---------- */
  if (productQuery.isLoading) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center">
        <WishingStar size={48} label="許願星載入中…" />
      </section>
    );
  }

  /* ---------- 搵唔到 / 錯誤 ---------- */
  if (!validId || productQuery.isError || !product) {
    return (
      <section className="mx-auto flex min-h-[60vh] max-w-[1280px] flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="script text-3xl">lost in the stars</p>
        <h1 className="font-serif-tc text-2xl font-bold text-txt-1 md:text-3xl">搵唔到呢件商品</h1>
        <p className="max-w-sm text-sm text-txt-3">
          {productQuery.error?.message ?? '商品可能已經下架，去商品頁睇下其他新貨啦。'}
        </p>
        <Link to="/products" className="btn btn-secondary mt-2 !py-2.5 text-sm">
          <ArrowLeft size={16} aria-hidden="true" />
          返回全部商品
        </Link>
      </section>
    );
  }

  const discounted = product.discountPrice !== null && product.discountPrice < product.price;
  const soldOut = product.stock <= 0;
  const isNew = isNewWithin7Days(product.listedDate);
  const waText = encodeURIComponent(`Hi Glo Glo！我想問下 ${product.name}（貨號 ${product.sku}）嘅著身效果 ✦`);

  return (
    <section className="mx-auto max-w-[1280px] px-5 py-10 md:px-8 md:py-16 xl:px-12">
      {/* 返回連結 */}
      <Link
        to="/products"
        className="inline-flex items-center gap-2 text-sm text-txt-3 transition-colors hover:text-pink-soft"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        返回全部商品
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-[55fr_45fr] lg:gap-12">
        {/* 左 55%：主圖（duotone → 進入視窗上色） */}
        <div className="relative">
          <DuotoneImage
            reveal
            src={product.image}
            alt={product.name}
            wrapperClassName="rounded-[20px] border"
            className="aspect-[4/5] w-full object-cover"
          />
          {/* Badge 左上（§4.4：New = gold 實心深字；斷貨 = space-4 底 text-3） */}
          <div className="absolute left-4 top-4 flex flex-col items-start gap-2">
            {isNew && !soldOut && (
              <span
                className="rounded-full bg-gold px-3 py-1 font-mono text-xs font-medium text-space-1"
                aria-label="新上架商品"
              >
                New
              </span>
            )}
            {soldOut && (
              <span
                className="rounded-full bg-space-4 px-3 py-1 font-mono text-xs text-txt-3"
                aria-label="已斷貨"
              >
                斷貨
              </span>
            )}
          </div>
        </div>

        {/* 右 45%：資料欄 */}
        <div>
          <h1 className="font-serif-tc text-[26px] font-bold leading-[1.2] text-txt-1 md:text-[32px]">
            {product.name}
          </h1>
          <p className="mt-3 font-mono text-sm text-txt-3">
            貨號 {product.sku} · {formatListedDate(product.listedDate)} 上架
          </p>

          {/* 價錢（§2.3 詳情：DM Mono 32px --pink；原價刪除線 --text-3） */}
          <p className="mt-4 flex items-baseline gap-3 font-mono text-[26px] font-medium leading-[1.2] text-pink md:text-[32px]">
            {formatHKD(product.discountPrice ?? product.price)}
            {discounted && (
              <span className="text-lg text-txt-3 line-through">{formatHKD(product.price)}</span>
            )}
          </p>

          <hr className="my-6 border-0 border-t" style={{ borderColor: 'var(--space-line)' }} />

          {/* 尺寸 pill 選擇（有 sizes 時必填） */}
          {needSize && (
            <fieldset>
              <legend className="text-sm text-txt-2">
                尺寸 <span className="text-txt-3">（必填）</span>
              </legend>
              <div className="mt-3 flex flex-wrap gap-2">
                {sizes.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSize(s);
                      setSizeHint(false);
                    }}
                    aria-pressed={size === s}
                    className={cn(
                      'min-h-11 rounded-full border px-5 font-mono text-sm transition-colors duration-200',
                      size === s
                        ? 'border-pink bg-pink font-medium text-space-1'
                        : 'text-txt-1 hover:border-pink-soft',
                    )}
                    style={size === s ? undefined : { borderColor: 'var(--glass-border)' }}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {sizeHint && !size && (
                <p className="mt-2 text-[13px] text-pink-soft">請先揀尺寸先好加入購物車 ✦</p>
              )}
            </fieldset>
          )}

          {/* 數量步進器（± 玻璃圓鈕） */}
          <div className="mt-6">
            <p className="text-sm text-txt-2">數量</p>
            <div className="mt-3 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                disabled={quantity <= 1}
                aria-label="減少數量"
                className="btn btn-secondary !h-11 !w-11 !rounded-full !p-0 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Minus size={16} aria-hidden="true" />
              </button>
              <span
                className="w-10 text-center font-mono text-lg text-txt-1"
                aria-live="polite"
                aria-label={`數量 ${quantity}`}
              >
                {quantity}
              </span>
              <button
                type="button"
                onClick={() => setQuantity((q) => q + 1)}
                aria-label="增加數量"
                className="btn btn-secondary !h-11 !w-11 !rounded-full !p-0"
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* CTA 列：Primary 加入購物車 + WhatsApp 問款（全寬，同等視覺重量 §P3） */}
          <div className="mt-8 space-y-3">
            <button
              type="button"
              onClick={onAdd}
              disabled={soldOut || addMutation.isPending}
              className="btn btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {addMutation.isPending ? (
                /* §3.7 局部 loading：按鈕文字消失，原位 16px 金色四角星旋轉閃爍 */
                <WishingStar size={16} />
              ) : (
                <>
                  <ShoppingBag size={18} aria-hidden="true" />
                  {soldOut ? '已斷貨' : user ? '加入購物車' : '登入後加入購物車'}
                </>
              )}
            </button>
            <a
              href={`${WHATSAPP_URL}?text=${waText}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp w-full"
            >
              <MessageCircle size={18} aria-hidden="true" />
              問 Glo Glo 著身效果
            </a>
            {errorMsg && (
              <p role="alert" className="text-[13px] text-pink-soft">
                {errorMsg}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 商品故事（Serif TC 引文式排版 §P3） */}
      {product.description && (
        <section className="mt-16 md:mt-24" aria-label="商品故事">
          <blockquote
            className="max-w-3xl border-l-2 pl-6 font-serif-tc text-lg leading-relaxed text-txt-2 md:text-xl"
            style={{ borderColor: 'var(--pink)' }}
          >
            {product.description}
          </blockquote>
        </section>
      )}

      {/* 相關商品：同 list 前 4 件，排除自己 */}
      {related.length > 0 && (
        <section className="mt-16 md:mt-24" aria-label="相關商品">
          <div ref={relatedRef}>
            <h2 className="reveal font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
              你可能都會鍾意
            </h2>
            <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 md:gap-6 xl:grid-cols-4">
              {related.map((p, i) => (
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
        </section>
      )}

      {/* 加入成功：細玻璃提示 + 導購物車連結 */}
      <AddedToast show={added} productName={product.name} onClose={() => setAdded(false)} />
    </section>
  );
}

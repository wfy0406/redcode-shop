import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ChevronRight, MessageCircle } from 'lucide-react';
import DuotoneImage from '@/components/DuotoneImage';
import ProductCard from '@/components/ProductCard';
import { useCart } from '@/hooks/useCart';
import { useReveal } from '@/hooks/useReveal';
import { trpc } from '@/providers/trpc';
import { demoShopProducts } from '@/components/shop/shop-utils';

/**
 * RedCode 商品詳情（/products/:id）
 * - 左圖右資訊兩欄；主圖 duotone→全彩進場
 * - 尺寸 pill、價錢大字 DM Mono、CTA 主按鈕 + WhatsApp 副按鈕
 * - 「你可能都鍾意」相關商品 2–4 張
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85254835368';

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const productId = Number(id);
  const validId = Number.isFinite(productId) && productId > 0;

  // 後端連唔到（純前端預覽）時 fallback 用內建示範商品
  const productQuery = trpc.products.byId.useQuery(
    { id: productId },
    { enabled: validId, retry: false },
  );
  const allQuery = trpc.products.list.useQuery({}, { retry: false });

  const product =
    productQuery.data ?? (productQuery.isError ? demoShopProducts().find((d) => d.id === productId) : undefined);
  const allProducts =
    allQuery.data ?? (allQuery.isError ? demoShopProducts() : undefined);

  const related = useMemo(() => {
    if (!product || !allProducts) return [];
    return allProducts
      .filter((item) => item.id !== product.id && item.isActive)
      .slice(0, 4)
      .map((item) => ({
        id: String(item.id),
        name: item.name,
        sku: item.sku,
        price: item.price,
        discountPrice: item.discountPrice ?? undefined,
        sizes: item.sizes ? item.sizes.split(',').map((s) => s.trim()) : undefined,
        listedAt: new Date(item.listedDate).toISOString().slice(0, 10),
        image: item.image,
        soldOut: item.stock <= 0,
      }));
  }, [product, allProducts]);

  const [size, setSize] = useState<string | undefined>(undefined);
  const [added, setAdded] = useState(false);
  const { addToCart } = useCart();
  const infoRef = useReveal<HTMLDivElement>();
  const relatedRef = useReveal<HTMLDivElement>();

  if (!validId || !product) {
    return (
      <div className="mx-auto max-w-[1280px] px-5 py-32 text-center md:px-8">
        <p className="font-serif-tc text-2xl font-semibold text-txt-1">搵唔到呢件商品</p>
        <Link
          to="/products"
          className="mt-6 inline-block border-b text-sm font-medium text-pink-soft transition-colors hover:text-pink-tint"
          style={{ borderColor: 'var(--pink)' }}
        >
          返去商品一覽 →
        </Link>
      </div>
    );
  }

  const sizeOptions = product.sizes
    ? product.sizes.split(',').map((option) => option.trim())
    : [];
  const requiresSize = sizeOptions.length > 0;
  const canAdd = product.stock > 0 && (!requiresSize || size !== undefined);
  const effectivePrice = product.discountPrice ?? product.price;

  const onAdd = () => {
    if (!canAdd) return;
    addToCart(product.id, size, 1);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1800);
  };

  const waText = encodeURIComponent(
    `Glo Glo 你好！想問下 ${product.name}（${product.sku}）著身效果`,
  );

  return (
    <div>
      {/* 麵包屑 */}
      <nav aria-label="麵包屑" className="mx-auto max-w-[1280px] px-5 pt-6 md:px-8 xl:px-12">
        <ol className="flex items-center gap-1.5 text-sm text-txt-3">
          <li>
            <Link to="/" className="transition-colors hover:text-pink-tint">
              首頁
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight size={14} />
          </li>
          <li>
            <Link to="/products" className="transition-colors hover:text-pink-tint">
              商品
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight size={14} />
          </li>
          <li aria-current="page" className="text-txt-1">
            {product.name}
          </li>
        </ol>
      </nav>

      <section className="mx-auto mt-6 grid max-w-[1280px] gap-10 px-5 md:px-8 lg:grid-cols-2 xl:px-12">
        {/* 左：主圖（duotone→全彩進場） */}
        <DuotoneImage
          reveal
          src={product.image}
          alt={product.name}
          wrapperClassName="rounded-[20px] border"
          className="aspect-[4/5] w-full object-cover"
        />

        {/* 右：資訊 */}
        <div ref={infoRef} className="reveal">
          <p className="font-mono text-xs tracking-[0.2em] text-txt-3">{product.sku}</p>
          <h1 className="mt-2 font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
            {product.name}
          </h1>
          <div className="mt-4 flex items-baseline gap-3">
            <p className="font-mono text-4xl font-medium text-starlight">
              HK${effectivePrice}
            </p>
            {product.discountPrice != null && (
              <p className="font-mono text-lg text-txt-3 line-through">HK${product.price}</p>
            )}
          </div>

          {product.description ? (
            <p className="mt-5 max-w-md text-[15px] leading-[1.75] text-txt-2">
              {product.description}
            </p>
          ) : null}

          {/* 尺寸 pill */}
          {requiresSize && (
            <fieldset className="mt-7">
              <legend className="text-sm font-medium text-txt-2">
                尺寸{size ? `：${size}` : ''}
              </legend>
              <div className="mt-3 flex flex-wrap gap-3">
                {sizeOptions.map((option) => {
                  const active = size === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setSize(option)}
                      aria-pressed={active}
                      className="h-11 min-w-11 rounded-full border px-4 font-mono text-sm transition-all duration-200"
                      style={{
                        borderColor: active ? 'var(--pink)' : 'var(--glass-border)',
                        background: active ? 'var(--pink)' : 'transparent',
                        color: active ? 'var(--space-1)' : 'var(--txt-1)',
                      }}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          {/* CTA 行 */}
          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={onAdd}
              disabled={!canAdd}
              className="btn btn-primary"
              style={!canAdd ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            >
              {product.stock <= 0
                ? '已售完'
                : added
                  ? '已加入 ✓'
                  : requiresSize && size === undefined
                    ? '請先揀尺寸'
                    : '加入購物車'}
            </button>
            <a
              href={`${WHATSAPP_URL}?text=${waText}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-whatsapp"
            >
              <MessageCircle size={18} aria-hidden="true" />
              即刻WHATSAPP我地！
            </a>
          </div>

          {/* 服務說明 */}
          <ul className="mt-8 space-y-2 border-t pt-6 text-sm leading-[1.6] text-txt-3" style={{ borderColor: 'var(--space-line)' }}>
            <li>· 買滿 3 件再包郵（順豐到付安排請 WhatsApp 查詢）</li>
            <li>· 即日入數全單減 $15</li>
            <li>· 部份直播間限定款，售完即止</li>
          </ul>
        </div>
      </section>

      {/* 你可能都鍾意 */}
      {related.length > 0 && (
        <section className="mx-auto mt-16 max-w-[1280px] px-5 md:mt-24 md:px-8 xl:px-12">
          <div ref={relatedRef} className="reveal">
            <h2 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1 md:text-[32px]">
              <span className="font-display-en mr-3 text-purple-text">You May Also Like</span>
              你可能都鍾意
            </h2>
            <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4 md:gap-6">
              {related.map((item, i) => (
                <div
                  key={item.id}
                  className="reveal"
                  style={{ transitionDelay: `${Math.min(i * 80, 400)}ms` }}
                >
                  <ProductCard product={item} />
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

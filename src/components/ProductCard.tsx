import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Check, Heart, ShoppingBag } from 'lucide-react';
import type { Product } from '@/data/products';
import { formatListedAt, formatPrice, isNewArrival } from '@/data/products';
import { productCategoryLabel } from '@contracts/types';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

/**
 * RedCode 設計系統 §4.4 —— 商品卡
 * space-2 底 + 圓角 16px + 1px glass-border（唔用陰影）；
 * 圖 4:5 duotone（hover 上色）；badge 左上（直播中/New/斷貨）；
 * 心心願望鈕（§3.5 心跳 + 灑金星）；hover 浮出「快速加入購物車」玻璃鈕。
 */

interface ProductCardProps {
  product: Product;
  className?: string;
}

function sprinkleStars(container: HTMLElement) {
  // §3.5：灑出 6 粒金色小星向外飛 400ms 淡出
  for (let i = 0; i < 6; i++) {
    const star = document.createElement('span');
    const angle = (i / 6) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 14 + Math.random() * 10;
    star.style.cssText = `
      position: absolute;
      left: 50%;
      top: 50%;
      width: 3px;
      height: 3px;
      border-radius: 9999px;
      background: var(--gold);
      pointer-events: none;
      transition: transform 400ms var(--ease-expo), opacity 400ms var(--ease-expo);
    `;
    container.appendChild(star);
    requestAnimationFrame(() => {
      star.style.transform = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;
      star.style.opacity = '0';
    });
    window.setTimeout(() => star.remove(), 450);
  }
}

export default function ProductCard({ product, className }: ProductCardProps) {
  const [wished, setWished] = useState(false);
  const heartRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [added, setAdded] = useState(false);
  const [addFailed, setAddFailed] = useState(false);
  const addMutation = trpc.cart.add.useMutation({
    onSuccess: async () => {
      setAdded(true);
      window.setTimeout(() => setAdded(false), 2000);
      await utils.cart.list.invalidate();
    },
    onError: () => {
      setAddFailed(true);
      window.setTimeout(() => setAddFailed(false), 2000);
    },
  });
  const discounted = product.discountPrice !== undefined && product.discountPrice < product.price;
  const showNew = !product.live && !product.soldOut && isNewArrival(product.listedAt);

  const onWish = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !wished;
    setWished(next);
    if (next && heartRef.current) {
      heartRef.current.animate(
        [
          { transform: 'scale(1)' },
          { transform: 'scale(1.25)' },
          { transform: 'scale(1)' },
          { transform: 'scale(1.18)' },
          { transform: 'scale(1)' },
        ],
        { duration: 400, easing: 'ease-out' },
      );
      sprinkleStars(heartRef.current);
    }
  };

  const onQuickAdd = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // 要揀尺寸嘅商品 → 去詳情頁揀；demo 商品（非數字 id）→ 去詳情頁
    const productId = Number(product.id);
    if ((product.sizes && product.sizes.length > 0) || !Number.isInteger(productId)) {
      navigate(`/products/${product.id}`);
      return;
    }
    // 未登入 → 去登入頁（記返邊度嚟）
    if (!user) {
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    if (addMutation.isPending || added) return;
    addMutation.mutate({ productId, quantity: 1 });
  };

  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-2xl border bg-space-2 transition-[border-color,transform] duration-200',
        'hover:-translate-y-1 hover:border-pink',
        className,
      )}
      style={{ borderColor: 'var(--glass-border)', transitionTimingFunction: 'var(--ease-expo)' }}
    >
      <Link to={`/products/${product.id}`} className="block" aria-label={product.name}>
        {/* 圖區 4:5 + duotone */}
        <div className="relative aspect-[4/5] overflow-hidden">
          <div className="duotone h-full w-full">
            <img
              src={product.image}
              alt={product.name}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          </div>

          {/* Badge 左上（§4.4） */}
          <div className="absolute left-3 top-3 flex flex-col items-start gap-2">
            {product.live && (
              <span
                className="flex items-center gap-1.5 rounded-full bg-pink px-3 py-1 font-mono text-xs font-medium text-space-1"
                aria-label="直播中商品"
                aria-live="off"
              >
                <span className="live-dot !h-1.5 !w-1.5 bg-space-1" aria-hidden="true" />
                直播中
              </span>
            )}
            {showNew && (
              <span
                className="rounded-full bg-gold px-3 py-1 font-mono text-xs font-medium text-space-1"
                aria-label="新上架商品"
              >
                New
              </span>
            )}
            {product.soldOut && (
              <span
                className="rounded-full bg-space-4 px-3 py-1 font-mono text-xs text-txt-3"
                aria-label="已斷貨"
              >
                斷貨
              </span>
            )}
            {product.category && (
              <span
                className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-lavender"
                style={{
                  borderColor: 'var(--glass-border)',
                  background: 'var(--glass-bg)',
                  backdropFilter: 'blur(6px)',
                  WebkitBackdropFilter: 'blur(6px)',
                }}
              >
                {productCategoryLabel(product.category)}
              </span>
            )}
          </div>

          {/* 心心願望鈕（玻璃圓底，hit area ≥44px） */}
          <button
            ref={heartRef}
            type="button"
            onClick={onWish}
            aria-pressed={wished}
            aria-label={wished ? `將 ${product.name} 移出願望清單` : `將 ${product.name} 加入願望清單`}
            className="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-full"
            style={{
              background: 'var(--glass-bg)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
            }}
          >
            <Heart
              size={18}
              aria-hidden="true"
              className={cn('transition-colors', wished ? 'fill-pink-soft text-pink-soft' : 'text-txt-1')}
            />
          </button>

          {/* hover 浮出「快速加入購物車」（200ms 由底部滑入） */}
          {!product.soldOut && (
            <button
              type="button"
              onClick={onQuickAdd}
              className="btn btn-secondary absolute inset-x-4 bottom-4 !py-2.5 text-sm opacity-0 translate-y-3 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100"
            >
              {added ? (
                <>
                  <Check size={16} aria-hidden="true" className="text-success" />
                  已加入購物車 ✓
                </>
              ) : addFailed ? (
                '加入失敗，請再試'
              ) : (
                <>
                  <ShoppingBag size={16} aria-hidden="true" />
                  快速加入購物車
                </>
              )}
            </button>
          )}
        </div>

        {/* 資訊區 */}
        <div className="space-y-1.5 p-4">
          <h3 className="line-clamp-2 text-[18px] font-bold leading-[1.4] text-txt-1">
            {product.name}
          </h3>
          <p className="font-mono text-xs text-txt-3">
            貨號 {product.sku} · {formatListedAt(product.listedAt)} 上架
          </p>
          <p className="flex items-baseline gap-2 font-mono text-lg font-medium leading-[1.2] text-pink">
            {formatPrice(product.discountPrice ?? product.price)}
            {discounted && (
              <span className="text-sm text-txt-3 line-through">{formatPrice(product.price)}</span>
            )}
          </p>
          {product.sizes && product.sizes.length > 0 && (
            <p className="text-[13px] text-txt-3">尺寸 {product.sizes.join(' / ')}</p>
          )}
        </div>
      </Link>
    </article>
  );
}

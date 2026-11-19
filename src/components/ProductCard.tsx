import { memo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ArrowUpRight, Check, Heart, ShoppingBag } from 'lucide-react';
import type { Product } from '@/data/products';
import { formatListedAt, formatPrice, isNewArrival } from '@/data/products';
import { productCategoryLabel } from '@contracts/types';
import { formatLiveDateLabel, liveSharePath, normalizeLiveShare } from '@/lib/liveShare';
import { saveProductReturn } from '@/lib/productReturn';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import './product-card.css';

/**
 * RedCode 設計系統 §4.4 —— 商品卡
 * space-2 底 + 圓角 16px + 1px glass-border（唔用陰影）；
 * 圖 4:5 duotone（hover 上色）；badge 左上（直播中/New/斷貨）；
 * 心心願望鈕（§3.5 心跳 + 灑金星）；hover 浮出「快速加入購物車」玻璃鈕。
 *
 * U04：有真 liveDate/liveSession 先喺卡底出場次 metadata row（editorial 細字，
 * 唔遮圖）；成 row 係主商品 anchor 嘅合法 sibling <Link> 去該場次列表，唔巢狀。
 * U01：撳主連結（普通左掣）嗰刻記低來源 URL／scrollY／productId，詳情頁返回用。
 * R03：只有列表真正首屏 LCP 候選先傳 priority（eager＋fetchPriority high），
 * 其餘卡全部維持 lazy。
 */

interface ProductCardProps {
  product: Product;
  className?: string;
  /** 示範模式（API 故障 fallback，UX P0-2）：卡面標「示範款」兼收埋快速加車（示範貨落唔到單） */
  demo?: boolean;
  /** R03：首屏 LCP 候選圖先開（eager + fetchpriority=high）；一個畫面只應有一兩張 */
  priority?: boolean;
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

function ProductCard({ product, className, demo = false, priority = false }: ProductCardProps) {
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
  // U04：真 liveDate（真實日曆日期）先出場次行；壞資料 normalizeLiveShare 回 null → 唔出
  const liveTarget = normalizeLiveShare(String(product.liveDate ?? ''), product.liveSession ?? null);

  // U01：普通左掣撳卡先入詳情先記來源；modifier／middle click（開新分頁）唔攔截唔記
  const recordReturnSource = () => {
    const pid = Number(product.id);
    if (!Number.isInteger(pid) || pid <= 0) return; // 示範卡非數字 id，唔記
    saveProductReturn({
      url: `${location.pathname}${location.search}`,
      scrollY: window.scrollY,
      productId: pid,
      ts: Date.now(),
    });
  };
  const onCardOpen = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    recordReturnSource();
  };

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
      recordReturnSource();
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
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-space-2 transition-[border-color,transform] duration-200',
        'hover:-translate-y-1 hover:border-pink',
        className,
      )}
      style={{ borderColor: 'var(--glass-border)', transitionTimingFunction: 'var(--ease-expo)' }}
    >
      <Link
        to={`/products/${product.id}`}
        className="block flex-1"
        aria-label={product.name}
        data-product-card={product.id}
        onClick={onCardOpen}
      >
        {/* 圖區 4:5 + duotone */}
        <div className="relative aspect-[4/5] overflow-hidden">
          <div className="duotone h-full w-full">
            <img
              src={product.image}
              alt={product.name}
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : undefined}
              decoding="async"
              className="h-full w-full object-cover"
            />
          </div>

          {/* Badge 左上（§4.4） */}
          <div className="absolute left-3 top-3 flex flex-col items-start gap-2">
            {demo && (
              <span
                className="rounded-full border px-3 py-1 font-mono text-xs font-medium text-gold-soft"
                style={{ borderColor: 'var(--gold)', background: 'rgba(10,6,20,0.72)' }}
              >
                示範款
              </span>
            )}
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

          {/* hover 浮出「快速加入購物車」（200ms 由底部滑入）；示範模式收埋（示範貨落唔到單） */}
          {!product.soldOut && !demo && (
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
          {/* 重點標籤（已批准先有）：桃紅細框 pill＋菱形記號（product-card.css），
              flex wrap 手機兩欄都睇到；首次渲染一次性 cascade（55ms stagger、
              transform/opacity only 冇 layout shift），reduced-motion 停用。
              放資訊區唔會遮住圖、貨號、價錢或快速加車 CTA。冇 tags 就唔出 */}
          {product.aiTags && product.aiTags.length > 0 && (
            <ul className="pc-tags" aria-label="商品重點標籤">
              {product.aiTags.map((tag, i) => (
                <li
                  key={tag}
                  className="pc-tag"
                  style={{ '--pc-tag-delay': `${Math.min(i, 7) * 55}ms` } as CSSProperties}
                >
                  {tag}
                </li>
              ))}
            </ul>
          )}
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

      {/* U04：直播場次 metadata row——主商品 anchor 嘅合法 sibling（唔准 nested <a>）。
          有真 liveDate 先出；editorial 細字 mono＋hairline 分隔，唔遮圖、唔出空徽章。
          成 row 係真連結去該日／該場商品列表，鍵盤同觸控都用到（min-height 44px）。 */}
      {liveTarget && (
        <Link
          to={liveSharePath(liveTarget)}
          className="pc-live"
          aria-label={`睇返 ${formatLiveDateLabel(liveTarget.liveDate)}${
            liveTarget.liveSession ? ` 第 ${liveTarget.liveSession} 場` : ''
          } 直播商品`}
        >
          <span className="pc-live-kicker" aria-hidden="true">
            LIVE
          </span>
          <span className="pc-live-date">{formatLiveDateLabel(liveTarget.liveDate)}</span>
          {liveTarget.liveSession && (
            <span className="pc-live-session">第 {liveTarget.liveSession} 場</span>
          )}
          <ArrowUpRight size={12} aria-hidden="true" className="pc-live-arrow" />
        </Link>
      )}
    </article>
  );
}

// perf-fix（P2-1）：列表項 memo——props 係扁平 Product object，上層 state 變唔再成排卡重 render
export default memo(ProductCard);

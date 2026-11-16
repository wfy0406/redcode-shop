import type { KeyboardEvent } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  Check,
  LoaderCircle,
  RefreshCcw,
  Sparkles,
} from 'lucide-react';
import type { GuideListItem } from '@contracts/gloGuide';
import { tryOnProductKindLabel, type TryOnProductKind } from '@contracts/tryon';
import type { TryOnProductSelection } from '@/pages/tryonSelection';
import { guidePath } from '@/components/glo-guide/guideUtils';

export type TryOnGuideProduct = {
  id: number;
  sku: string;
  name: string;
  image: string;
  photos: string[] | null;
  price: number;
  discountPrice: number | null;
  stock: number;
  tryOnKind: TryOnProductKind;
};

/** 指南負責刊期及次序；會員試穿清單負責最新資格、原圖、貨號及價錢。 */
export function joinGuideTryOnProducts(
  guide: Pick<GuideListItem, 'products'>,
  products: readonly TryOnGuideProduct[],
): TryOnGuideProduct[] {
  const byId = new Map(products.map((product) => [product.id, product]));
  return guide.products.flatMap((guideProduct) => {
    const current = byId.get(guideProduct.id);
    return current ? [current] : [];
  });
}

function money(value: number): string {
  return `HK$${Math.max(0, Math.round(value)).toLocaleString('en-HK')}`;
}

function issueDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '已發布刊期';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function galleryOf(product: TryOnGuideProduct): string[] {
  const source = product.photos?.length ? product.photos : [product.image];
  return source.filter((src): src is string => Boolean(src));
}

export default function TryOnGuideCatalog({
  guides,
  products,
  activeGuideSlug,
  onGuideChange,
  selections,
  selectionLocked,
  hasLaterLineage,
  getBlockReason,
  onSelectProduct,
  isLoading,
  error,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  guides: GuideListItem[];
  products: readonly TryOnGuideProduct[];
  activeGuideSlug: string | null;
  onGuideChange: (slug: string) => void;
  selections: TryOnProductSelection[];
  selectionLocked: boolean;
  hasLaterLineage: boolean;
  getBlockReason: (product: TryOnGuideProduct) => string | null;
  onSelectProduct: (product: TryOnGuideProduct) => void;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const activeGuide = guides.find((guide) => guide.slug === activeGuideSlug) ?? guides[0] ?? null;
  const activeProducts = activeGuide ? joinGuideTryOnProducts(activeGuide, products) : [];

  const onIssueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current < 0 || !buttons.length) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
    if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    buttons[next].focus();
    onGuideChange(guides[next].slug);
  };

  if (isLoading) {
    return (
      <div className="tryon-guide-state" role="status">
        <LoaderCircle className="tryon-spin" size={25} aria-hidden="true" />
        <p>Glo Glo 正在整理已發布刊期同商品原圖…</p>
      </div>
    );
  }

  if (error && !guides.length) {
    return (
      <div className="tryon-guide-state" role="alert">
        <BookOpen size={28} aria-hidden="true" />
        <h3>指南刊期暫時載入唔到</h3>
        <p>{error}</p>
        <button type="button" className="tryon-secondary-button" onClick={onRetry}>
          <RefreshCcw size={17} />重新載入指南
        </button>
      </div>
    );
  }

  if (!guides.length) {
    return (
      <div className="tryon-guide-state" role="status">
        <BookOpen size={28} aria-hidden="true" />
        <h3>暫時未有已發布指南</h3>
        <p>新一期通過審批並發布後，先會喺度出現；你仍可以用「全部商品」揀衫。</p>
      </div>
    );
  }

  return (
    <div className="tryon-guide-catalog">
      <div className="tryon-guide-editorial-head">
        <div>
          <p className="tryon-kicker">GLO GLO · SHOP THE EDIT</p>
          <h3>跟住指南，試出自己嘅襯法</h3>
        </div>
        <p>揀刊期，再揀單品。商品會即時加入下面嘅試穿次序，未確認生成前都唔會用額度。</p>
      </div>

      <div
        className="tryon-guide-issues"
        role="tablist"
        aria-label="選擇 Glo Glo 指南刊期"
        onKeyDown={onIssueKeyDown}
      >
        {guides.map((guide) => {
          const count = joinGuideTryOnProducts(guide, products).length;
          const active = activeGuide?.slug === guide.slug;
          return (
            <button
              type="button"
              role="tab"
              id={`tryon-guide-tab-${guide.id}`}
              aria-selected={active}
              aria-controls="tryon-guide-products"
              tabIndex={active ? 0 : -1}
              data-active={active}
              key={guide.id}
              onClick={() => onGuideChange(guide.slug)}
            >
              <span>{issueDate(guide.publishedAt)}</span>
              <strong>{guide.title}</strong>
              <small>{count} 件可試</small>
            </button>
          );
        })}
      </div>

      {activeGuide && (
        <section
          className="tryon-guide-issue"
          id="tryon-guide-products"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`tryon-guide-tab-${activeGuide.id}`}
        >
          <header className="tryon-guide-issue-head">
            <div>
              <p className="tryon-guide-issue-theme">{activeGuide.theme}</p>
              <h4>{activeGuide.title}</h4>
              <p>{activeGuide.excerpt}</p>
            </div>
            <span className="tryon-guide-issue-badge"><i aria-hidden="true" />GLO GLO · {issueDate(activeGuide.publishedAt)}</span>
            <Link to={guidePath(activeGuide.slug)} className="tryon-guide-article-link">
              <BookOpen size={17} aria-hidden="true" />睇呢篇指南<ArrowRight size={17} aria-hidden="true" />
            </Link>
          </header>

          {activeProducts.length ? (
            <div
              className="tryon-guide-product-rail"
              aria-label={`${activeGuide.title}可試穿單品`}
              data-fairy-target="product"
            >
              {activeProducts.map((product, index) => {
                const selectedIndex = selections.findIndex((item) => item.productId === product.id);
                const selected = selectedIndex >= 0;
                const blockReason = getBlockReason(product);
                const gallery = galleryOf(product);
                const selectedPhoto = selected ? selections[selectedIndex].photoIndex : 0;
                const image = gallery[selectedPhoto] ?? gallery[0];
                return (
                  <button
                    type="button"
                    className="tryon-guide-product"
                    data-selected={selected}
                    aria-pressed={selected}
                    disabled={Boolean(blockReason) || selectionLocked || hasLaterLineage}
                    key={product.id}
                    onClick={() => onSelectProduct(product)}
                  >
                    <span className="tryon-guide-product-visual">
                      <img src={image} alt={product.name} loading="lazy" />
                      <span className="tryon-guide-product-number">{String(index + 1).padStart(2, '0')}</span>
                      <span className="tryon-guide-product-kind">{tryOnProductKindLabel(product.tryOnKind)}</span>
                      {selected && (
                        <span className="tryon-guide-product-selected">
                          <Check size={15} aria-hidden="true" />第 {selectedIndex + 1} 次生成
                        </span>
                      )}
                    </span>
                    <span className="tryon-guide-product-copy">
                      <strong>{product.name}</strong>
                      <small>{product.sku}</small>
                      <span>{money(product.discountPrice ?? product.price)}</span>
                      <em>{blockReason ?? (selected ? '再撳移除呢件' : '揀呢件試穿')}</em>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="tryon-guide-empty-issue" role="status">
              <Sparkles size={24} aria-hidden="true" />
              <p>呢刊暫時冇可試穿單品，可能已下架或唔屬支援部位。可以揀另一刊，或者去「全部商品」。</p>
            </div>
          )}
        </section>
      )}

      {(hasNextPage || isFetchingNextPage || error) && (
        <div className="tryon-guide-more">
          {error && <p role="alert">較早刊期暫時載入唔到；現有刊期同已揀商品不受影響。</p>}
          {hasNextPage && (
            <button type="button" className="tryon-text-button" onClick={onLoadMore} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? <LoaderCircle className="tryon-spin" size={17} /> : <BookOpen size={17} />}
              {isFetchingNextPage ? '載入較早刊期中…' : error ? '重試載入較早刊期' : '載入較早刊期'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

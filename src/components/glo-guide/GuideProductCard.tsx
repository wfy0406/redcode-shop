/**
 * 指南詳情頁「文中單品」editorial 商品行（唔係普通商品卡堆砌）：
 * 序號 hairline、2:3 商品圖、名、類別、重點標籤、真價錢、商品詳情連結、加車。
 *
 * 加車鐵律（SPEC）：sizeEnabled＋多尺寸 → 撳落去係去商品頁揀尺寸嘅真連結，
 * 唔會偷偷塞預設尺寸；會員行 trpc.cart.add，訪客行 addToGuestCart。
 * 加入結果喺按鈕隔籬原位 role="status" 顯示，唔彈走客人。
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { addToGuestCart } from '@/lib/guestCart';
import { formatPrice } from '@/data/products';
import {
  guideCategoryLabel,
  guideEffectivePrice,
  guideHasDiscount,
  guideHighlightTags,
  guideLiveDateLabel,
  guideProductPath,
  resolveGuideCartAction,
} from './guideUtils';
import type { GuideProduct } from './types';

type AddState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'added' } | { kind: 'error'; message: string };

export default function GuideProductCard({
  product,
  index,
}: {
  product: GuideProduct;
  index: number;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [state, setState] = useState<AddState>({ kind: 'idle' });
  const action = resolveGuideCartAction(product);
  // 下架（isActive=false）同缺貨都唔准直接加車；商品詳情連結保留
  const delisted = !product.isActive;
  const soldOut = product.isActive && product.stock <= 0;
  const unavailable = delisted || soldOut;
  const tags = guideHighlightTags(product.aiTags);
  const liveLabel = guideLiveDateLabel(product.liveDate);

  const addCart = trpc.cart.add.useMutation({
    onSuccess: () => {
      void utils.cart.list.invalidate();
      setState({ kind: 'added' });
    },
    onError: (err) => {
      setState({ kind: 'error', message: err.message || '加入失敗，請再試' });
    },
  });

  const handleAdd = () => {
    if (state.kind === 'pending' || state.kind === 'added') return;
    if (unavailable || action.kind !== 'add') return; // 下架／缺貨／多尺寸都唔會行到加車
    if (!user) {
      // 訪客購物車（同 ProductDetail 同一套 localStorage 契約）；
      // 寫唔入（無痕／quota）要老實顯示錯誤，唔准假顯示已加入
      const ok = addToGuestCart(product.id, action.size, 1);
      setState(
        ok
          ? { kind: 'added' }
          : {
              kind: 'error',
              message: '瀏覽器儲存唔到購物車（可能開咗無痕模式），請登入會員再試。',
            },
      );
      return;
    }
    setState({ kind: 'pending' });
    addCart.mutate({ productId: product.id, size: action.size ?? undefined, quantity: 1 });
  };

  return (
    <li className="gg-product">
      <span className="gg-product-index" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <Link to={guideProductPath(product.id)} className="gg-product-thumb" tabIndex={-1} aria-hidden="true">
        <img
          src={product.image}
          alt=""
          width={400}
          height={600}
          loading="lazy"
          decoding="async"
          className="gg-product-img"
        />
      </Link>
      <div className="gg-product-info">
        <p className="gg-product-meta">
          {guideCategoryLabel(product.category)}
          {liveLabel ? `・${liveLabel} 直播${product.liveSession ? `第${product.liveSession}場` : ''}` : ''}
        </p>
        <h3 className="gg-product-name">
          <Link to={guideProductPath(product.id)}>{product.name}</Link>
        </h3>
        {tags.length > 0 && (
          <ul className="gg-product-tags" aria-label="重點標籤">
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        )}
        <p className="gg-product-price">
          <strong>{formatPrice(guideEffectivePrice(product))}</strong>
          {guideHasDiscount(product) && <s>{formatPrice(product.price)}</s>}
        </p>
        <div className="gg-product-actions">
          {unavailable ? (
            <span className="gg-product-soldout" role="status">
              {delisted ? '已下架' : '暫時缺貨'}
            </span>
          ) : action.kind === 'navigate' ? (
            // 多尺寸：真連結去商品頁揀尺寸，唔准偷偷加預設尺寸
            <Link to={action.to} className="gg-product-cta">
              去商品頁揀尺寸
            </Link>
          ) : (
            <button
              type="button"
              className="gg-product-cta"
              onClick={handleAdd}
              disabled={state.kind === 'pending' || state.kind === 'added'}
            >
              {state.kind === 'pending'
                ? '加入中…'
                : state.kind === 'added'
                  ? '已加入購物車'
                  : '加入購物車'}
            </button>
          )}
          <Link to={guideProductPath(product.id)} className="gg-product-detail-link">
            商品詳情
          </Link>
        </div>
        {/* 原位回饋：成功／失敗都喺按鈕下面講清楚，螢幕閱讀器都收得到 */}
        {state.kind === 'added' && (
          <p role="status" className="gg-product-feedback gg-product-feedback--ok">
            已加入購物車，可以繼續睇文或去購物車結帳。
          </p>
        )}
        {state.kind === 'error' && (
          <p role="status" className="gg-product-feedback gg-product-feedback--err">
            {state.message}
          </p>
        )}
      </div>
    </li>
  );
}

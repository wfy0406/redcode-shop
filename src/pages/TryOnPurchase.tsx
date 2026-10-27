import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Check, LoaderCircle, ShoppingBag, TicketPercent, Truck, Wallet, X } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../api/router';
import type { TryOnPurchaseItem } from '@contracts/purchase';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { parseSizes } from '@/components/shop/shop-utils';
import { emitTryOnGuideAction } from '@/components/globalFairyGuide';
import {
  readTryOnAddedItems,
  reconcileTryOnAddedItems,
  replaceTryOnAddedItems,
  saveTryOnAddedItems,
  saveTryOnCheckoutDraft,
  shouldReconcileTryOnAddedItems,
  type TryOnCheckoutDraftItem,
} from './tryonPurchase';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TryOnJob = RouterOutputs['tryon']['getJob'];
type CurrentProduct = RouterOutputs['products']['list'][number];
type BusyAction = 'all' | 'buy' | number | null;

function money(value: number): string {
  return `HK$${Math.max(0, Math.round(value)).toLocaleString('en-HK')}`;
}

function needsSize(product: CurrentProduct): boolean {
  return product.sizeEnabled && parseSizes(product.sizes).length > 0;
}

export default function TryOnPurchase({ job }: { job: TryOnJob }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const productsQuery = trpc.products.list.useQuery(undefined, {
    enabled: Boolean(user),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const addMany = trpc.cart.addMany.useMutation();
  const promoValidate = trpc.promo.validate.useMutation();
  const actionLockRef = useRef(false);

  const completedItems = useMemo(
    () => job.lookItems
      .filter((item) => item.status === 'completed' && item.stepNumber <= job.stepNumber)
      .sort((a, b) => a.stepNumber - b.stepNumber || a.id - b.id),
    [job.lookItems, job.stepNumber],
  );
  const [selectedIds, setSelectedIds] = useState<number[]>(() => completedItems.map((item) => item.productId));
  const [selectedSizes, setSelectedSizes] = useState<Record<number, string>>({});
  const [addedItems, setAddedItems] = useState<TryOnCheckoutDraftItem[]>([]);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [useWallet, setUseWallet] = useState(false);

  useEffect(() => {
    setAddedItems(user ? readTryOnAddedItems(window.sessionStorage, user.id, job.lookId) : []);
  }, [user, job.lookId]);

  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: Boolean(user) && addedItems.length > 0,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });
  // Navbar 可能早已快取 cart.list=[]；未收到呢個 hook mount 後嘅新鮮回應前，
  // 絕唔可以用舊空車清走 addMany 成功後嘅「已加車」紀錄。
  const cartReconciliationReady = shouldReconcileTryOnAddedItems(addedItems.length, {
    hasData: cartQuery.data !== undefined,
    isFetching: cartQuery.isFetching,
    isError: cartQuery.isError,
    isFetchedAfterMount: cartQuery.isFetchedAfterMount,
  });

  useEffect(() => {
    if (!user || !cartQuery.data || !cartReconciliationReady || addedItems.length === 0) return;
    const reconciled = reconcileTryOnAddedItems(addedItems, cartQuery.data);
    const changed = reconciled.length !== addedItems.length || reconciled.some((item, index) =>
      item.productId !== addedItems[index]?.productId || item.size !== addedItems[index]?.size);
    if (!changed) return;
    setAddedItems(reconciled);
    replaceTryOnAddedItems(window.sessionStorage, user.id, job.lookId, reconciled);
  }, [user, cartQuery.data, cartReconciliationReady, addedItems, job.lookId]);

  const addedIds = useMemo(() => addedItems.map((item) => item.productId), [addedItems]);

  const productMap = useMemo(
    () => new Map((productsQuery.data ?? []).map((product) => [product.id, product])),
    [productsQuery.data],
  );
  const rows = selectedIds.flatMap((productId) => {
    const lookItem = completedItems.find((item) => item.productId === productId);
    return lookItem ? [{ lookItem, product: productMap.get(productId) }] : [];
  });
  const remainingIds = selectedIds.filter((productId) => !addedIds.includes(productId));
  const remainingRows = rows.filter(({ lookItem }) => remainingIds.includes(lookItem.productId));
  // 小計同「立即購買」都只用未加車商品；已下架時唔再將生成時快照價混入小計。
  const remainingSubtotal = remainingRows.some(({ product }) => !product)
    ? null
    : remainingRows.reduce(
        (sum, { product }) => sum + (product ? (product.discountPrice ?? product.price) : 0),
        0,
      );

  // 未揀齊有效尺寸／有售罄或下架商品時唔送報價；購買掣仍會用最新商品資料再驗一次。
  const quoteItems: TryOnPurchaseItem[] = [];
  for (const productId of remainingIds) {
    const product = productMap.get(productId);
    if (!product || product.stock <= 0) continue;
    const options = parseSizes(product.sizes);
    const requireSize = product.sizeEnabled && options.length > 0;
    const size = selectedSizes[productId]?.trim() || undefined;
    if (requireSize && (!size || !options.includes(size))) continue;
    quoteItems.push({ productId, size: requireSize ? size : undefined, quantity: 1 });
  }
  const quoteReady = remainingIds.length > 0 && quoteItems.length === remainingIds.length;
  const quoteQuery = trpc.vip.checkoutQuote.useQuery(
    {
      // 面板先用香港送貨上門做預覽；地區／自取方式在結帳頁改動後會即時重算。
      region: 'HK',
      deliveryMethod: 'address',
      couponCode: appliedPromo ?? undefined,
      useWallet,
      items: quoteReady ? quoteItems : undefined,
    },
    {
      enabled: Boolean(user) && quoteReady,
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
  const quote = quoteQuery.data;
  const walletBalance = quote?.walletBalance ?? 0;
  useEffect(() => {
    if (quote && quote.walletBalance <= 0 && useWallet) setUseWallet(false);
  }, [quote, useWallet]);

  const displaySubtotal = quote ? quote.subtotalCents / 100 : remainingSubtotal;
  const vipDiscount = quote ? quote.vipDiscountCents / 100 : 0;
  const couponDiscount = quote ? quote.couponDiscountCents / 100 : 0;

  const applyPromo = async () => {
    const code = promoInput.trim().toUpperCase();
    if (!code || promoValidate.isPending) return;
    if (!quote || !quoteReady || quoteQuery.isFetching) {
      setPromoError('請先揀齊尺寸，等目前售價及 VIP 報價載入後再使用優惠碼');
      return;
    }
    setPromoError(null);
    try {
      // 與 checkoutQuote／orders.create 一致：優惠碼以 VIP 折後價做基數。
      const couponBase = Math.max(1, Math.round((quote.subtotalCents - quote.vipDiscountCents) / 100));
      const result = await promoValidate.mutateAsync({ code, subtotal: couponBase });
      setAppliedPromo(result.code);
      setPromoInput('');
    } catch (cause) {
      setPromoError(cause instanceof Error ? cause.message : '優惠碼用唔到，請再試一次');
    }
  };

  async function validateItems(productIds: readonly number[]): Promise<TryOnPurchaseItem[]> {
    if (!productIds.length) throw new Error('請先揀最少一件商品');
    const refreshed = await productsQuery.refetch();
    if (refreshed.error || !refreshed.data) {
      throw new Error('目前商品資料未能更新，請檢查網絡後再試；未有用舊價錢提交');
    }
    const freshById = new Map(refreshed.data.map((product) => [product.id, product]));
    return productIds.map((productId) => {
      const snapshot = completedItems.find((item) => item.productId === productId);
      const product = freshById.get(productId);
      if (!product) {
        throw new Error(`《${snapshot?.productName ?? `商品 #${productId}`}》已下架或暫時未能購買，請先移出今次清單`);
      }
      if (product.stock <= 0) {
        throw new Error(`《${product.name}》暫時售罄，請先移出今次清單`);
      }
      const options = parseSizes(product.sizes);
      const size = selectedSizes[productId]?.trim() || null;
      if (product.sizeEnabled && options.length > 0 && (!size || !options.includes(size))) {
        throw new Error(`請先為《${product.name}》揀返有效尺寸；AI 試穿唔代表尺碼`);
      }
      return {
        productId,
        size: product.sizeEnabled && options.length > 0 ? size ?? undefined : undefined,
        quantity: 1,
      };
    });
  }

  async function runLocked(action: Exclude<BusyAction, null>, task: () => Promise<void>): Promise<void> {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setBusy(action);
    setError(null);
    setMessage(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未能完成，請再試一次');
    } finally {
      actionLockRef.current = false;
      setBusy(null);
    }
  }

  const addToCart = (productIds: readonly number[], action: Exclude<BusyAction, null>) =>
    runLocked(action, async () => {
      const items = await validateItems(productIds);
      if (!user) throw new Error('請先登入，再繼續購買');
      await addMany.mutateAsync({ items });
      const persisted = saveTryOnAddedItems(window.sessionStorage, user.id, job.lookId, items);
      setAddedItems(persisted);
      await utils.cart.list.invalidate();
      // 小精靈導覽：addMany 成功＋added record 已更新先記「已購買」；失敗行 catch 唔記（唔准假進度）
      emitTryOnGuideAction('purchase');
      setMessage(`已將 ${productIds.length} 件商品加入購物車；每件數量 1，呢個造型已加車嘅項目會保持鎖定。`);
    });

  const buyNow = () => runLocked('buy', async () => {
    if (!user) throw new Error('請先登入，再繼續購買');
    const items = await validateItems(remainingIds);
    if (!saveTryOnCheckoutDraft(window.sessionStorage, user.id, job.lookId, items, {
      promoCode: appliedPromo ?? undefined,
      useWallet,
    })) {
      throw new Error('瀏覽器未能保留今次購買清單，請改用「加入購物車」');
    }
    // 小精靈導覽：validateItems＋draft 儲存成功、跳轉前記「已購買」；任何失敗都唔會行到呢度
    emitTryOnGuideAction('purchase');
    await navigate('/checkout?source=try-on');
  });

  const controlsDisabled = busy !== null || promoValidate.isPending || productsQuery.isLoading ||
    (addedItems.length > 0 && cartQuery.isFetching);

  if (completedItems.length === 0) return null;

  return (
    <section className="tryon-purchase" aria-labelledby="tryon-purchase-title" data-testid="tryon-purchase" data-fairy-target="purchase" tabIndex={-1}>
      <style>{TRYON_PURCHASE_CSS}</style>
      <header className="tryon-purchase-heading">
        <div>
          <p className="tryon-kicker">04 · MAKE IT YOURS</p>
          <h3 id="tryon-purchase-title">試啱，就由呢度帶走</h3>
          <p>已帶入呢套完成造型嘅商品。逐件核對品名、貨號、目前售價及尺寸，先決定加車或即買。</p>
        </div>
        <span><strong>{selectedIds.length}</strong>／{completedItems.length} 件已揀</span>
      </header>

      {selectedIds.length === 0 ? (
        <div className="tryon-purchase-empty">
          <p>今次購買清單已移空，私人試穿圖仍然保留。</p>
          <button type="button" onClick={() => setSelectedIds(completedItems.map((item) => item.productId))}>還原 {completedItems.length} 件商品</button>
        </div>
      ) : (
        <div className="tryon-purchase-grid">
          <div className="tryon-purchase-ledger">
            <div className="tryon-purchase-labels" aria-hidden="true"><span>品名／貨號</span><span>價錢</span></div>
            <ol>
              {rows.map(({ lookItem, product }, index) => {
                const added = addedIds.includes(lookItem.productId);
                const options = product ? parseSizes(product.sizes) : [];
                const requireSize = Boolean(product && needsSize(product));
                const currentPrice = product ? (product.discountPrice ?? product.price) : null;
                const snapshotPrice = lookItem.productDiscountPrice ?? lookItem.productPrice;
                return (
                  <li key={lookItem.productId} className="tryon-purchase-item" data-product-id={lookItem.productId}>
                    <div className="tryon-purchase-item-index">{String(index + 1).padStart(2, '0')}</div>
                    <img src={product?.image ?? lookItem.productImagePath} alt="" />
                    <div className="tryon-purchase-item-main">
                      <span className="tryon-purchase-field">品名</span>
                      <h4>{product?.name ?? lookItem.productName}</h4>
                      <p className="tryon-purchase-sku"><span>貨號</span><strong>{product?.sku ?? lookItem.productSku}</strong></p>
                      {product && <p className="tryon-purchase-stock" data-sold-out={product.stock <= 0}>{product.stock > 0 ? `現貨 ${product.stock} 件` : '暫時售罄'}</p>}
                      {!product && productsQuery.data && <p className="tryon-purchase-stock" data-sold-out="true">已下架／暫時未能購買</p>}
                      {requireSize && product && (
                        <label className="tryon-purchase-size">
                          <span>尺寸（必填）</span>
                          <select
                            value={selectedSizes[lookItem.productId] ?? ''}
                            disabled={controlsDisabled || added}
                            aria-label={`${product.name} 尺寸`}
                            onChange={(event) => {
                              const value = event.target.value;
                              setSelectedSizes((current) => ({ ...current, [lookItem.productId]: value }));
                              setError(null);
                            }}
                          >
                            <option value="">請按尺寸表選擇</option>
                            {options.map((size) => <option key={size} value={size}>{size}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                    <div className="tryon-purchase-price">
                      <span>價錢</span>
                      <strong>{money(currentPrice ?? snapshotPrice)}</strong>
                      <small>{product ? (productsQuery.isError ? '最近讀取售價' : '目前售價') : '生成時價錢快照'}</small>
                      {product?.discountPrice != null && product.discountPrice < product.price && <del>{money(product.price)}</del>}
                    </div>
                    <div className="tryon-purchase-item-actions">
                      <button
                        type="button"
                        className="tryon-purchase-add-one"
                        disabled={controlsDisabled || added || (product ? product.stock <= 0 : Boolean(productsQuery.data))}
                        onClick={() => void addToCart([lookItem.productId], lookItem.productId)}
                        aria-label={`將 ${product?.name ?? lookItem.productName} 加入購物車`}
                      >
                        {busy === lookItem.productId ? <LoaderCircle className="tryon-spin" size={15} /> : added ? <Check size={15} /> : <ShoppingBag size={15} />}
                        {added ? '已加車' : '加車'}
                      </button>
                      <button
                        type="button"
                        className="tryon-purchase-remove"
                        disabled={controlsDisabled}
                        onClick={() => {
                          setSelectedIds((current) => current.filter((id) => id !== lookItem.productId));
                          setError(null);
                          setMessage(null);
                        }}
                        aria-label={`將 ${product?.name ?? lookItem.productName} 移出購買清單`}
                      ><X size={15} />移出清單</button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="tryon-purchase-privacy">「移出清單」只改變今次購買選擇，唔會刪除私人試穿圖，亦唔會搬走已加入購物車嘅商品。</p>
          </div>

          <aside className="tryon-purchase-summary">
            <p className="tryon-kicker">YOUR LOOK / YOUR CALL</p>
            <div className="tryon-purchase-total">
              <span>即買商品小計（{remainingIds.length} 件）</span>
              <strong>{displaySubtotal === null ? '待更新' : money(displaySubtotal)}</strong>
            </div>
            <p>
              每件數量 1，小計已計目前商品折扣。
              {remainingIds.length < selectedIds.length ? ` 已加車嘅 ${selectedIds.length - remainingIds.length} 件唔計入呢個即買報價。` : ''}
            </p>

            {remainingIds.length > 0 && (
              <div className="tryon-purchase-promo">
                {appliedPromo ? (
                  <div className="tryon-purchase-promo-chip">
                    <TicketPercent size={15} aria-hidden="true" />
                    <strong>{appliedPromo}</strong>
                    <span>{quote ? `−${money(couponDiscount)}` : quoteQuery.isFetching ? '重算中' : '待核實'}</span>
                    <button type="button" onClick={() => { setAppliedPromo(null); setPromoError(null); }} aria-label={`移除優惠碼 ${appliedPromo}`}><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <div className="tryon-purchase-promo-entry">
                      <input
                        value={promoInput}
                        onChange={(event) => { setPromoInput(event.target.value.toUpperCase()); setPromoError(null); }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') { event.preventDefault(); void applyPromo(); }
                        }}
                        placeholder="輸入優惠碼"
                        aria-label="試穿商品優惠碼"
                        aria-invalid={Boolean(promoError)}
                        maxLength={32}
                      />
                      <button type="button" disabled={!promoInput.trim() || promoValidate.isPending || !quote || quoteQuery.isFetching} onClick={() => void applyPromo()}>
                        {promoValidate.isPending ? <LoaderCircle className="tryon-spin" size={15} /> : '使用'}
                      </button>
                    </div>
                    {!quote && <small>{quoteReady ? '目前報價載入後即可使用優惠碼' : '揀齊有效尺寸後即可使用優惠碼'}</small>}
                  </>
                )}
                {promoError && <p role="alert">{promoError}</p>}
              </div>
            )}

            <div className="tryon-purchase-breakdown" aria-live="polite">
              {quoteQuery.isFetching && <p className="tryon-purchase-quote-status" role="status">正在按目前商品及會員資料更新報價…</p>}
              {vipDiscount > 0 && (
                <div><span>VIP{quote?.vipTier === 'GOLD' ? '金' : '銀'}會員折扣</span><strong>−{money(vipDiscount)}</strong></div>
              )}
              {quote && appliedPromo && (
                <div><span>優惠碼 {appliedPromo}</span><strong>−{money(couponDiscount)}</strong></div>
              )}
              {quote && (
                <div><span className="tryon-purchase-with-icon"><Truck size={14} />運費</span><strong className={quote.shippingFree ? '' : 'muted'}>{quote.shippingFree ? '免運' : quote.shippingLabel}</strong></div>
              )}
              {quote && walletBalance > 0 && (
                <div className="tryon-purchase-wallet">
                  <button type="button" role="switch" aria-checked={useWallet} onClick={() => setUseWallet((value) => !value)}>
                    <span className="tryon-purchase-with-icon"><Wallet size={15} />用購物金（餘額 {money(walletBalance)}）</span>
                    <span aria-hidden="true" data-on={useWallet}><i /></span>
                  </button>
                  {useWallet && <small>購物金不設退款；只限官網商品，直播商品唔用得。</small>}
                </div>
              )}
              {quote && useWallet && quote.walletApplied > 0 && (
                <div><span>購物金扣減</span><strong>−{money(quote.walletApplied)}</strong></div>
              )}
              {quote && (
                <div className="tryon-purchase-grand-total">
                  <span>{useWallet && quote.walletApplied > 0 ? '折後總計' : '預覽總計'}</span>
                  <strong>{money(quote.totalCents / 100)}</strong>
                </div>
              )}
              {quote && useWallet && quote.walletApplied > 0 && (
                <div className="tryon-purchase-cash-due"><span>最終應付尾數</span><strong>{money(quote.cashDue)}</strong></div>
              )}
            </div>
            <p className="tryon-purchase-quote-note">以上係香港送貨上門預覽；地區、自取方式及最終金額會喺結帳頁再按你選擇重算。落單時 server 會再讀商品、優惠及購物金，唔會用畫面舊價錢成交。</p>
            {quoteQuery.isError && <p className="tryon-purchase-warning" role="alert">報價未能更新：{quoteQuery.error.message}。你仍可去結帳頁重試，落單前 server 會再核實。</p>}
            <p className="tryon-purchase-size-note">AI 試穿只係視覺預覽，唔代表尺碼、鬆緊或合身程度。需要尺寸嘅商品一定要由你親自選擇。</p>
            {productsQuery.isError && <p className="tryon-purchase-warning" role="alert">目前商品資料更新失敗；撳購買掣時會再試，唔會用生成時快照當結帳價。</p>}
            {addedItems.length > 0 && cartQuery.isError && (
              <p className="tryon-purchase-warning" role="alert">購物車對賬失敗；為免重複加車，已加車項目會保持鎖定。<button type="button" onClick={() => void cartQuery.refetch()}>重新對賬</button></p>
            )}
            {error && <p className="tryon-purchase-error" role="alert">{error}</p>}
            {message && <p className="tryon-purchase-message" role="status">{message}</p>}
            <div className="tryon-purchase-actions">
              <button
                type="button"
                className="tryon-purchase-cart"
                disabled={controlsDisabled || remainingIds.length === 0}
                onClick={() => void addToCart(remainingIds, 'all')}
              >
                {busy === 'all' ? <LoaderCircle className="tryon-spin" size={18} /> : <ShoppingBag size={18} />}
                {remainingIds.length === 0 ? '所揀商品已加車' : addedIds.some((id) => selectedIds.includes(id)) ? `加入其餘 ${remainingIds.length} 件` : `加入購物車（${remainingIds.length} 件）`}
              </button>
              <button type="button" className="tryon-purchase-buy" disabled={controlsDisabled || remainingIds.length === 0} onClick={() => void buyNow()}>
                {busy === 'buy' ? <LoaderCircle className="tryon-spin" size={18} /> : null}
                {busy === 'buy' ? '核實商品及價錢中…' : remainingIds.length === 0 ? '所揀商品已在購物車' : `立即購買 ${remainingIds.length} 件`}
              </button>
            </div>
            <p className="tryon-purchase-mode-note">
              {remainingIds.length < selectedIds.length
                ? `立即購買只帶未加車嘅 ${remainingIds.length} 件；已加車商品請到購物車結帳，唔會重複即買。原有購物車唔會被清空。`
                : `立即購買只帶呢 ${remainingIds.length} 件去結帳，唔會混入或清空你原有購物車。`}
            </p>
            {(addedIds.length > 0 || message) && <Link to="/cart" className="tryon-purchase-view-cart">查看購物車 →</Link>}
          </aside>
        </div>
      )}
    </section>
  );
}

const TRYON_PURCHASE_CSS = /* css */ `
  .tryon-purchase { margin-top: 42px; border-top: 1px solid var(--studio-ink); border-bottom: 1px solid var(--studio-ink); }
  .tryon-purchase-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; padding: 26px 0 24px; }
  .tryon-purchase-heading h3 { margin: 8px 0 0; font-family: 'Noto Serif TC', serif; font-size: clamp(25px, 3vw, 38px); line-height: 1.25; letter-spacing: -.025em; }
  .tryon-purchase-heading > div > p:last-child { max-width: 690px; margin: 12px 0 0; color: var(--studio-muted); font-size: 13px; line-height: 1.8; }
  .tryon-purchase-heading > span { flex: 0 0 auto; padding-bottom: 4px; color: var(--studio-muted); font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 12px; }
  .tryon-purchase-heading > span strong { margin-right: 4px; color: var(--studio-pink); font-size: 32px; line-height: 1; }
  .tryon-purchase-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(285px, .75fr); border-top: 1px solid var(--studio-line); }
  .tryon-purchase-ledger { min-width: 0; padding-right: clamp(22px, 3vw, 42px); }
  .tryon-purchase-labels { display: grid; grid-template-columns: 1fr auto; padding: 12px 0 10px 132px; color: var(--studio-muted); font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
  .tryon-purchase-ledger ol { list-style: none; margin: 0; padding: 0; }
  .tryon-purchase-item { position: relative; display: grid; grid-template-columns: 28px 82px minmax(0, 1fr) auto; gap: 16px; align-items: start; padding: 22px 0 58px; border-top: 1px solid var(--studio-line); }
  .tryon-purchase-item-index { padding-top: 3px; color: var(--studio-pink); font-family: 'DM Mono', monospace; font-size: 11px; }
  .tryon-purchase-item > img { width: 82px; height: 102px; object-fit: cover; border: 1px solid var(--studio-line); background: #fff; }
  .tryon-purchase-item-main { min-width: 0; }
  .tryon-purchase-field, .tryon-purchase-price > span { display: block; color: var(--studio-muted); font-size: 10px; letter-spacing: .12em; }
  .tryon-purchase-item h4 { margin: 5px 0 0; font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; }
  .tryon-purchase-sku { display: flex; flex-wrap: wrap; gap: 8px; margin: 7px 0 0; color: var(--studio-muted); font-size: 11px; }
  .tryon-purchase-sku strong { color: var(--studio-ink); font-family: 'DM Mono', monospace; font-weight: 500; overflow-wrap: anywhere; }
  .tryon-purchase-stock { margin: 7px 0 0; color: var(--studio-muted); font-size: 11px; }
  .tryon-purchase-stock[data-sold-out="true"] { color: var(--studio-pink); font-weight: 700; }
  .tryon-purchase-price { min-width: 100px; text-align: right; }
  .tryon-purchase-price strong { display: block; margin-top: 5px; font-family: 'DM Mono', monospace; font-size: 18px; white-space: nowrap; }
  .tryon-purchase-price small { display: block; margin-top: 3px; color: var(--studio-muted); font-size: 10px; }
  .tryon-purchase-price del { display: block; margin-top: 4px; color: var(--studio-muted); font-family: 'DM Mono', monospace; font-size: 11px; }
  .tryon-purchase-size { display: block; max-width: 260px; margin-top: 14px; }
  .tryon-purchase-size > span { display: block; margin-bottom: 6px; color: var(--studio-muted); font-size: 11px; }
  .tryon-purchase-size select { width: 100%; min-height: 44px; padding: 0 34px 0 11px; border: 1px solid var(--studio-line); border-radius: 0; background: transparent; color: var(--studio-ink); font: inherit; font-size: 13px; }
  .tryon-purchase-size select:focus-visible { outline: 2px solid var(--studio-pink); outline-offset: 2px; }
  .tryon-purchase-item-actions { position: absolute; left: 126px; right: 0; bottom: 13px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tryon-purchase-item-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 38px; padding: 0; border: 0; background: transparent; cursor: pointer; font-size: 12px; font-weight: 700; }
  .tryon-purchase-add-one { color: var(--studio-ink); }
  .tryon-purchase-remove { color: var(--studio-muted); }
  .tryon-purchase-item-actions button:hover { color: var(--studio-pink); }
  .tryon-purchase-privacy { margin: 0; padding: 14px 0 18px; border-top: 1px solid var(--studio-line); color: var(--studio-muted); font-size: 11px; line-height: 1.75; }
  .tryon-purchase-summary { align-self: start; position: sticky; top: 22px; padding: 26px; background: var(--studio-ink); color: var(--studio-paper); }
  .tryon-purchase-summary .tryon-kicker { color: rgba(255,247,232,.62); }
  .tryon-purchase-total { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-top: 22px; padding: 18px 0; border-top: 1px solid rgba(255,247,232,.26); border-bottom: 1px solid rgba(255,247,232,.26); }
  .tryon-purchase-total span { font-size: 13px; }
  .tryon-purchase-total strong { color: var(--studio-gold); font-family: 'DM Mono', monospace; font-size: 25px; white-space: nowrap; }
  .tryon-purchase-promo { margin-top: 18px; }
  .tryon-purchase-promo-entry { display: flex; gap: 8px; }
  .tryon-purchase-promo-entry input { min-width: 0; flex: 1; min-height: 44px; padding: 0 12px; border: 1px solid rgba(255,247,232,.35); border-radius: 0; background: rgba(255,247,232,.06); color: var(--studio-paper); font: inherit; font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 12px; text-transform: uppercase; }
  .tryon-purchase-promo-entry input::placeholder { color: rgba(255,247,232,.52); text-transform: none; }
  .tryon-purchase-promo-entry button { flex: 0 0 auto; min-width: 62px; min-height: 44px; border: 1px solid var(--studio-gold); background: transparent; color: var(--studio-gold); cursor: pointer; font-weight: 800; }
  .tryon-purchase-promo-entry button:disabled { cursor: not-allowed; opacity: .45; }
  .tryon-purchase-promo small { display: block; margin-top: 7px; color: rgba(255,247,232,.6); font-size: 10px; line-height: 1.6; }
  .tryon-purchase-promo > p { margin: 8px 0 0; color: #ffb5c8; font-size: 11px; line-height: 1.65; }
  .tryon-purchase-promo-chip { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 44px; padding: 8px 10px; border: 1px solid var(--studio-gold); color: var(--studio-gold); }
  .tryon-purchase-promo-chip strong { min-width: 0; overflow-wrap: anywhere; font-family: 'DM Mono', monospace; font-size: 12px; }
  .tryon-purchase-promo-chip span { margin-left: auto; font-family: 'DM Mono', monospace; font-size: 11px; }
  .tryon-purchase-promo-chip button { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; min-height: 30px; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .tryon-purchase-breakdown { margin-top: 18px; padding-top: 4px; border-top: 1px solid rgba(255,247,232,.18); }
  .tryon-purchase-breakdown > div:not(.tryon-purchase-wallet) { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-top: 12px; font-size: 12px; }
  .tryon-purchase-breakdown > div > strong { flex: 0 0 auto; color: var(--studio-gold); font-family: 'DM Mono', 'Noto Sans TC', monospace; font-size: 12px; text-align: right; }
  .tryon-purchase-breakdown > div > strong.muted { color: rgba(255,247,232,.66); }
  .tryon-purchase-with-icon { display: inline-flex; align-items: center; gap: 7px; }
  .tryon-purchase-quote-status { margin: 10px 0 0; color: rgba(255,247,232,.66); font-size: 10px; line-height: 1.6; }
  .tryon-purchase-wallet { margin-top: 14px; padding: 11px 0; border-top: 1px solid rgba(255,247,232,.14); border-bottom: 1px solid rgba(255,247,232,.14); }
  .tryon-purchase-wallet > button { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 34px; padding: 0; border: 0; background: transparent; color: var(--studio-paper); cursor: pointer; text-align: left; font-size: 11px; }
  .tryon-purchase-wallet > button > span:last-child { position: relative; flex: 0 0 auto; width: 38px; height: 22px; border: 1px solid rgba(255,247,232,.48); border-radius: 20px; }
  .tryon-purchase-wallet > button > span:last-child i { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--studio-paper); transition: transform .18s ease, background .18s ease; }
  .tryon-purchase-wallet > button > span:last-child[data-on="true"] { border-color: var(--studio-gold); }
  .tryon-purchase-wallet > button > span:last-child[data-on="true"] i { transform: translateX(16px); background: var(--studio-gold); }
  .tryon-purchase-wallet small { display: block; margin-top: 7px; color: rgba(255,247,232,.62); font-size: 10px; line-height: 1.6; }
  .tryon-purchase-breakdown > div.tryon-purchase-grand-total { margin-top: 16px; padding-top: 15px; border-top: 1px solid rgba(255,247,232,.26); font-size: 14px; font-weight: 800; }
  .tryon-purchase-breakdown > div.tryon-purchase-grand-total strong { font-size: 22px; }
  .tryon-purchase-breakdown > div.tryon-purchase-cash-due { margin-top: 14px; padding: 13px 0 0; border-top: 1px solid var(--studio-gold); font-size: 15px; font-weight: 800; }
  .tryon-purchase-breakdown > div.tryon-purchase-cash-due strong { font-size: 25px; }
  .tryon-purchase-promo input:focus-visible, .tryon-purchase-promo button:focus-visible, .tryon-purchase-wallet button:focus-visible { outline: 2px solid var(--studio-gold); outline-offset: 3px; }
  .tryon-purchase-summary > p { margin: 15px 0 0; color: rgba(255,247,232,.72); font-size: 11px; line-height: 1.75; }
  .tryon-purchase-summary > p.tryon-purchase-size-note { color: var(--studio-paper); }
  .tryon-purchase-summary > p.tryon-purchase-warning, .tryon-purchase-summary > p.tryon-purchase-error { color: #ffb5c8; }
  .tryon-purchase-summary > p.tryon-purchase-warning button { margin-left: 8px; padding: 0; border: 0; background: transparent; color: var(--studio-paper); cursor: pointer; font: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .tryon-purchase-summary > p.tryon-purchase-message { color: var(--studio-gold); }
  .tryon-purchase-actions { display: grid; gap: 10px; margin-top: 22px; }
  .tryon-purchase-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 9px; width: 100%; min-height: 50px; padding: 0 16px; border: 1px solid transparent; border-radius: 0; cursor: pointer; font-size: 13px; font-weight: 800; }
  .tryon-purchase-cart { border-color: rgba(255,247,232,.55) !important; background: transparent; color: var(--studio-paper); }
  .tryon-purchase-buy { background: var(--studio-paper); color: var(--studio-ink); }
  .tryon-purchase-actions button:hover:not(:disabled) { border-color: var(--studio-gold) !important; }
  .tryon-purchase-actions button:disabled { cursor: not-allowed; opacity: .46; }
  .tryon-purchase-summary > p.tryon-purchase-mode-note { margin-top: 12px; font-size: 10px; }
  .tryon-purchase-view-cart { display: inline-block; margin-top: 15px; color: var(--studio-gold); font-size: 12px; text-underline-offset: 4px; }
  .tryon-purchase-empty { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 24px 0; border-top: 1px solid var(--studio-line); color: var(--studio-muted); font-size: 13px; }
  .tryon-purchase-empty p { margin: 0; }
  .tryon-purchase-empty button { min-height: 44px; padding: 0 16px; border: 1px solid var(--studio-ink); background: transparent; color: var(--studio-ink); cursor: pointer; font-weight: 700; }
  @media (max-width: 900px) {
    .tryon-purchase-grid { grid-template-columns: minmax(0, 1fr); }
    .tryon-purchase-ledger { padding-right: 0; }
    .tryon-purchase-summary { position: static; margin-top: 4px; }
  }
  @media (max-width: 560px) {
    .tryon-purchase { margin-top: 32px; }
    .tryon-purchase-heading { align-items: flex-start; gap: 14px; }
    .tryon-purchase-heading > div > p:last-child { font-size: 12px; }
    .tryon-purchase-heading > span { padding-top: 24px; white-space: nowrap; }
    .tryon-purchase-heading > span strong { font-size: 26px; }
    .tryon-purchase-labels { padding-left: 94px; }
    .tryon-purchase-item { grid-template-columns: 64px minmax(0, 1fr) auto; gap: 12px; padding-top: 20px; }
    .tryon-purchase-item-index { display: none; }
    .tryon-purchase-item > img { width: 64px; height: 82px; }
    .tryon-purchase-item h4 { font-size: 14px; }
    .tryon-purchase-price { min-width: 82px; }
    .tryon-purchase-price strong { font-size: 15px; }
    .tryon-purchase-item-actions { left: 76px; }
    .tryon-purchase-size { max-width: 220px; }
    .tryon-purchase-summary { margin-left: -2px; margin-right: -2px; padding: 24px 20px; }
    .tryon-purchase-empty { align-items: flex-start; flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tryon-purchase-wallet > button > span:last-child i { transition: none; }
  }
  @media (max-width: 380px) {
    .tryon-purchase-heading { display: block; }
    .tryon-purchase-heading > span { display: block; padding-top: 12px; }
    .tryon-purchase-item { grid-template-columns: 54px minmax(0, 1fr); }
    .tryon-purchase-item > img { width: 54px; height: 72px; }
    .tryon-purchase-price { grid-column: 2; text-align: left; }
    .tryon-purchase-price strong, .tryon-purchase-price small, .tryon-purchase-price del { display: inline-block; margin-right: 8px; }
    .tryon-purchase-item-actions { left: 66px; }
    .tryon-purchase-labels { display: none; }
  }
`;

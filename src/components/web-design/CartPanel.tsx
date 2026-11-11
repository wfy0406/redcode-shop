'use client';

/**
 * CartPanel —— 購物車＋結帳＋落單結果（原位 aside，唔係全屏 modal）
 *
 * 流程：揀方案＋項目 → 填 name/phone（必填）email/requirements/styleNotes →
 * createOrder → 同段顯示訂單編號、正式訂單圖、Airwallex 付款、付款截圖上傳。
 * 金額顯示分開：一次性 / 首月月費（今次一齊收）/ 其後每月。
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  planLabel,
  type WebDesignCatalog,
  type WebDesignPlan,
} from '@contracts/webDesign';
import { PAYMENT_METHODS_SETTING_KEY, parsePaymentMethods } from '@contracts/paymentMethods';
import { trpc } from '@/providers/trpc';
import { redirectToAirwallexCheckout } from '@/lib/airwallexCheckout';
import { wdApi, uploadWdProof, type WdCreateOrderResult } from './api';
import { computeCart, fmtHKD, isNonEmpty, looksLikeEmail, looksLikePhone } from './helpers';

interface CartPanelProps {
  catalog: WebDesignCatalog;
  plan: WebDesignPlan | null;
  selected: ReadonlySet<string>;
  onRemoveItem: (key: string) => void;
  onChangePlan: () => void;
}

type ProofPhase = 'idle' | 'uploading' | 'attaching' | 'done';

export default function CartPanel({ catalog, plan, selected, onRemoveItem, onChangePlan }: CartPanelProps) {
  const totals = computeCart(catalog, plan, selected);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [requirements, setRequirements] = useState('');
  const [styleNotes, setStyleNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const [order, setOrder] = useState<(WdCreateOrderResult & { name: string; phone: string }) | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [proofPhase, setProofPhase] = useState<ProofPhase>('idle');
  const [proofError, setProofError] = useState<string | null>(null);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const createOrder = wdApi.createOrder.useMutation();
  const createPayment = wdApi.createPayment.useMutation();
  const attachProof = wdApi.attachProof.useMutation();

  // 手動收款資料：同 Checkout 同一來源（siteSettings payment_methods），唔准硬編帳號
  const methodsQuery = trpc.settings.get.useQuery({ key: PAYMENT_METHODS_SETTING_KEY });
  const methodsEntry = methodsQuery.data as { key: string; value: string } | null | undefined;
  const paymentMethods = parsePaymentMethods(methodsEntry?.value);

  // preview object URL 用完要 revoke，避免長頁 memory leak
  useEffect(() => {
    return () => {
      if (proofPreview) URL.revokeObjectURL(proofPreview);
    };
  }, [proofPreview]);

  const planPrice = plan === 'full_stack' ? catalog.fullStackPrice : plan === 'front_only' ? catalog.frontOnlyPrice : 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!plan) {
      setFormError('請先喺第一段揀「只要前台」或「前台＋後台」方案。');
      return;
    }
    if (!isNonEmpty(name) || !looksLikePhone(phone)) {
      setFormError('請填寫姓名同有效電話（必填）。');
      return;
    }
    if (isNonEmpty(email) && !looksLikeEmail(email)) {
      setFormError('Email 格式似乎唔啱，請檢查一下（呢欄可以留空）。');
      return;
    }
    try {
      const result = await createOrder.mutateAsync({
        plan,
        itemKeys: [...selected],
        name: name.trim(),
        phone: phone.trim(),
        ...(isNonEmpty(email) ? { email: email.trim() } : {}),
        requirements: requirements.trim(),
        styleNotes: styleNotes.trim(),
      });
      setOrder({ ...result, name: name.trim(), phone: phone.trim() });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '落單失敗，請稍後再試。');
    }
  };

  const onPayOnline = async () => {
    if (!order) return;
    setPayError(null);
    try {
      const result = await createPayment.mutateAsync({
        orderNo: order.orderNo,
        name: order.name,
        phone: order.phone,
      });
      if (!result.enabled) {
        setPayError(result.message || '網上付款暫時未開放，請用截圖上傳或 WhatsApp 我哋。');
        return;
      }
      // 回跳後用 sessionStorage 嘅一次性身份自動查單；姓名電話唔放入 URL。
      try {
        sessionStorage.setItem(
          'redcode_web_design_return',
          JSON.stringify({ orderNo: order.orderNo, name: order.name, phone: order.phone }),
        );
      } catch {
        // 私隱模式可能唔畀儲存；付款仍照去，回來可手動查單。
      }
      // 成功會即刻 full-page 跳轉去託管付款頁
      await redirectToAirwallexCheckout(result);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : '付款元件出錯，請再試一次。');
    }
  };

  const onPickProof = async (file: File) => {
    if (!order) return;
    setProofError(null);
    if (proofPreview) URL.revokeObjectURL(proofPreview);
    setProofPreview(URL.createObjectURL(file));
    try {
      setProofPhase('uploading');
      const imagePath = await uploadWdProof({
        orderNo: order.orderNo,
        name: order.name,
        phone: order.phone,
        file,
      });
      setProofPhase('attaching');
      await attachProof.mutateAsync({
        orderNo: order.orderNo,
        name: order.name,
        phone: order.phone,
        imagePath,
      });
      setProofPhase('done');
    } catch (err) {
      setProofPhase('idle');
      setProofPreview(null);
      setProofError(err instanceof Error ? err.message : '上傳失敗，請再試一次。');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <aside className="wd-cart" aria-label="購物車及結帳">
      <h3 className="wd-cart-title">購物車</h3>

      {!plan && <p className="wd-cart-empty">未揀方案。請喺第 01 或 02 段揀一個方案；揀咗會即時加入購物車。</p>}

      {plan && (
        <>
          <ul className="wd-cart-lines">
            <li className="wd-cart-line">
              <span className="wd-cart-line-name">
                {planLabel(plan)}基本方案
                <small>一次性</small>
              </span>
              <span>
                {fmtHKD(planPrice)}{' '}
                <button type="button" className="wd-cart-remove" onClick={onChangePlan}>
                  更改
                </button>
              </span>
            </li>
            {totals.items.map((it) => (
              <li key={it.key} className="wd-cart-line">
                <span className="wd-cart-line-name">
                  {it.name}
                  <small>{it.billing === 'monthly' ? '每月' : '一次性'}</small>
                </span>
                <span>
                  {fmtHKD(it.price)}
                  {it.billing === 'monthly' ? '／月' : ''}{' '}
                  <button
                    type="button"
                    className="wd-cart-remove"
                    onClick={() => onRemoveItem(it.key)}
                    aria-label={`移除${it.name}`}
                  >
                    移除
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <dl className="wd-cart-totals">
            <div>
              <dt>一次性（方案＋單次項目）</dt>
              <dd>{fmtHKD(totals.oneOff)}</dd>
            </div>
            <div>
              <dt>首月月費</dt>
              <dd>{fmtHKD(totals.monthly)}</dd>
            </div>
            <div className="wd-cart-duenow">
              <dt>今次應付</dt>
              <dd>{fmtHKD(totals.dueNow)}</dd>
            </div>
            {totals.monthly > 0 && (
              <div>
                <dt>其後每月</dt>
                <dd>{fmtHKD(totals.monthly)}／月</dd>
              </div>
            )}
          </dl>
          <p className="wd-cart-note">
            今次付款 = 一次性費用＋首月月費；其後月費每月另行安排，唔會自動續扣。
            Domain 約 HK$100–300／年，按供應商實報實銷，唔會強制加入購物車。
          </p>
        </>
      )}

      {!order && (
        <form className="wd-checkout" onSubmit={onSubmit} noValidate>
          <div className="wd-checkout-grid">
            <div className="wd-field">
              <label className="wd-label" htmlFor="wd-co-name">
                姓名 <span className="wd-req" aria-hidden="true">*</span>
              </label>
              <input
                id="wd-co-name"
                className="wd-input"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="wd-field">
              <label className="wd-label" htmlFor="wd-co-phone">
                電話 <span className="wd-req" aria-hidden="true">*</span>
              </label>
              <input
                id="wd-co-phone"
                className="wd-input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="wd-field">
            <label className="wd-label" htmlFor="wd-co-email">
              Email（選填，方便跟進）
            </label>
            <input
              id="wd-co-email"
              className="wd-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="wd-field">
            <label className="wd-label" htmlFor="wd-co-req">
              網站內容要求
            </label>
            <textarea
              id="wd-co-req"
              className="wd-textarea"
              placeholder="例如：公司介紹、服務列表、聯絡表格、想有邊幾版…"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
            />
          </div>
          <div className="wd-field">
            <label className="wd-label" htmlFor="wd-co-style">
              風格備註
            </label>
            <textarea
              id="wd-co-style"
              className="wd-textarea"
              placeholder="例如：簡約、暖色、參考邊個網站嘅感覺…"
              value={styleNotes}
              onChange={(e) => setStyleNotes(e.target.value)}
            />
          </div>

          {formError && (
            <p className="wd-error" role="alert">
              {formError}
            </p>
          )}

          <button type="submit" className="wd-cta" disabled={!plan || createOrder.isPending}>
            {createOrder.isPending ? '落單緊…' : '確認落單'}
          </button>
        </form>
      )}

      {order && (
        <div className="wd-order-result" role="status">
          <h3 className="wd-h3">已收到訂單 ✓</h3>
          <p style={{ margin: 0 }}>
            訂單編號：<strong className="wd-order-no">{order.orderNo}</strong>
          </p>
          <dl className="wd-cart-totals">
            <div>
              <dt>一次性</dt>
              <dd>{fmtHKD(order.oneOffTotal)}</dd>
            </div>
            <div>
              <dt>月費</dt>
              <dd>{fmtHKD(order.monthlyTotal)}／月</dd>
            </div>
            <div className="wd-cart-duenow">
              <dt>今次應付</dt>
              <dd>{fmtHKD(order.total)}</dd>
            </div>
          </dl>

          <img
            className="wd-order-img"
            src={order.orderImagePath}
            alt={`訂單 ${order.orderNo} 正式訂單圖`}
            loading="lazy"
          />

          <div className="wd-pay-actions">
            <button
              type="button"
              className="wd-cta"
              onClick={() => void onPayOnline()}
              disabled={createPayment.isPending}
            >
              {createPayment.isPending ? '準備付款中…' : '網上即時付款'}
            </button>
            <span className="wd-hint">或者轉數快／PayMe／AlipayHK／銀行過數 ↓</span>
          </div>
          {payError && (
            <p className="wd-error" role="alert">
              {payError}
            </p>
          )}

          {/* 手動收款資料：同 Checkout 同一來源（siteSettings payment_methods） */}
          <div className="wd-pay-methods">
            <p className="wd-label" style={{ margin: 0 }}>
              手動過數收款資料（今次應付 <strong>{fmtHKD(order.total)}</strong>）
            </p>
            <ul className="wd-pay-methods-list">
              {paymentMethods.map((m) => (
                <li key={m.id}>
                  <span className="wd-pay-method-label">
                    {m.label}
                    <small>{m.subtitle}</small>
                  </span>
                  <span className="wd-pay-method-account">
                    {m.accountLabel}：<strong>{m.account}</strong>
                    {m.extraValue ? (
                      <small>
                        {m.extraLabel}：{m.extraValue}
                      </small>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            <p className="wd-hint">過數後請上傳截圖，確認後即刻開工。</p>
          </div>

          <div className="wd-proof">
            <p className="wd-label" style={{ margin: 0 }}>
              付款截圖上傳
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="wd-visually-hidden"
              aria-label="揀選付款截圖"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && proofPhase !== 'uploading' && proofPhase !== 'attaching') {
                  void onPickProof(file);
                }
              }}
            />
            {proofPreview && (
              <img className="wd-proof-preview" src={proofPreview} alt="付款截圖預覽" />
            )}
            {proofPhase === 'done' ? (
              <p className="wd-ok">已收到截圖 ✓ 訂單已轉「付款待確認」，確認後會即刻開工。</p>
            ) : (
              <button
                type="button"
                className="wd-btn wd-btn--ghost"
                disabled={proofPhase === 'uploading' || proofPhase === 'attaching'}
                onClick={() => fileRef.current?.click()}
              >
                {proofPhase === 'uploading'
                  ? '上傳緊…'
                  : proofPhase === 'attaching'
                    ? '附加緊去訂單…'
                    : '揀截圖上傳'}
              </button>
            )}
            {proofError && (
              <p className="wd-error" role="alert">
                {proofError}
              </p>
            )}
            <p className="wd-hint">
              記低訂單編號，之後可以喺第一段「專屬查單」用姓名＋電話查進度。
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}

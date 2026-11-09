'use client';

/**
 * LookupPanel —— 專屬訂單查詢（完整姓名＋電話）
 * - server 有 rate limit＋統一找不到訊息；前端唔會話你知「邊樣錯」
 * - completed 狀態顯示「網站已完成」
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { planLabel } from '@contracts/webDesign';
import { wdApi, type WdOrderDto } from './api';
import {
  fmtHKD,
  orderStatusLabel,
  paymentStatusLabel,
  isNonEmpty,
  looksLikePhone,
} from './helpers';

export default function LookupPanel({
  initialName = '',
  initialPhone = '',
  autoLookup = false,
}: {
  initialName?: string;
  initialPhone?: string;
  autoLookup?: boolean;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<WdOrderDto[] | null>(null);

  const lookup = wdApi.lookup.useMutation();
  const autoStarted = useRef(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isNonEmpty(name) || !looksLikePhone(phone)) {
      setError('請輸入落單時嘅完整姓名同電話。');
      return;
    }
    try {
      const result = await lookup.mutateAsync({ name: name.trim(), phone: phone.trim() });
      setOrders(result.found ? result.orders : []);
    } catch (err) {
      setOrders(null);
      setError(err instanceof Error ? err.message : '查詢失敗，請稍後再試。');
    }
  };

  useEffect(() => {
    if (!autoLookup || autoStarted.current || !initialName || !initialPhone) return;
    autoStarted.current = true;
    setError(null);
    void lookup
      .mutateAsync({ name: initialName, phone: initialPhone })
      .then((result) => setOrders(result.found ? result.orders : []))
      .catch((err: unknown) => {
        setOrders(null);
        setError(err instanceof Error ? err.message : '查詢失敗，請稍後再試。');
      });
    // 一次性付款回跳查單；mutation 實例改變唔應重複查。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLookup, initialName, initialPhone]);

  return (
    <div className="wd-lookup-body">
      <form className="wd-lookup-grid" onSubmit={onSubmit} noValidate>
        <div className="wd-field">
          <label className="wd-label" htmlFor="wd-lookup-name">
            姓名 <span className="wd-req" aria-hidden="true">*</span>
          </label>
          <input
            id="wd-lookup-name"
            className="wd-input"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="wd-field">
          <label className="wd-label" htmlFor="wd-lookup-phone">
            電話 <span className="wd-req" aria-hidden="true">*</span>
          </label>
          <input
            id="wd-lookup-phone"
            className="wd-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        <div className="wd-lookup-actions">
          <button type="submit" className="wd-btn" disabled={lookup.isPending}>
            {lookup.isPending ? '查詢緊…' : '查詢訂單'}
          </button>
        </div>
      </form>

      <div aria-live="polite">
        {error && (
          <p className="wd-error" role="alert" style={{ marginTop: 14 }}>
            {error}
          </p>
        )}

        {orders && orders.length === 0 && (
          <p className="wd-hint" style={{ marginTop: 14 }}>
            搵唔到相符嘅訂單。請核對姓名同電話係咪同落單時一樣，或者 WhatsApp 我哋跟進。
          </p>
        )}

        {orders && orders.length > 0 && (
          <div className="wd-order-cards">
            {orders.map((o) => (
              <article key={o.orderNo} className="wd-order-card">
                <div className="wd-order-card-head">
                  <span className="wd-order-no">{o.orderNo}</span>
                  <span
                    className={`wd-status${
                      o.status === 'completed'
                        ? ' wd-status--completed'
                        : o.status === 'cancelled'
                          ? ' wd-status--cancelled'
                          : ''
                    }`}
                  >
                    {orderStatusLabel(o.status)}
                  </span>
                  <span className="wd-tag">{paymentStatusLabel(o.paymentStatus)}</span>
                  <span className="wd-tag">{planLabel(o.plan)}</span>
                </div>
                <dl>
                  <div>
                    <dt>今次應付</dt>
                    <dd>{fmtHKD(o.total)}</dd>
                  </div>
                  <div>
                    <dt>一次性</dt>
                    <dd>{fmtHKD(o.oneOffTotal)}</dd>
                  </div>
                  <div>
                    <dt>月費</dt>
                    <dd>{fmtHKD(o.monthlyTotal)}／月</dd>
                  </div>
                  <div>
                    <dt>落單日期</dt>
                    <dd>{new Date(o.createdAt).toLocaleDateString('zh-HK')}</dd>
                  </div>
                </dl>
                {o.status === 'completed' && (
                  <p className="wd-ok">網站已完成，多謝支持！如需改動或加功能，WhatsApp 我哋。</p>
                )}
                {o.items.length > 0 && (
                  <p className="wd-hint">
                    已選項目：{o.items.map((it) => it.name).join('、')}
                  </p>
                )}
                {o.orderImagePath && (
                  <img
                    className="wd-order-img"
                    src={o.orderImagePath}
                    alt={`訂單 ${o.orderNo} 正式訂單圖`}
                    loading="lazy"
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { trpc } from '@/providers/trpc';
import type { AdminOrder } from './types';
import { fmtHKD } from './format';
import WishingStar from './WishingStar';

interface EditLine {
  productId: number;
  productName: string;
  size: string | null;
  price: number;
  quantity: number;
}

/**
 * 後台手動改單面板：加/減貨品、改數量、調折扣／實收。
 * 庫存由 server 按差額調整；實收欄填咗就佢話事（自動計返折扣）。
 */
export default function OrderEditPanel({ order, onClose, onSaved }: {
  order: AdminOrder;
  onClose: () => void;
  onSaved: (warning: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const productsQuery = trpc.products.adminList.useQuery();
  const [lines, setLines] = useState<EditLine[]>(() =>
    order.items.map((i) => ({
      productId: i.productId,
      productName: i.productName,
      size: i.size,
      price: i.price,
      quantity: i.quantity,
    })),
  );
  const [discount, setDiscount] = useState<string>(String(order.discountAmount ?? 0));
  const [totalInput, setTotalInput] = useState<string>('');
  const [addProductId, setAddProductId] = useState<number | null>(null);
  const [addSize, setAddSize] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  const update = trpc.orders.adminUpdate.useMutation({
    onSuccess: async (r) => {
      await utils.orders.adminList.invalidate();
      onSaved(r.wmsWarning ?? null);
    },
    onError: (e) => setErr(e.message || '儲存失敗'),
  });

  const products = productsQuery.data ?? [];
  const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0);
  const discountNum = Math.max(0, Math.min(Number(discount) || 0, subtotal));
  const totalNum = totalInput.trim() !== '' ? Math.max(0, Number(totalInput) || 0) : null;
  const effectiveDiscount = totalNum !== null ? subtotal - totalNum : discountNum;
  const effectiveTotal = subtotal - effectiveDiscount;

  const addProduct = products.find((p) => p.id === addProductId) ?? null;
  const addSizes =
    addProduct && addProduct.sizeEnabled
      ? (addProduct.sizes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      : [];

  const setQty = (idx: number, q: number) =>
    setLines((ls) =>
      ls.map((l, i) => (i === idx ? { ...l, quantity: Math.max(1, Math.min(999, q)) } : l)),
    );
  const removeLine = (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx));

  const handleAddLine = () => {
    setErr(null);
    if (!addProduct) return;
    const size = addSizes.length > 0 ? addSize || addSizes[0] : null;
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.productId === addProduct.id && l.size === size);
      if (idx >= 0) {
        const next = [...ls];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...ls,
        {
          productId: addProduct.id,
          productName: addProduct.name,
          size,
          price: addProduct.discountPrice ?? addProduct.price,
          quantity: 1,
        },
      ];
    });
    setAddProductId(null);
    setAddSize('');
  };

  const handleSave = () => {
    setErr(null);
    if (lines.length === 0) {
      setErr('訂單至少要有一件貨');
      return;
    }
    if (totalNum !== null && totalNum > subtotal) {
      setErr(`實收唔可以高過貨品合計 ${fmtHKD(subtotal)}`);
      return;
    }
    update.mutate({
      orderId: order.id,
      items: lines.map((l) => ({ productId: l.productId, size: l.size, quantity: l.quantity })),
      discountAmount: totalNum !== null ? undefined : discountNum,
      total: totalNum !== null ? totalNum : undefined,
    });
  };

  return (
    <div
      className="rounded-xl border p-4"
      style={{ borderColor: 'var(--gold)', background: 'var(--space-3)' }}
    >
      <h4 className="text-[13px] font-bold tracking-[0.08em] text-gold">
        編輯訂單（{order.orderNo}）
      </h4>

      {/* 貨品行：數量 stepper + 移除 */}
      <ul className="mt-3 flex flex-col gap-2">
        {lines.map((l, idx) => (
          <li key={`${l.productId}|${l.size ?? ''}`} className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate text-txt-1">
              {l.productName}
              {l.size && <span className="ml-1.5 font-mono text-[12px] text-txt-3">{l.size}</span>}
              <span className="ml-1.5 font-mono text-[12px] text-txt-3">{fmtHKD(l.price)}</span>
            </span>
            <button
              type="button"
              aria-label="減少數量"
              onClick={() => setQty(idx, l.quantity - 1)}
              className="flex h-7 w-7 items-center justify-center rounded-full border text-txt-2 transition-colors hover:text-txt-1"
              style={{ borderColor: 'var(--space-line)' }}
            >
              −
            </button>
            <span className="w-6 text-center font-mono text-txt-1">{l.quantity}</span>
            <button
              type="button"
              aria-label="增加數量"
              onClick={() => setQty(idx, l.quantity + 1)}
              className="flex h-7 w-7 items-center justify-center rounded-full border text-txt-2 transition-colors hover:text-txt-1"
              style={{ borderColor: 'var(--space-line)' }}
            >
              ＋
            </button>
            <button
              type="button"
              aria-label="移除呢件貨"
              onClick={() => removeLine(idx)}
              className="ml-1 text-pink-soft transition-colors hover:text-pink"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {/* 加貨：揀商品（有尺寸再揀尺寸）→ 加入 */}
      <div
        className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3"
        style={{ borderColor: 'var(--space-line)' }}
      >
        <select
          value={addProductId ?? ''}
          onChange={(e) => {
            setAddProductId(e.target.value ? Number(e.target.value) : null);
            setAddSize('');
          }}
          aria-label="揀商品加入"
          className="h-9 max-w-full rounded-lg border bg-space-2 px-2 text-[13px] text-txt-1"
          style={{ borderColor: 'var(--space-line)' }}
        >
          <option value="">＋ 揀貨加入…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.sku}）{fmtHKD(p.discountPrice ?? p.price)}・存{p.stock}
            </option>
          ))}
        </select>
        {addSizes.length > 0 && (
          <select
            value={addSize || addSizes[0]}
            onChange={(e) => setAddSize(e.target.value)}
            aria-label="揀尺寸"
            className="h-9 rounded-lg border bg-space-2 px-2 font-mono text-[13px] text-txt-1"
            style={{ borderColor: 'var(--space-line)' }}
          >
            {addSizes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={handleAddLine}
          disabled={!addProduct}
          className="btn btn-secondary !px-4 !py-1.5 text-[12px] disabled:opacity-50"
        >
          加入
        </button>
      </div>

      {/* 折扣 / 實收（實收優先） */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <label className="flex items-center gap-1.5 text-txt-2">
          折扣 HK$
          <input
            type="number"
            min={0}
            value={discount}
            disabled={totalInput.trim() !== ''}
            onChange={(e) => setDiscount(e.target.value)}
            aria-label="折扣金額"
            className="h-9 w-24 rounded-lg border bg-space-2 px-2 font-mono text-txt-1 disabled:opacity-40"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </label>
        <label className="flex items-center gap-1.5 text-txt-2">
          實收 HK$
          <input
            type="number"
            min={0}
            value={totalInput}
            onChange={(e) => setTotalInput(e.target.value)}
            placeholder="（用折扣計）"
            aria-label="實收金額"
            className="h-9 w-28 rounded-lg border bg-space-2 px-2 font-mono text-txt-1 placeholder:text-txt-disabled"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </label>
        <span className="text-[12px] text-txt-3">填咗實收就佢話事，會自動計返折扣</span>
      </div>

      {/* 即時計數 */}
      <p className="mt-3 font-mono text-[13px] text-txt-2">
        貨品合計 {fmtHKD(subtotal)} − 折扣 {fmtHKD(effectiveDiscount)} ＝{' '}
        <span className="font-bold text-gold">實收 {fmtHKD(effectiveTotal)}</span>
      </p>

      {err && (
        <p role="alert" className="mt-2 text-[13px] text-pink-soft">
          {err}
        </p>
      )}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={update.isPending}
          onClick={handleSave}
          className="btn btn-primary !px-5 !py-2.5 text-[13px] disabled:opacity-60"
        >
          {update.isPending ? <WishingStar size={14} /> : null}
          儲存改動
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-secondary !px-5 !py-2.5 text-[13px]"
        >
          取消
        </button>
      </div>
    </div>
  );
}

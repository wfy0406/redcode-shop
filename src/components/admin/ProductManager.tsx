import { useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { PRODUCT_CATEGORIES, productCategoryLabel } from '@contracts/types';
import { fmtDate, fmtHKD } from './format';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 商品管理（簡單版）—— products.list / create / update（isActive toggle）/ remove
 * 注意：products.list 只回傳上架中商品；下架後重新載入會喺列表隱藏。
 */

const inputCls =
  'h-12 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

const initialForm = {
  name: '',
  sku: '',
  price: '',
  discountPrice: '',
  sizes: '',
  category: 'other',
  listedDate: new Date().toISOString().slice(0, 10),
  image: '/product-1.jpg',
  stock: '0',
  description: '',
};

export default function ProductManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const listQuery = trpc.products.list.useQuery(undefined);
  const [form, setForm] = useState(initialForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  const createMutation = trpc.products.create.useMutation({
    onSuccess: (created) => {
      toast(`已新增商品「${created?.name ?? ''}」`, 'success');
      setForm(initialForm);
      setFormError(null);
      void utils.products.list.invalidate();
    },
    onError: (err) => toast(err.message || '新增商品失敗', 'error'),
  });

  // isActive toggle：樂觀更新 cache，保持行可見（dim 顯示）
  const toggleMutation = trpc.products.update.useMutation({
    onMutate: async (vars) => {
      await utils.products.list.cancel();
      const prev = utils.products.list.getData(undefined);
      utils.products.list.setData(undefined, (old) =>
        old?.map((p) => (p.id === vars.id ? { ...p, isActive: vars.isActive ?? p.isActive } : p)),
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      utils.products.list.setData(undefined, ctx?.prev);
      toast(err.message || '更新失敗', 'error');
    },
    onSuccess: (updated) => {
      toast(updated?.isActive ? '已重新上架' : '已下架（重新載入後會喺列表隱藏）', 'success');
    },
  });

  const removeMutation = trpc.products.remove.useMutation({
    onSuccess: () => {
      toast('已刪除商品', 'info');
      setConfirmRemoveId(null);
      void utils.products.list.invalidate();
    },
    onError: (err) => toast(err.message || '刪除失敗', 'error'),
  });

  // 類別即時修改（列表行內 dropdown）
  const categoryMutation = trpc.products.update.useMutation({
    onSuccess: (updated) => {
      toast(`已將「${updated?.name ?? ''}」歸類做${productCategoryLabel(updated?.category)}`, 'success');
      void utils.products.list.invalidate();
    },
    onError: (err) => toast(err.message || '更新類別失敗', 'error'),
  });

  const set = (key: keyof typeof initialForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const price = Number.parseInt(form.price, 10);
    if (!form.name.trim() || !form.sku.trim()) {
      setFormError('品名同貨號必填');
      return;
    }
    if (!Number.isInteger(price) || price < 0) {
      setFormError('價錢要係 0 或以上嘅整數（HKD）');
      return;
    }
    const discount = form.discountPrice.trim() ? Number.parseInt(form.discountPrice, 10) : undefined;
    if (discount !== undefined && (!Number.isInteger(discount) || discount < 0)) {
      setFormError('折扣價要係正整數');
      return;
    }
    const stock = form.stock.trim() ? Number.parseInt(form.stock, 10) : 0;
    if (!Number.isInteger(stock) || stock < 0) {
      setFormError('庫存要係 0 或以上嘅整數');
      return;
    }
    setFormError(null);
    createMutation.mutate({
      name: form.name.trim(),
      sku: form.sku.trim(),
      price,
      discountPrice: discount,
      sizes: form.sizes.trim() || undefined,
      category: form.category,
      listedDate: form.listedDate ? new Date(`${form.listedDate}T00:00:00`) : undefined,
      image: form.image.trim() || '/product-1.jpg',
      stock,
      description: form.description.trim() || undefined,
    });
  };

  const products = listQuery.data ?? [];

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：新增商品表單（5） */}
      <form
        onSubmit={submit}
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-5"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          <Plus size={16} className="text-gold" aria-hidden="true" />
          新增商品
        </h3>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="np-name" className="mb-1.5 block text-[14px] text-txt-2">
              品名 *
            </label>
            <input
              id="np-name"
              value={form.name}
              onChange={(e) => set('name')(e.target.value)}
              className={inputCls}
              placeholder="例如：星空雪紡連身裙"
            />
          </div>
          <div>
            <label htmlFor="np-sku" className="mb-1.5 block text-[14px] text-txt-2">
              貨號 *
            </label>
            <input
              id="np-sku"
              value={form.sku}
              onChange={(e) => set('sku')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="RC-0001"
            />
          </div>
          <div>
            <label htmlFor="np-date" className="mb-1.5 block text-[14px] text-txt-2">
              上架日期
            </label>
            <input
              id="np-date"
              type="date"
              value={form.listedDate}
              onChange={(e) => set('listedDate')(e.target.value)}
              className={`${inputCls} font-mono`}
            />
          </div>
          <div>
            <label htmlFor="np-category" className="mb-1.5 block text-[14px] text-txt-2">
              類別 *
            </label>
            <select
              id="np-category"
              value={form.category}
              onChange={(e) => set('category')(e.target.value)}
              className={inputCls}
            >
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="np-price" className="mb-1.5 block text-[14px] text-txt-2">
              價錢 HKD *
            </label>
            <input
              id="np-price"
              inputMode="numeric"
              value={form.price}
              onChange={(e) => set('price')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="299"
            />
          </div>
          <div>
            <label htmlFor="np-discount" className="mb-1.5 block text-[14px] text-txt-2">
              折扣價（選填）
            </label>
            <input
              id="np-discount"
              inputMode="numeric"
              value={form.discountPrice}
              onChange={(e) => set('discountPrice')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="259"
            />
          </div>
          <div>
            <label htmlFor="np-sizes" className="mb-1.5 block text-[14px] text-txt-2">
              尺寸（逗號分隔，選填）
            </label>
            <input
              id="np-sizes"
              value={form.sizes}
              onChange={(e) => set('sizes')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="S,M,L"
            />
          </div>
          <div>
            <label htmlFor="np-stock" className="mb-1.5 block text-[14px] text-txt-2">
              庫存
            </label>
            <input
              id="np-stock"
              inputMode="numeric"
              value={form.stock}
              onChange={(e) => set('stock')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="10"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="np-image" className="mb-1.5 block text-[14px] text-txt-2">
              圖片路徑
            </label>
            <input
              id="np-image"
              value={form.image}
              onChange={(e) => set('image')(e.target.value)}
              className={`${inputCls} font-mono`}
              placeholder="/product-1.jpg"
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="np-desc" className="mb-1.5 block text-[14px] text-txt-2">
              描述（選填）
            </label>
            <textarea
              id="np-desc"
              value={form.description}
              onChange={(e) => set('description')(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-space-line bg-space-2 px-4 py-3 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink"
              placeholder="布料、剪裁、著身感…"
            />
          </div>
        </div>
        {formError && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-pink-soft" role="alert">
            <span
              className="inline-block h-2 w-2 rotate-45"
              style={{ background: 'var(--gold)' }}
              aria-hidden="true"
            />
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="btn btn-primary mt-5 w-full disabled:opacity-60"
        >
          {createMutation.isPending ? <WishingStar size={16} /> : <Plus size={16} aria-hidden="true" />}
          新增商品
        </button>
      </form>

      {/* 右：現有商品列表（7） */}
      <div className="xl:col-span-7">
        <h3 className="text-[16px] font-bold text-txt-1">
          現有商品
          <span className="ml-2 font-mono text-[13px] font-normal text-txt-3">
            {products.length} 款
          </span>
        </h3>
        {listQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊貨…" />
        ) : products.length === 0 ? (
          <p className="py-14 text-center text-[14px] text-txt-3">未有商品，左手邊新增第一款啦。</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {products.map((p) => {
              const lowStock = p.stock < 5;
              const removing = removeMutation.isPending && confirmRemoveId === p.id;
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border px-4 py-3.5"
                  style={{
                    borderColor: 'var(--space-line)',
                    background: 'var(--space-2)',
                    opacity: p.isActive ? 1 : 0.55,
                  }}
                >
                  <img
                    src={p.image}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-lg border object-cover"
                    style={{ borderColor: 'var(--glass-border)', background: 'var(--space-0)' }}
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold text-txt-1">{p.name}</p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      {p.sku} · 上架 {fmtDate(p.listedDate)}
                      {p.sizes ? ` · ${p.sizes}` : ''}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      {/* 類別 badge */}
                      <span
                        className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] text-lavender"
                        style={{
                          borderColor: 'var(--glass-border)',
                          background: 'var(--glass-bg)',
                        }}
                      >
                        {productCategoryLabel(p.category)}
                      </span>
                      {/* 行內改類別（即時 update） */}
                      <select
                        value={p.category}
                        disabled={categoryMutation.isPending}
                        onChange={(e) =>
                          categoryMutation.mutate({ id: p.id, category: e.target.value })
                        }
                        aria-label={`更改 ${p.name} 類別`}
                        className="h-7 rounded-lg border bg-space-2 px-2 font-mono text-[11px] text-txt-3 transition-colors focus:border-pink disabled:opacity-60"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        {PRODUCT_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>
                            改做：{c.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-[14px] text-pink">
                      {p.discountPrice != null ? fmtHKD(p.discountPrice) : fmtHKD(p.price)}
                      {p.discountPrice != null && (
                        <span className="ml-2 text-[12px] text-txt-3 line-through">
                          {fmtHKD(p.price)}
                        </span>
                      )}
                    </p>
                    <p
                      className="mt-0.5 font-mono text-[12px]"
                      style={{ color: lowStock ? 'var(--gold)' : 'var(--text-3)' }}
                    >
                      存貨 {p.stock}
                      {lowStock ? '（緊張）' : ''}
                    </p>
                  </div>
                  {/* isActive toggle */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={p.isActive}
                    aria-label={`${p.name} 上架狀態`}
                    disabled={toggleMutation.isPending}
                    onClick={() =>
                      toggleMutation.mutate({ id: p.id, isActive: !p.isActive })
                    }
                    className="relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60"
                    style={{
                      background: p.isActive ? 'var(--success)' : 'var(--space-4)',
                      borderColor: p.isActive ? 'var(--success)' : 'var(--space-line)',
                    }}
                  >
                    <span
                      className="absolute top-0.5 h-[18px] w-[18px] rounded-full transition-transform"
                      style={{
                        background: p.isActive ? 'var(--space-1)' : 'var(--text-3)',
                        transform: p.isActive ? 'translateX(22px)' : 'translateX(2px)',
                      }}
                      aria-hidden="true"
                    />
                  </button>
                  {/* 刪除（兩步確認） */}
                  {confirmRemoveId === p.id ? (
                    <button
                      type="button"
                      disabled={removing}
                      onClick={() =>
                        removeMutation.mutate(
                          { id: p.id },
                          { onError: () => setConfirmRemoveId(null) },
                        )
                      }
                      className="btn btn-primary shrink-0 !px-4 !py-2 text-[12px] disabled:opacity-60"
                    >
                      {removing ? <WishingStar size={13} /> : null}
                      確認刪除？
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(p.id)}
                      aria-label={`刪除 ${p.name}`}
                      className="btn btn-secondary shrink-0 !h-10 !w-10 !rounded-full !p-0"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

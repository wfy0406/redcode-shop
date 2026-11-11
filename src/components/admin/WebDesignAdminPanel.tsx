'use client';

/**
 * WebDesignAdminPanel —— 網頁設計服務後台（兩個 tab：「價錢及項目」／「訂單／留言」）
 *
 * 價錢及項目：全部基本價＋市場價、兩個方案文案（名稱/描述/重點列表）、每項
 *   名稱/說明/分類/價錢/市場價/requiredPlan/billing/active/selectable/sortOrder/priceNote
 *   可改；可新增自訂項目、逐項刪除（inline 確認，記入 deletedItemKeys 墓碑），
 *   setCatalog 一次過儲存。
 * 訂單／留言：訂單詳情＋正式訂單圖＋付款截圖批核（reviewProof）＋WMS retry；
 *   留言列表＋markInquiryHandled。
 * 手機可用：全部卡片式堆疊，唔用橫向表格。
 */
import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import {
  DEFAULT_WEB_DESIGN_CATALOG,
  WEB_DESIGN_PLANS,
  planLabel,
  type WebDesignCatalog,
  type WebDesignCatalogItem,
  type WebDesignPlanCopy,
} from '@contracts/webDesign';
import { wdApi, useWdUtils, type WdAdminOrderDto } from '@/components/web-design/api';
import {
  fmtHKD,
  orderStatusLabel,
  paymentStatusLabel,
} from '@/components/web-design/helpers';
import { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

const inputCls =
  'h-10 w-full rounded-lg border border-space-line bg-space-1 px-3 text-[13px] text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none';
const labelCls = 'mb-1 block text-[11px] text-txt-3';
const selectCls = inputCls;
const cardCls = 'rounded-xl border border-space-line bg-space-1 p-4';

type TabKey = 'catalog' | 'orders';

const BILLING_OPTS = [
  { value: 'one_off', label: '一次性' },
  { value: 'monthly', label: '每月' },
  { value: 'at_cost', label: '實報實銷' },
] as const;

const CATEGORY_OPTS = [
  { value: 'seo', label: 'SEO' },
  { value: 'feature', label: '功能' },
  { value: 'service', label: '服務' },
] as const;

/* ================= 價錢及項目 ================= */

/** 方案文案編輯卡：名稱／描述／重點列表（可逐條改、加、刪） */
function PlanCopyCard({
  title,
  copy,
  onChange,
}: {
  title: string;
  copy: WebDesignPlanCopy;
  onChange: (copy: WebDesignPlanCopy) => void;
}) {
  const patchPoint = (idx: number, value: string) => {
    const points = copy.points.slice();
    points[idx] = value;
    onChange({ ...copy, points });
  };
  const removePoint = (idx: number) => {
    onChange({ ...copy, points: copy.points.filter((_, i) => i !== idx) });
  };
  return (
    <div className={cardCls}>
      <h3 className="mb-3 text-[14px] font-bold text-txt-1">{title}</h3>
      <div className="grid gap-3">
        <div>
          <label className={labelCls}>方案名稱</label>
          <input className={inputCls} value={copy.name}
            onChange={(e) => onChange({ ...copy, name: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>方案描述</label>
          <textarea className="w-full rounded-lg border border-space-line bg-space-1 px-3 py-2 text-[13px] text-txt-1 focus:border-pink focus:outline-none"
            rows={2} value={copy.description}
            onChange={(e) => onChange({ ...copy, description: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>重點列表（逐條顯示喺方案卡）</label>
          <div className="grid gap-2">
            {copy.points.map((p, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input className={inputCls} value={p}
                  onChange={(e) => patchPoint(idx, e.target.value)} />
                <button
                  type="button"
                  aria-label={`刪除重點 ${idx + 1}`}
                  onClick={() => removePoint(idx)}
                  className="shrink-0 rounded-lg border border-pink px-3 py-2 text-[12px] text-pink-soft"
                >
                  刪除
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={copy.points.length >= 20}
            onClick={() => onChange({ ...copy, points: [...copy.points, ''] })}
            className="mt-2 rounded-lg border border-space-line px-3 py-1.5 text-[12px] text-txt-2 disabled:opacity-60"
          >
            ＋ 加重點
          </button>
        </div>
      </div>
    </div>
  );
}

function CatalogEditor({ toast }: { toast: (text: string, kind?: ToastKind) => void }) {
  const utils = useWdUtils();
  const catalogQuery = wdApi.adminCatalog.useQuery();
  const [draft, setDraft] = useState<WebDesignCatalog | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);

  // query 返嚟之後入 draft（本地編輯副本）
  useEffect(() => {
    if (catalogQuery.data && !draft) {
      setDraft(JSON.parse(JSON.stringify(catalogQuery.data)) as WebDesignCatalog);
    }
  }, [catalogQuery.data, draft]);

  const setCatalog = wdApi.setCatalog.useMutation({
    onSuccess: async () => {
      toast('已儲存價錢及項目 ✓', 'success');
      await utils.adminCatalog.invalidate();
      await utils.getCatalog.invalidate();
    },
    onError: (err) => toast(err.message || '儲存失敗', 'error'),
  });

  if (catalogQuery.isLoading || !draft) return <LoadingBlock />;
  if (catalogQuery.isError)
    return <p className="text-[13px] text-pink-soft">載入失敗：{catalogQuery.error?.message}</p>;

  const patchItem = (idx: number, patch: Partial<WebDesignCatalogItem>) => {
    setDraft((d) => {
      if (!d) return d;
      const items = d.items.slice();
      items[idx] = { ...items[idx], ...patch };
      return { ...d, items };
    });
  };

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const patchCopy = (field: 'frontOnlyCopy' | 'fullStackCopy') => (copy: WebDesignPlanCopy) => {
    setDraft((d) => (d ? { ...d, [field]: copy } : d));
  };

  /** 新增自訂項目：生成未用過嘅合法 key（custom_1、custom_2…），可即改晒所有欄 */
  const addItem = () => {
    setDraft((d) => {
      if (!d || d.items.length >= 200) return d;
      const used = new Set(d.items.map((i) => i.key));
      let n = 1;
      while (used.has(`custom_${n}`) || d.deletedItemKeys.includes(`custom_${n}`)) n += 1;
      const key = `custom_${n}`;
      const maxSort = d.items.reduce((m, i) => Math.max(m, i.sortOrder), 0);
      const item: WebDesignCatalogItem = {
        key,
        name: '新項目',
        description: '',
        category: 'feature',
        price: 0,
        marketPrice: 0,
        requiredPlan: 'front_only',
        billing: 'one_off',
        selectable: true,
        active: true,
        sortOrder: maxSort + 10,
        priceNote: '',
      };
      return { ...d, items: [...d.items, item] };
    });
  };

  /** 刪除項目：移出列表＋記入 deletedItemKeys 墓碑（儲存後唔會被預設補項復活） */
  const removeItem = (idx: number, key: string) => {
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        items: d.items.filter((_, i) => i !== idx),
        deletedItemKeys: d.deletedItemKeys.includes(key)
          ? d.deletedItemKeys
          : [...d.deletedItemKeys, key],
      };
    });
    setConfirmDeleteKey(null);
  };

  return (
    <div className="grid gap-4">
      {/* 基本價 */}
      <div className={cardCls}>
        <h3 className="mb-3 text-[14px] font-bold text-txt-1">基本價（後台可改，server 以此重新計價）</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label className={labelCls} htmlFor="wda-fo">只要前台（HK$）</label>
            <input id="wda-fo" type="number" min={0} className={inputCls}
              value={draft.frontOnlyPrice}
              onChange={(e) => setDraft({ ...draft, frontOnlyPrice: num(e.target.value) })} />
          </div>
          <div>
            <label className={labelCls} htmlFor="wda-fom">前台市場參考價</label>
            <input id="wda-fom" type="number" min={0} className={inputCls}
              value={draft.frontOnlyMarketPrice}
              onChange={(e) => setDraft({ ...draft, frontOnlyMarketPrice: num(e.target.value) })} />
          </div>
          <div>
            <label className={labelCls} htmlFor="wda-fs">前台＋後台（HK$）</label>
            <input id="wda-fs" type="number" min={0} className={inputCls}
              value={draft.fullStackPrice}
              onChange={(e) => setDraft({ ...draft, fullStackPrice: num(e.target.value) })} />
          </div>
          <div>
            <label className={labelCls} htmlFor="wda-fsm">全端市場參考價</label>
            <input id="wda-fsm" type="number" min={0} className={inputCls}
              value={draft.fullStackMarketPrice}
              onChange={(e) => setDraft({ ...draft, fullStackMarketPrice: num(e.target.value) })} />
          </div>
        </div>
      </div>

      {/* 方案文案（01／02 共用） */}
      <PlanCopyCard title="「只要前台」方案文案" copy={draft.frontOnlyCopy} onChange={patchCopy('frontOnlyCopy')} />
      <PlanCopyCard title="「前台＋後台」方案文案" copy={draft.fullStackCopy} onChange={patchCopy('fullStackCopy')} />

      {/* 逐項項目 */}
      {draft.items
        .map((it, idx) => ({ it, idx }))
        .sort((a, b) => a.it.sortOrder - b.it.sortOrder)
        .map(({ it, idx }) => (
          <div key={it.key} className={cardCls}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-space-2 px-2 py-0.5 text-[11px] text-txt-3">{it.key}</code>
              <label className="flex items-center gap-1 text-[12px] text-txt-2">
                <input type="checkbox" checked={it.active}
                  onChange={(e) => patchItem(idx, { active: e.target.checked })} />
                上架
              </label>
              <label className="flex items-center gap-1 text-[12px] text-txt-2">
                <input type="checkbox" checked={it.selectable}
                  onChange={(e) => patchItem(idx, { selectable: e.target.checked })} />
                可加入購物車
              </label>
              <span className="ml-auto flex items-center gap-1 text-[12px] text-txt-3">
                排序
                <input type="number" className="h-8 w-16 rounded-lg border border-space-line bg-space-1 px-2 text-[12px] text-txt-1"
                  value={it.sortOrder}
                  onChange={(e) => patchItem(idx, { sortOrder: num(e.target.value) })} />
              </span>
            </div>
            <div className="mb-3">
              {confirmDeleteKey === it.key ? (
                <span className="flex flex-wrap items-center gap-2 rounded-lg border border-pink bg-space-2 p-2 text-[12px] text-txt-2">
                  確定刪除「{it.name}」？儲存後會永久移除，客人唔再見到。
                  <button
                    type="button"
                    onClick={() => removeItem(idx, it.key)}
                    className="rounded-lg border border-pink bg-pink px-3 py-1.5 text-[12px] font-bold text-white"
                  >
                    確認刪除
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteKey(null)}
                    className="rounded-lg border border-space-line px-3 py-1.5 text-[12px] text-txt-2"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteKey(it.key)}
                  className="rounded-lg border border-pink px-3 py-1.5 text-[12px] text-pink-soft"
                >
                  刪除此項目
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className={labelCls}>名稱</label>
                <input className={inputCls} value={it.name}
                  onChange={(e) => patchItem(idx, { name: e.target.value })} />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className={labelCls}>價錢備註（priceNote）</label>
                <input className={inputCls} value={it.priceNote}
                  onChange={(e) => patchItem(idx, { priceNote: e.target.value })} />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>說明</label>
                <textarea className="w-full rounded-lg border border-space-line bg-space-1 px-3 py-2 text-[13px] text-txt-1 focus:border-pink focus:outline-none"
                  rows={2} value={it.description}
                  onChange={(e) => patchItem(idx, { description: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>分類</label>
                <select className={selectCls} value={it.category}
                  onChange={(e) => patchItem(idx, { category: e.target.value as WebDesignCatalogItem['category'] })}>
                  {CATEGORY_OPTS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>所需方案</label>
                <select className={selectCls} value={it.requiredPlan}
                  onChange={(e) => patchItem(idx, { requiredPlan: e.target.value as WebDesignCatalogItem['requiredPlan'] })}>
                  {WEB_DESIGN_PLANS.map((p) => (
                    <option key={p} value={p}>{planLabel(p)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>收費模式</label>
                <select className={selectCls} value={it.billing}
                  onChange={(e) => patchItem(idx, { billing: e.target.value as WebDesignCatalogItem['billing'] })}>
                  {BILLING_OPTS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>價錢 HK$</label>
                  <input type="number" min={0} className={inputCls} value={it.price}
                    onChange={(e) => patchItem(idx, { price: num(e.target.value) })} />
                </div>
                <div>
                  <label className={labelCls}>市場參考價</label>
                  <input type="number" min={0} className={inputCls} value={it.marketPrice}
                    onChange={(e) => patchItem(idx, { marketPrice: num(e.target.value) })} />
                </div>
              </div>
            </div>
          </div>
        ))}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={draft.items.length >= 200}
          onClick={addItem}
          className="rounded-xl border border-gold px-6 py-2.5 text-[13px] font-bold text-gold disabled:opacity-60"
        >
          ＋ 新增項目
        </button>
        <button
          type="button"
          disabled={setCatalog.isPending}
          onClick={() => setCatalog.mutate({ catalog: draft })}
          className="rounded-xl border border-pink bg-pink px-6 py-2.5 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {setCatalog.isPending ? '儲存緊…' : '儲存全部改動'}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(JSON.parse(JSON.stringify(DEFAULT_WEB_DESIGN_CATALOG)) as WebDesignCatalog);
            setConfirmDeleteKey(null);
          }}
          className="rounded-xl border border-space-line px-6 py-2.5 text-[13px] text-txt-2"
        >
          載入預設值（未儲存，會還原已刪項目）
        </button>
      </div>
      {draft.deletedItemKeys.length > 0 && (
        <p className="text-[12px] text-txt-3">
          已標記刪除（儲存後生效）：{draft.deletedItemKeys.join('、')}
        </p>
      )}
    </div>
  );
}

/* ================= 訂單 ================= */

function OrderCard({ order, toast, canReview }: { order: WdAdminOrderDto; toast: (t: string, k?: ToastKind) => void; canReview: boolean }) {
  const utils = useWdUtils();
  const [open, setOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');

  const refresh = async () => {
    await utils.adminOrders.invalidate();
  };

  const reviewProof = wdApi.reviewProof.useMutation({
    onSuccess: async (data, vars) => {
      const wmsFailed = vars.decision === 'approve' && data.wms && data.wms.status !== 'sent';
      toast(
        wmsFailed
          ? `截圖已批核，但 WMS 未同步：${data.wms?.error || '請稍後重試'}`
          : vars.decision === 'approve'
            ? '已批核截圖 ✓'
            : '已拒絕截圖',
        wmsFailed ? 'info' : vars.decision === 'approve' ? 'success' : 'info',
      );
      await refresh();
    },
    onError: (err) => toast(err.message || '操作失敗', 'error'),
  });

  const retryWms = wdApi.retryWms.useMutation({
    onSuccess: async (data) => {
      toast(
        data.wms.status === 'sent'
          ? '已重新送去 WMS ✓'
          : `WMS 未同步：${data.wms.error || '請稍後再試'}`,
        data.wms.status === 'sent' ? 'success' : 'error',
      );
      await refresh();
    },
    onError: (err) => toast(err.message || '重試失敗', 'error'),
  });

  return (
    <div className={cardCls}>
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="font-mono text-[14px] font-bold text-gold">{order.orderNo}</span>
        <span className="text-[12px] text-txt-2">{order.name}</span>
        <span className="rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-2">
          {planLabel(order.plan)}
        </span>
        <span className="rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-2">
          {orderStatusLabel(order.status)}
        </span>
        <span className="rounded-full border border-space-line px-2 py-0.5 text-[11px] text-txt-2">
          {paymentStatusLabel(order.paymentStatus)}
        </span>
        <span className="text-[12px] text-txt-3">{fmtHKD(order.total)}</span>
        {order.wmsError && (
          <span className="rounded-full border border-pink px-2 py-0.5 text-[11px] text-pink-soft">
            WMS 失敗
          </span>
        )}
        <ChevronDown
          size={16}
          className={`ml-auto text-txt-3 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="mt-3 grid gap-3 border-t border-space-line pt-3 text-[13px] text-txt-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            <span>電話：{order.phone}</span>
            <span>Email：{order.email ?? '—'}</span>
            <span>落單：{new Date(order.createdAt).toLocaleString('zh-HK')}</span>
            <span>一次性：{fmtHKD(order.oneOffTotal)}</span>
            <span>月費：{fmtHKD(order.monthlyTotal)}／月</span>
            <span>今次應付：{fmtHKD(order.total)}</span>
          </div>

          {order.items.length > 0 && (
            <p className="text-txt-3">
              項目：{order.items.map((it) => `${it.name} ${fmtHKD(it.price)}`).join('、')}
            </p>
          )}
          {order.requirements && <p>要求：{order.requirements}</p>}
          {order.styleNotes && <p>風格備註：{order.styleNotes}</p>}

          {/* WMS 狀態 */}
          <div className="rounded-lg border border-space-line bg-space-2 p-3">
            <p className="mb-1 text-[12px] font-bold text-txt-1">WMS 同步</p>
            <p className="text-[12px] text-txt-3">
              狀態：{order.wmsStatus ?? '—'}
              {order.wmsWebhookOrderId ? `｜WMS 單號：${order.wmsWebhookOrderId}` : ''}
            </p>
            {order.wmsError && (
              <p className="mt-1 text-[12px] text-pink-soft">{order.wmsError}</p>
            )}
            {(order.wmsError || !order.wmsStatus) && order.paymentStatus === 'paid' && order.status !== 'cancelled' && (
              <button
                type="button"
                disabled={retryWms.isPending}
                onClick={() => retryWms.mutate({ orderNo: order.orderNo })}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-gold px-3 py-1.5 text-[12px] text-gold disabled:opacity-60"
              >
                <RefreshCw size={13} aria-hidden="true" />
                {retryWms.isPending ? '重試緊…' : '重試 WMS 同步'}
              </button>
            )}
          </div>

          {/* 正式訂單圖 */}
          {order.orderImagePath ? (
            <div>
              <p className="mb-1 text-[12px] font-bold text-txt-1">正式訂單圖</p>
              <a href={order.orderImagePath} target="_blank" rel="noopener noreferrer">
                <img
                  src={order.orderImagePath}
                  alt={`訂單 ${order.orderNo} 正式訂單圖`}
                  className="max-h-56 rounded-lg border border-space-line"
                  loading="lazy"
                />
              </a>
            </div>
          ) : (
            <p className="text-[12px] text-pink-soft">⚠ 呢張單未有正式訂單圖</p>
          )}

          {/* 付款截圖批核 */}
          <div>
            <p className="mb-1 text-[12px] font-bold text-txt-1">
              付款截圖（{order.proofs.length}）
            </p>
            {order.proofs.length === 0 && <p className="text-[12px] text-txt-3">未有截圖。</p>}
            <div className="grid gap-2">
              {order.proofs.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-space-line p-2">
                  <a href={p.imagePath} target="_blank" rel="noopener noreferrer">
                    <img
                      src={p.imagePath}
                      alt={`訂單 ${order.orderNo} 付款截圖`}
                      className="h-16 w-16 rounded object-cover"
                      loading="lazy"
                    />
                  </a>
                  <span className="text-[12px] text-txt-3">
                    {new Date(p.createdAt).toLocaleString('zh-HK')}｜
                    {p.status === 'pending' ? '待審批' : p.status === 'approved' ? '已批核' : '已拒絕'}
                    {p.note ? `｜${p.note}` : ''}
                  </span>
                  {p.status === 'pending' && !canReview && (
                    <span className="ml-auto text-[12px] text-txt-3">等主管／管理員批核</span>
                  )}
                  {p.status === 'pending' && canReview && (
                    <span className="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={reviewProof.isPending}
                        onClick={() => reviewProof.mutate({ proofId: p.id, decision: 'approve' })}
                        className="rounded-lg border border-success px-3 py-1.5 text-[12px] text-success disabled:opacity-60"
                      >
                        批核
                      </button>
                      <input
                        type="text"
                        placeholder="拒絕原因（選填）"
                        value={rejectNote}
                        onChange={(e) => setRejectNote(e.target.value)}
                        className="h-8 w-36 rounded-lg border border-space-line bg-space-1 px-2 text-[12px] text-txt-1"
                      />
                      <button
                        type="button"
                        disabled={reviewProof.isPending}
                        onClick={() =>
                          reviewProof.mutate({
                            proofId: p.id,
                            decision: 'reject',
                            ...(rejectNote.trim() ? { note: rejectNote.trim() } : {}),
                          })
                        }
                        className="rounded-lg border border-pink px-3 py-1.5 text-[12px] text-pink-soft disabled:opacity-60"
                      >
                        拒絕
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= 訂單＋留言 tab ================= */

function OrdersAndInquiries({ toast, canReview }: { toast: (text: string, kind?: ToastKind) => void; canReview: boolean }) {
  const utils = useWdUtils();
  const ordersQuery = wdApi.adminOrders.useQuery(undefined, { staleTime: 15_000 });
  const inquiriesQuery = wdApi.adminInquiries.useQuery(undefined, { staleTime: 15_000 });

  const markHandled = wdApi.markInquiryHandled.useMutation({
    onSuccess: async () => {
      toast('已標記處理 ✓', 'success');
      await utils.adminInquiries.invalidate();
    },
    onError: (err) => toast(err.message || '操作失敗', 'error'),
  });

  return (
    <div className="grid gap-6">
      <section aria-label="網頁設計訂單">
        <h3 className="mb-2 text-[14px] font-bold text-txt-1">
          訂單（{ordersQuery.data?.length ?? 0}）
        </h3>
        {ordersQuery.isLoading && <LoadingBlock />}
        {ordersQuery.isError && (
          <p className="text-[13px] text-pink-soft">載入失敗：{ordersQuery.error?.message}</p>
        )}
        <div className="grid gap-3">
          {ordersQuery.data?.map((o) => <OrderCard key={o.orderNo} order={o} toast={toast} canReview={canReview} />)}
          {ordersQuery.data?.length === 0 && (
            <p className="text-[13px] text-txt-3">暫時未有網頁設計訂單。</p>
          )}
        </div>
      </section>

      <section aria-label="網頁設計留言">
        <h3 className="mb-2 text-[14px] font-bold text-txt-1">
          留言（{inquiriesQuery.data?.filter((i) => i.status !== 'handled').length ?? 0} 未處理）
        </h3>
        {inquiriesQuery.isLoading && <LoadingBlock />}
        <div className="grid gap-3">
          {inquiriesQuery.data?.map((iq) => (
            <div
              key={iq.id}
              className={cardCls}
              style={iq.status === 'handled' ? { opacity: 0.55 } : undefined}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                <span className="font-bold text-txt-1">{iq.name}</span>
                <span className="text-txt-2">{iq.phone}</span>
                {iq.email && <span className="text-txt-3">{iq.email}</span>}
                <span className="text-[12px] text-txt-3">
                  {new Date(iq.createdAt).toLocaleString('zh-HK')}
                </span>
                {iq.status !== 'handled' && (
                  <button
                    type="button"
                    disabled={markHandled.isPending}
                    onClick={() => markHandled.mutate({ id: iq.id })}
                    className="ml-auto rounded-lg border border-success px-3 py-1.5 text-[12px] text-success disabled:opacity-60"
                  >
                    標記已處理
                  </button>
                )}
                {iq.status === 'handled' && (
                  <span className="ml-auto text-[12px] text-txt-3">
                    已處理{iq.handledBy ? `（${iq.handledBy}）` : ''}
                    {iq.handledAt ? ` ${new Date(iq.handledAt).toLocaleString('zh-HK')}` : ''}
                  </span>
                )}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-[13px] text-txt-2">{iq.message}</p>
            </div>
          ))}
          {inquiriesQuery.data?.length === 0 && (
            <p className="text-[13px] text-txt-3">暫時未有留言。</p>
          )}
        </div>
      </section>
    </div>
  );
}

/* ================= 主面板 ================= */

export default function WebDesignAdminPanel({
  toast,
  canEditCatalog,
  canReview,
}: {
  toast: (text: string, kind?: ToastKind) => void;
  canEditCatalog: boolean;
  canReview: boolean;
}) {
  const [tab, setTab] = useState<TabKey>('orders');

  return (
    <div className="grid gap-4">
      <div className="flex gap-2" role="tablist" aria-label="網頁設計後台">
        {(
          [
            ['orders', '訂單／留言'],
            ...(canEditCatalog ? [['catalog', '價錢及項目'] as const] : []),
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-xl border px-4 py-2 text-[13px] font-bold transition-colors ${
              tab === key
                ? 'border-pink bg-pink text-white'
                : 'border-space-line text-txt-2 hover:border-pink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'catalog' && canEditCatalog ? (
        <CatalogEditor toast={toast} />
      ) : (
        <OrdersAndInquiries toast={toast} canReview={canReview} />
      )}
    </div>
  );
}

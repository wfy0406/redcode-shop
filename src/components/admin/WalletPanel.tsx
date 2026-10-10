import { useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  CircleDollarSign,
  Hourglass,
  Package,
  Search,
  Trash2,
  UserRound,
  Wallet,
  XCircle,
} from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { formatHKD } from '@/components/cart/format';
import Lightbox from './Lightbox';
import WishingStar from './WishingStar';

/**
 * v2.5.0（會員購物金）後台購金面板（2026-10-09 老闆指令）
 *
 * ─ 待批核充值單（staff+）：付款截圖放大睇 → 批准（入帳＋寄信）／拒絕（寫原因＋寄信）
 * ─ 最近充值紀錄（staff+）：全部狀態一覽；刪除紀錄限管理員
 *   （老闆 2026-10-11：「後台紀錄購物金充值要官網管理員先可以刪除」；刪紀錄唔會扣回已入帳購物金）
 * ─ 套票管理（supervisor/admin）：新增／改價／上下架／刪除
 *   （老闆 2026-10-11：「購物金套票管理，主管同管理員都要可以del翻」；有充值紀錄用過嘅套票後端會擋，只可以下架）
 * ─ 會員購物金查詢（supervisor/admin）：搜會員 → 餘額＋流水＋充值紀錄
 *   （老闆原話：「supervisor同admin要見到客戶既購物金餘額同記錄」）
 */

const TOPUP_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending_payment: { label: '待付款', cls: 'border-[color:var(--gold)] text-gold' },
  payment_review: { label: '待批核', cls: 'border-[color:var(--lavender)] text-lavender' },
  approved: { label: '已入帳', cls: 'border-[color:var(--success)] text-success' },
  rejected: { label: '已拒絕', cls: 'border-[color:var(--pink-soft)] text-pink-soft' },
  cancelled: { label: '已取消', cls: 'border-[color:var(--space-line)] text-txt-3' },
};

const CHANNEL_LABEL: Record<string, string> = {
  airwallex: '網上即時付款',
  manual: '手動過數截圖',
};

const LEDGER_TYPE_LABEL: Record<string, string> = {
  topup: '充值入帳',
  spend: '購物扣減',
  refund: '取消返還',
};

function fmtDT(iso: string): string {
  return new Date(iso).toLocaleString('zh-HK', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Hong_Kong',
  });
}

type ToastFn = (msg: string, type?: 'success' | 'info' | 'error') => void;

/* ─────────── 待批核／紀錄 ─────────── */

function TopupReviewList({ toast, isAdmin }: { toast: ToastFn; isAdmin: boolean }) {
  const utils = trpc.useUtils();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [noteById, setNoteById] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const pendingQuery = trpc.wallet.adminTopups.useQuery({ status: 'payment_review' });
  const allQuery = trpc.wallet.adminTopups.useQuery();
  const reviewTopup = trpc.wallet.reviewTopup.useMutation();
  // v2.5.5 第8版（老闆指令 2026-10-11）：充值紀錄刪除限官網管理員（後端 adminProcedure 強制）
  const deleteTopup = trpc.wallet.deleteTopup.useMutation();

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : '操作失敗，請再試');

  const onDeleteTopup = async (t: { id: number; topupNo: string; status: string }) => {
    const statusLabel = TOPUP_STATUS_META[t.status]?.label ?? t.status;
    if (
      !window.confirm(
        `確定刪除充值紀錄 ${t.topupNo}（${statusLabel}）？\n\n刪咗就攞唔返；會員嘅購物金餘額唔受影響（流水賬會保留），每筆刪除都會記落異動紀錄。`,
      )
    ) {
      return;
    }
    setBusyId(t.id);
    try {
      await deleteTopup.mutateAsync({ topupId: t.id });
      toast(`已刪除充值紀錄 ${t.topupNo}`, 'success');
      await utils.wallet.adminTopups.invalidate();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onReview = async (topupId: number, topupNo: string, approve: boolean) => {
    setBusyId(topupId);
    try {
      const note = noteById[topupId]?.trim() || undefined;
      const r = await reviewTopup.mutateAsync({ topupId, approve, note });
      toast(
        approve
          ? `已批准 ${topupNo}，購物金已入帳（會員最新餘額 HK$${r.balanceAfter ?? '—'}）${r.emailNote ?? ''}`
          : `已拒絕 ${topupNo}${r.emailNote ?? ''}`,
        approve ? 'success' : 'info',
      );
      setNoteById((prev) => ({ ...prev, [topupId]: '' }));
      await Promise.all([
        utils.wallet.adminTopups.invalidate(),
        utils.wallet.memberWallet.invalidate(),
      ]);
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const pending = pendingQuery.data ?? [];
  const all = allQuery.data ?? [];

  return (
    <>
      {/* 待批核 */}
      <section
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 font-serif-tc text-lg font-bold text-txt-1">
          <Hourglass size={17} aria-hidden="true" className="text-gold" />
          待批核充值單
          {pending.length > 0 && (
            <span className="rounded-full border border-gold px-2 py-0.5 font-mono text-[11px] text-gold">
              {pending.length}
            </span>
          )}
        </h3>
        {pendingQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <WishingStar size={24} spinning />
          </div>
        ) : pending.length === 0 ? (
          <p className="mt-4 text-[13px] text-txt-3">冇待批核嘅充值單。</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {pending.map((t) => (
              <div
                key={t.id}
                className="rounded-xl border p-4"
                style={{ borderColor: 'var(--gold)', background: 'var(--space-2)' }}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-[14px] font-bold text-txt-1">{t.topupNo}</p>
                    <p className="mt-1 text-[13px] text-txt-2">
                      {t.member ? `${t.member.name}（${t.member.phone}）` : `會員 #${t.id}`}
                      {t.member?.email && <span className="ml-1 text-txt-3">{t.member.email}</span>}
                    </p>
                    <p className="mt-1 text-[13px] text-txt-3">
                      「{t.label}」入帳 <b className="text-gold">{formatHKD(t.creditAmount)}</b>
                      　實付 <b className="text-txt-1">{formatHKD(t.price)}</b>
                      　{CHANNEL_LABEL[t.paymentChannel] ?? t.paymentChannel} · {fmtDT(t.createdAt)}
                    </p>
                  </div>
                  {t.proofImagePath && (
                    <button
                      type="button"
                      onClick={() => setLightboxSrc(t.proofImagePath)}
                      aria-label="放大付款截圖"
                      className="shrink-0 overflow-hidden rounded-lg border transition-colors hover:border-gold"
                      style={{ borderColor: 'var(--space-line)' }}
                    >
                      <img
                        src={t.proofImagePath}
                        alt={`充值單 ${t.topupNo} 付款截圖`}
                        className="h-20 w-20 object-cover"
                        loading="lazy"
                      />
                    </button>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={noteById[t.id] ?? ''}
                    onChange={(e) =>
                      setNoteById((prev) => ({ ...prev, [t.id]: e.target.value }))
                    }
                    placeholder="備註／拒絕原因（可留空）"
                    maxLength={500}
                    className="h-10 min-w-0 flex-1 rounded-xl border bg-transparent px-3.5 text-[13px] text-txt-1 placeholder:text-txt-3 focus:outline-none"
                    style={{ borderColor: 'var(--space-line)' }}
                  />
                  <button
                    type="button"
                    disabled={busyId === t.id}
                    onClick={() => void onReview(t.id, t.topupNo, true)}
                    className="btn btn-primary !px-4 !py-2 text-[13px]"
                  >
                    <BadgeCheck size={14} aria-hidden="true" />
                    批准入帳
                  </button>
                  <button
                    type="button"
                    disabled={busyId === t.id}
                    onClick={() => void onReview(t.id, t.topupNo, false)}
                    className="btn btn-secondary !px-4 !py-2 text-[13px]"
                  >
                    <XCircle size={14} aria-hidden="true" />
                    拒絕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 最近紀錄 */}
      <section
        className="mt-6 rounded-2xl border p-5 backdrop-blur-xl md:p-6"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 font-serif-tc text-lg font-bold text-txt-1">
          <CircleDollarSign size={17} aria-hidden="true" className="text-gold" />
          最近充值紀錄
        </h3>
        {allQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <WishingStar size={24} spinning />
          </div>
        ) : all.length === 0 ? (
          <p className="mt-4 text-[13px] text-txt-3">仲未有充值紀錄。</p>
        ) : (
          <div className="mt-4 flex flex-col gap-2.5">
            {all.slice(0, 30).map((t) => {
              const meta = TOPUP_STATUS_META[t.status] ?? {
                label: t.status,
                cls: 'border-[color:var(--space-line)] text-txt-3',
              };
              return (
                <div
                  key={t.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl border px-4 py-3"
                  style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2.5">
                      <span className="font-mono text-[13px] font-bold text-txt-1">{t.topupNo}</span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${meta.cls}`}>
                        {meta.label}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-txt-3">
                      {t.member ? `${t.member.name}（${t.member.phone}）` : '—'} · 「{t.label}」入帳{' '}
                      {formatHKD(t.creditAmount)} · 實付 {formatHKD(t.price)} · {fmtDT(t.createdAt)}
                      {t.reviewNote ? ` · 備註：${t.reviewNote}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {t.proofImagePath && (
                      <button
                        type="button"
                        onClick={() => setLightboxSrc(t.proofImagePath)}
                        className="text-[12px] text-lavender underline underline-offset-4"
                      >
                        睇截圖
                      </button>
                    )}
                    {/* v2.5.5 第8版：刪除充值紀錄限官網管理員（老闆指令 2026-10-11） */}
                    {isAdmin && (
                      <button
                        type="button"
                        disabled={busyId === t.id}
                        onClick={() => void onDeleteTopup(t)}
                        aria-label={`刪除充值紀錄 ${t.topupNo}`}
                        className="btn btn-secondary !px-3 !py-1.5 text-[12px]"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        刪除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

/* ─────────── 套票管理（supervisor/admin） ─────────── */

function PackageManager({ toast }: { toast: ToastFn }) {
  const utils = trpc.useUtils();
  const packagesQuery = trpc.wallet.adminPackages.useQuery();
  const upsert = trpc.wallet.upsertPackage.useMutation();
  // v2.5.5 第8版（老闆指令 2026-10-11）：「購物金套票管理，主管同管理員都要可以del翻」
  // 後端 supervisorProcedure 強制；有充值單用過嘅套票會被後端擋（保住紀錄），建議改用下架
  const deletePackage = trpc.wallet.deletePackage.useMutation();

  // 編輯中嘅套票（id → 草稿）；新增用 id=0 做 key
  const [drafts, setDrafts] = useState<
    Record<number, { label: string; creditAmount: string; price: string; sortOrder: string; isActive: boolean }>
  >({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : '儲存失敗，請再試');

  const startEdit = (id: number, label = '', creditAmount = '', price = '', sortOrder = '0', isActive = true) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: { label, creditAmount, price, sortOrder, isActive },
    }));
  };

  const onSave = async (id: number) => {
    const d = drafts[id];
    if (!d) return;
    const credit = Number(d.creditAmount);
    const price = Number(d.price);
    const sort = Number(d.sortOrder);
    if (!d.label.trim()) return toast('套票名唔可以留空', 'error');
    if (!Number.isInteger(credit) || credit <= 0) return toast('面額要係正整數港元', 'error');
    if (!Number.isInteger(price) || price <= 0) return toast('售價要係正整數港元', 'error');
    setBusyId(id);
    try {
      await upsert.mutateAsync({
        id: id > 0 ? id : undefined,
        label: d.label.trim(),
        creditAmount: credit,
        price,
        sortOrder: Number.isInteger(sort) && sort >= 0 ? sort : 0,
        isActive: d.isActive,
      });
      toast(id > 0 ? '套票已更新' : '套票已新增', 'success');
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await utils.wallet.adminPackages.invalidate();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (p: { id: number; label: string }) => {
    if (
      !window.confirm(
        `確定刪除套票「${p.label}」？\n\n刪咗就攞唔返，每筆刪除都會記落異動紀錄。\n如果呢個套票有充值單用過，後端會擋住唔准刪（保住紀錄）——嗰種情況請改用「下架」（唔剔上架），客人就睇唔到。`,
      )
    ) {
      return;
    }
    setBusyId(p.id);
    try {
      await deletePackage.mutateAsync({ id: p.id });
      toast(`已刪除套票「${p.label}」`, 'success');
      await utils.wallet.adminPackages.invalidate();
    } catch (err) {
      toast(errMsg(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const packages = packagesQuery.data ?? [];

  const renderEditor = (
    id: number,
    d: { label: string; creditAmount: string; price: string; sortOrder: string; isActive: boolean },
  ) => (
    <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
      <input
        type="text"
        value={d.label}
        onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, label: e.target.value } }))}
        placeholder="套票名（例：$1000 充值卡）"
        maxLength={64}
        aria-label="套票名"
        className="h-10 rounded-xl border bg-transparent px-3.5 text-[13px] text-txt-1 focus:outline-none lg:col-span-2"
        style={{ borderColor: 'var(--space-line)' }}
      />
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={d.creditAmount}
        onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, creditAmount: e.target.value } }))}
        placeholder="面額（入帳 HK$）"
        aria-label="面額"
        className="h-10 rounded-xl border bg-transparent px-3.5 font-mono text-[13px] text-txt-1 focus:outline-none"
        style={{ borderColor: 'var(--space-line)' }}
      />
      <input
        type="number"
        inputMode="numeric"
        min={1}
        value={d.price}
        onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, price: e.target.value } }))}
        placeholder="售價（收 HK$）"
        aria-label="售價"
        className="h-10 rounded-xl border bg-transparent px-3.5 font-mono text-[13px] text-txt-1 focus:outline-none"
        style={{ borderColor: 'var(--space-line)' }}
      />
      <div className="flex items-center gap-2.5">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={d.sortOrder}
          onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, sortOrder: e.target.value } }))}
          placeholder="排序"
          aria-label="排序（細嘅排先）"
          className="h-10 w-20 rounded-xl border bg-transparent px-3 font-mono text-[13px] text-txt-1 focus:outline-none"
          style={{ borderColor: 'var(--space-line)' }}
        />
        <label className="flex items-center gap-1.5 text-[12.5px] text-txt-2">
          <input
            type="checkbox"
            checked={d.isActive}
            onChange={(e) => setDrafts((p) => ({ ...p, [id]: { ...d, isActive: e.target.checked } }))}
          />
          上架
        </label>
        <button
          type="button"
          disabled={busyId === id}
          onClick={() => void onSave(id)}
          className="btn btn-primary ml-auto !px-4 !py-2 text-[13px]"
        >
          儲存
        </button>
      </div>
    </div>
  );

  return (
    <section
      className="mt-6 rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 font-serif-tc text-lg font-bold text-txt-1">
        <Package size={17} aria-hidden="true" className="text-gold" />
        套票管理
        <span className="text-[12px] font-normal text-txt-3">（主管／管理員專用）</span>
      </h3>
      {packagesQuery.isLoading ? (
        <div className="flex justify-center py-10">
          <WishingStar size={24} spinning />
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {packages.map((p) => {
            const d = drafts[p.id];
            return (
              <div
                key={p.id}
                className="rounded-xl border px-4 py-3"
                style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[13.5px] text-txt-1">
                    <b>{p.label}</b>
                    <span className="ml-2 font-mono text-[12.5px] text-txt-3">
                      面額 {formatHKD(p.creditAmount)} · 售價 {formatHKD(p.price)} · 排序 {p.sortOrder}
                    </span>
                    <span
                      className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] font-bold ${
                        p.isActive
                          ? 'border-[color:var(--success)] text-success'
                          : 'border-[color:var(--space-line)] text-txt-3'
                      }`}
                    >
                      {p.isActive ? '上架中' : '已下架'}
                    </span>
                  </p>
                  {!d && (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          startEdit(p.id, p.label, String(p.creditAmount), String(p.price), String(p.sortOrder), p.isActive)
                        }
                        className="btn btn-secondary !px-4 !py-1.5 text-[12.5px]"
                      >
                        編輯
                      </button>
                      <button
                        type="button"
                        disabled={busyId === p.id}
                        onClick={() => void onDelete(p)}
                        aria-label={`刪除套票 ${p.label}`}
                        className="btn btn-secondary !px-3 !py-1.5 text-[12.5px]"
                      >
                        <Trash2 size={13} aria-hidden="true" />
                        刪除
                      </button>
                    </div>
                  )}
                </div>
                {d && renderEditor(p.id, d)}
              </div>
            );
          })}

          {/* 新增套票 */}
          {drafts[0] ? (
            <div
              className="rounded-xl border border-dashed px-4 py-3"
              style={{ borderColor: 'var(--gold)' }}
            >
              <p className="text-[13px] font-bold text-gold">新增套票</p>
              {renderEditor(0, drafts[0])}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => startEdit(0)}
              className="btn btn-secondary mt-1 self-start !px-4 !py-2 text-[13px]"
            >
              ＋ 新增套票
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ─────────── 會員購物金查詢（supervisor/admin） ─────────── */

function MemberWalletLookup() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const searchQuery = trpc.members.list.useQuery(
    { q: debouncedQ },
    { enabled: debouncedQ.length > 0 },
  );
  const walletQuery = trpc.wallet.memberWallet.useQuery(
    { userId: selectedId ?? 0 },
    { enabled: selectedId !== null, retry: false },
  );

  const results = useMemo(
    () => (searchQuery.data ?? []).slice(0, 8),
    [searchQuery.data],
  );
  const wallet = walletQuery.data ?? null;

  return (
    <section
      className="mt-6 rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 font-serif-tc text-lg font-bold text-txt-1">
        <UserRound size={17} aria-hidden="true" className="text-gold" />
        會員購物金查詢
        <span className="text-[12px] font-normal text-txt-3">（主管／管理員專用）</span>
      </h3>

      <div className="relative mt-4 max-w-md">
        <label
          className="flex h-11 items-center gap-2 rounded-xl border px-4"
          style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
        >
          <Search size={15} className="shrink-0 text-txt-3" aria-hidden="true" />
          <input
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelectedId(null);
            }}
            placeholder="輸入會員名或電話搜尋"
            aria-label="搜尋會員"
            className="w-full bg-transparent text-[13.5px] text-txt-1 placeholder:text-txt-3 focus:outline-none"
          />
        </label>
        {debouncedQ && !selectedId && (
          <div
            className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border"
            style={{ borderColor: 'var(--glass-border)', background: 'var(--space-1)' }}
          >
            {searchQuery.isLoading ? (
              <p className="px-4 py-3 text-[13px] text-txt-3">搜尋緊…</p>
            ) : results.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-txt-3">搵唔到呢位會員。</p>
            ) : (
              results.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(m.id);
                    setQ(`${m.name}（${m.phone}）`);
                  }}
                  className="block w-full px-4 py-2.5 text-left text-[13px] text-txt-1 transition-colors hover:bg-space-3"
                >
                  {m.name} <span className="font-mono text-txt-3">{m.phone}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {selectedId !== null && (
        <div className="mt-5">
          {walletQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <WishingStar size={24} spinning />
            </div>
          ) : walletQuery.isError ? (
            <p role="alert" className="text-[13px] text-pink-soft">
              載入失敗：{walletQuery.error.message}
            </p>
          ) : wallet ? (
            <>
              <div
                className="inline-flex items-center gap-4 rounded-2xl border px-6 py-4"
                style={{ borderColor: 'var(--gold)', background: 'rgba(171,140,82,.08)' }}
              >
                <Wallet size={20} aria-hidden="true" className="text-gold" />
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-gold">
                    {wallet.member.name} 嘅購物金餘額
                  </p>
                  <p className="mt-1 font-serif-tc text-3xl font-bold text-starlight">
                    {formatHKD(wallet.member.storeCredit)}
                  </p>
                </div>
              </div>

              <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.24em] text-txt-3">
                流水賬（最近 100 條）
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {wallet.ledger.length === 0 ? (
                  <p className="text-[13px] text-txt-3">冇流水紀錄。</p>
                ) : (
                  wallet.ledger.map((l) => (
                    <div
                      key={l.id}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border px-4 py-2.5"
                      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                    >
                      <p className="text-[12.5px] text-txt-2">
                        {LEDGER_TYPE_LABEL[l.type] ?? l.type}
                        {l.note && <span className="ml-2 text-txt-3">{l.note}</span>}
                        <span className="ml-2 font-mono text-[11.5px] text-txt-3">{fmtDT(l.createdAt)}</span>
                      </p>
                      <span
                        className={`font-mono text-[13.5px] font-bold ${
                          l.amount >= 0 ? 'text-gold' : 'text-txt-2'
                        }`}
                      >
                        {l.amount >= 0 ? '+' : '−'}
                        {formatHKD(Math.abs(l.amount))}
                        <span className="ml-2 font-normal text-txt-3">
                          餘額 {formatHKD(l.balanceAfter)}
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>

              <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.24em] text-txt-3">
                充值紀錄（最近 50 條）
              </p>
              <div className="mt-2 flex flex-col gap-2">
                {wallet.topups.length === 0 ? (
                  <p className="text-[13px] text-txt-3">冇充值紀錄。</p>
                ) : (
                  wallet.topups.map((t) => {
                    const meta = TOPUP_STATUS_META[t.status] ?? {
                      label: t.status,
                      cls: 'border-[color:var(--space-line)] text-txt-3',
                    };
                    return (
                      <div
                        key={t.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-2.5"
                        style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                      >
                        <span className="font-mono text-[12.5px] font-bold text-txt-1">{t.topupNo}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${meta.cls}`}>
                          {meta.label}
                        </span>
                        <span className="text-[12.5px] text-txt-3">
                          「{t.label}」入帳 {formatHKD(t.creditAmount)} · 實付 {formatHKD(t.price)} ·{' '}
                          {fmtDT(t.createdAt)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* ─────────── 面板主體 ─────────── */

export default function WalletPanel({ toast }: { toast: ToastFn }) {
  const { user: me } = useAuth();
  const isSupervisorOrAdmin = me?.role === 'admin' || me?.role === 'supervisor';

  return (
    <div>
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-gold">Wallet Admin</p>
        <h2 className="mt-2 font-serif-tc text-2xl font-bold text-txt-1">購物金管理</h2>
        <p className="mt-1 text-[13px] text-txt-3">
          批核充值單（入帳即寄信畀會員）、管理套票、查會員餘額。購物金不設退款，只限官網商品。
        </p>
      </header>
      <div className="mt-6">
        <TopupReviewList toast={toast} isAdmin={me?.role === 'admin'} />
        {isSupervisorOrAdmin && (
          <>
            <PackageManager toast={toast} />
            <MemberWalletLookup />
          </>
        )}
      </div>
    </div>
  );
}

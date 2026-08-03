import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, Pencil, Search, Trash2, Users, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { fmtDate, fmtDateTime, fmtHKD } from './format';
import { LoadingBlock } from './WishingStar';
import StatusBadge from './StatusBadge';
import type { OrderStatus } from './types';
import type { ToastKind } from './useToasts';

/**
 * 會員列表（F-H，admin only）—— trpc.members.list
 * 2026-07-28 更新：
 * - 搜尋框：輸入名或電話即時篩（300ms debounce，server ilike 模糊對照）
 * - 表格加「地址」欄
 * - 撳任何一行彈出詳情：會員資料（名/電話/email/年齡/生日月份/地址/註冊日）＋訂單統計＋最近 10 張訂單
 * - 每行有刪除掣：有訂單嘅會員會喺確認對話框講明連訂單一併刪（後端 members.remove 把關）
 * 2026-08-03 更新：
 * - 詳情加「重設密碼」掣（員工＋管理員）：會員唔記得密碼時幫佢設新密碼，即時生效，
 *   新密碼要人手話返俾會員；動作記落操作日誌（member.resetPassword）
 * 2026-08-04 更新（Glo 要求）：
 * - 列表用顏色 badge 標示會員有冇連結 Google（綠＝已連結，灰＝未連結）
 * - 會員詳情加 Google 連結狀態＋Google Email＋Google 名稱
 */

/** membersRouter 未 merge 前嘅本地型別（同 spec §B4 契約一致） */
type MemberRow = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  birthMonth: number | null;
  createdAt: Date | string;
  googleLinked: boolean;
  orderCount: number;
  totalSpent: number;
};

type MemberDetail = {
  user: {
    id: number;
    name: string;
    phone: string;
    email: string | null;
    address: string | null;
    age: number | null;
    birthMonth: number | null;
    role: string;
    createdAt: Date | string;
    googleLinked: boolean;
    googleEmail: string | null;
    googleName: string | null;
  };
  orderCount: number;
  totalSpent: number;
  recentOrders: {
    id: number;
    orderNo: string;
    status: OrderStatus;
    total: number;
    deliveryMethod: string;
    createdAt: Date | string;
  }[];
};

const DELIVERY_TEXT: Record<string, string> = {
  address: '送貨上門',
  sf_station: '順豐站自取',
  sf_locker: '順豐智能櫃',
};

/**
 * Google 連結狀態 badge（2026-08-04 Glo 要求：列表顏色標示）
 * 綠（--success #5EE0A0）＝已連結；灰＝未連結
 */
function GoogleBadge({ linked }: { linked: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={
        linked
          ? {
              borderColor: 'var(--success)',
              color: 'var(--success)',
              background: 'rgba(94, 224, 160, 0.12)',
            }
          : { borderColor: 'var(--space-line)', color: 'var(--text-3)' }
      }
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: linked ? 'var(--success)' : 'currentColor' }}
        aria-hidden="true"
      />
      {linked ? '已連結 Google' : '未連結 Google'}
    </span>
  );
}

/** members.update 契約（2026-07-29）：淨係傳有改嘅欄；null＝清除 */
type MemberUpdateInput = {
  id: number;
  name?: string;
  phone?: string;
  email?: string | null;
  address?: string | null;
  age?: number | null;
  birthMonth?: number | null;
};

/**
 * 修改會員資料表單（員工＋管理員用）——名/電話/Email/地址/年齡/生日月份
 * 留空嘅 Email/地址/年齡/生日月份會當清除（傳 null）
 */
function MemberEditForm({
  user,
  busy,
  onCancel,
  onSave,
}: {
  user: MemberDetail['user'];
  busy: boolean;
  onCancel: () => void;
  onSave: (input: MemberUpdateInput) => void;
}) {
  const [name, setName] = useState(user.name);
  const [phone, setPhone] = useState(user.phone);
  const [email, setEmail] = useState(user.email ?? '');
  const [address, setAddress] = useState(user.address ?? '');
  const [age, setAge] = useState(user.age != null ? String(user.age) : '');
  const [birthMonth, setBirthMonth] = useState(
    user.birthMonth != null ? String(user.birthMonth) : '',
  );
  const [formError, setFormError] = useState<string | null>(null);

  const inputCls =
    'h-10 w-full rounded-lg border border-space-line bg-space-1 px-3 text-[13px] text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none';
  const labelCls = 'mb-1 block text-[11px] text-txt-3';

  const submit = () => {
    if (!name.trim()) return setFormError('名稱必填');
    const phoneDigits = phone.replace(/[\s-]/g, '');
    if (!/^\d{8,}$/.test(phoneDigits)) return setFormError('電話要至少 8 位數字');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setFormError('Email 格式唔啱');
    let ageNum: number | null = null;
    if (age.trim()) {
      const n = Number(age);
      if (!Number.isInteger(n) || n < 0 || n > 150)
        return setFormError('年齡要係 0–150 嘅整數');
      ageNum = n;
    }
    setFormError(null);
    onSave({
      id: user.id,
      name: name.trim(),
      phone: phoneDigits,
      email: email.trim() || null,
      address: address.trim() || null,
      age: ageNum,
      birthMonth: birthMonth ? Number(birthMonth) : null,
    });
  };

  return (
    <div
      className="mt-2 rounded-xl border p-3"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`me-name-${user.id}`}>
            名稱
          </label>
          <input
            id={`me-name-${user.id}`}
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`me-phone-${user.id}`}>
            電話（登入帳號）
          </label>
          <input
            id={`me-phone-${user.id}`}
            className={inputCls}
            value={phone}
            inputMode="tel"
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`me-email-${user.id}`}>
            Email（留空＝清除）
          </label>
          <input
            id={`me-email-${user.id}`}
            className={inputCls}
            value={email}
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor={`me-address-${user.id}`}>
            地址（留空＝清除）
          </label>
          <textarea
            id={`me-address-${user.id}`}
            rows={2}
            className="w-full rounded-lg border border-space-line bg-space-1 px-3 py-2 text-[13px] leading-relaxed text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`me-age-${user.id}`}>
            年齡（留空＝清除）
          </label>
          <input
            id={`me-age-${user.id}`}
            className={inputCls}
            value={age}
            inputMode="numeric"
            onChange={(e) => setAge(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`me-bm-${user.id}`}>
            生日月份
          </label>
          <select
            id={`me-bm-${user.id}`}
            className={inputCls}
            value={birthMonth}
            onChange={(e) => setBirthMonth(e.target.value)}
          >
            <option value="">留空</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={String(i + 1)}>
                {i + 1} 月
              </option>
            ))}
          </select>
        </div>
      </div>
      {formError && <p className="mt-2 text-[12px] text-pink-soft">{formError}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="btn btn-primary !px-4 !py-2 text-[13px] disabled:opacity-50"
        >
          {busy ? '儲存緊…' : '儲存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn btn-secondary !px-4 !py-2 text-[13px]"
        >
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 幫會員重設密碼表單（員工＋管理員，2026-08-03 加）
 * 唔使舊密碼；新密碼至少 6 位、要輸入兩次確認；成功後要人手話返俾會員知
 */
function ResetPasswordForm({
  user,
  busy,
  onCancel,
  onSave,
}: {
  user: MemberDetail['user'];
  busy: boolean;
  onCancel: () => void;
  onSave: (newPassword: string) => void;
}) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const inputCls =
    'h-10 w-full rounded-lg border border-space-line bg-space-1 px-3 text-[13px] text-txt-1 placeholder:text-txt-3 focus:border-pink focus:outline-none';
  const labelCls = 'mb-1 block text-[11px] text-txt-3';

  const submit = () => {
    if (pw.length < 6) return setFormError('新密碼至少 6 位');
    if (pw2 !== pw) return setFormError('兩次密碼唔一致，請再確認');
    setFormError(null);
    onSave(pw);
  };

  return (
    <div
      className="mt-2 rounded-xl border p-3"
      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
    >
      <p className="mb-2.5 text-[12px] leading-relaxed text-txt-3">
        幫「{user.name}」設個新密碼，即時生效，舊密碼唔使輸入。
        <span className="text-gold">記得將新密碼話返俾會員</span>
        ；佢登入之後可以喺會員中心自己再改。
      </p>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`rp-pw-${user.id}`}>
            新密碼（至少 6 位）
          </label>
          <input
            id={`rp-pw-${user.id}`}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor={`rp-pw2-${user.id}`}>
            確認新密碼
          </label>
          <input
            id={`rp-pw2-${user.id}`}
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
        </div>
      </div>
      {formError && <p className="mt-2 text-[12px] text-pink-soft">{formError}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="btn btn-primary !px-4 !py-2 text-[13px] disabled:opacity-50"
        >
          {busy ? '重設緊…' : '確認重設'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="btn btn-secondary !px-4 !py-2 text-[13px]"
        >
          取消
        </button>
      </div>
    </div>
  );
}

export default function MemberList({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const utils = trpc.useUtils();
  const { user: me } = useAuth();
  // 刪除會員仍然係最高管理員專用（後端 members.remove 係 adminProcedure）；
  // 員工可以睇同改，唔可以刪
  const canDelete = me?.role === 'admin';
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);

  // 打字停 300ms 先出搜尋請求，唔會每個字打一次
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const listQuery = trpc.members.list.useQuery(
    debouncedQ ? { q: debouncedQ } : undefined,
  );
  const members = useMemo(() => (listQuery.data ?? []) as MemberRow[], [listQuery.data]);

  const detailQuery = trpc.members.detail.useQuery(
    { id: selectedId ?? 0 },
    { enabled: selectedId !== null },
  );

  // Esc 閂詳情
  useEffect(() => {
    if (selectedId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  const removeMutation = trpc.members.remove.useMutation({
    onSuccess: (result) => {
      toast(
        result?.deletedOrders
          ? `已刪除會員（連埋 ${result.deletedOrders} 張訂單）`
          : '已刪除會員',
        'success',
      );
      setSelectedId(null);
      void utils.members.list.invalidate();
      void utils.analytics.summary.invalidate();
    },
    onError: (err) => toast(err.message || '刪除會員失敗', 'error'),
  });

  const updateMutation = trpc.members.update.useMutation({
    onSuccess: () => {
      toast('已儲存會員資料 ✓', 'success');
      setEditingId(null);
      void utils.members.list.invalidate();
      void utils.members.detail.invalidate();
    },
    onError: (err) => toast(err.message || '儲存失敗，請再試', 'error'),
  });

  const resetPwMutation = trpc.members.resetPassword.useMutation({
    onSuccess: () => {
      toast('已重設會員密碼 ✓ 記得將新密碼話返俾會員', 'success');
      setResettingId(null);
    },
    onError: (err) => toast(err.message || '重設密碼失敗，請再試', 'error'),
  });

  // 換咗第二個會員，順手閂返編輯同重設密碼表單
  useEffect(() => {
    setEditingId(null);
    setResettingId(null);
  }, [selectedId]);

  const askDelete = (m: MemberRow) => {
    const withOrders = m.orderCount > 0;
    const msg = withOrders
      ? `會員「${m.name}」有 ${m.orderCount} 張訂單。\n\n確定連埋訂單一併刪除？呢個操作唔可以復原。`
      : `確定刪除會員「${m.name}」？呢個操作唔可以復原。`;
    if (!window.confirm(msg)) return;
    removeMutation.mutate(withOrders ? { id: m.id, alsoDeleteOrders: true } : { id: m.id });
  };

  const detail = detailQuery.data as MemberDetail | undefined;

  return (
    <section
      className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
      style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
    >
      <h3 className="flex items-center gap-2 text-[15px] font-bold text-txt-1">
        <Users size={16} aria-hidden="true" className="text-lavender" />
        會員
        {!listQuery.isLoading && !listQuery.isError && (
          <span className="font-mono text-[13px] font-normal text-txt-3">
            （{members.length}
            {debouncedQ ? ' 個結果' : ''}）
          </span>
        )}
      </h3>

      {/* 搜尋：名或電話 */}
      <div className="relative mt-3">
        <Search
          size={15}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-txt-3"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="輸入名或電話搜尋…"
          aria-label="搜尋會員（名或電話）"
          className="w-full rounded-xl border bg-transparent py-2 pl-9 pr-9 text-[14px] text-txt-1 outline-none transition-colors placeholder:text-txt-3 focus:border-lavender"
          style={{ borderColor: 'var(--space-line)' }}
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ('')}
            aria-label="清除搜尋"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-txt-3 transition-colors hover:text-txt-1"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {listQuery.isLoading ? (
        <LoadingBlock text="許願星搬緊會員名單…" />
      ) : listQuery.isError ? (
        <p className="py-8 text-center text-[14px] text-pink-soft">
          載入會員失敗：{listQuery.error.message}
        </p>
      ) : members.length === 0 ? (
        <p className="py-8 text-center text-[14px] text-txt-3">
          {debouncedQ ? `搵唔到名或電話有「${debouncedQ}」嘅會員。` : '暫時冇會員。'}
        </p>
      ) : (
        <>
          {/* 手機/平板版：卡片式列表（2026-07-29 修復——舊表格喺手機四欄逼埋，名淨係睇到一個字；
              同日起用 lg 分界：1024px 以下都用卡片，平板/窄電腦唔再逼表格） */}
          <ul className="mt-4 flex flex-col gap-2 lg:hidden">
            {members.map((m) => (
              <li
                key={m.id}
                onClick={() => setSelectedId((cur) => (cur === m.id ? null : m.id))}
                className="cursor-pointer rounded-xl border px-4 py-3 transition-colors hover:bg-white/5"
                style={{
                  borderColor: selectedId === m.id ? 'var(--gold)' : 'var(--space-line)',
                  background: 'var(--space-2)',
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[15px] font-bold leading-[1.4] text-txt-1">{m.name}</p>
                    <p className="mt-0.5 font-mono text-[13px] text-txt-2">{m.phone}</p>
                    {/* Google 連結狀態（2026-08-04）：綠＝已連結，灰＝未連結 */}
                    <div className="mt-1.5">
                      <GoogleBadge linked={m.googleLinked} />
                    </div>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        askDelete(m);
                      }}
                      disabled={removeMutation.isPending}
                      aria-label={`刪除會員 ${m.name}`}
                      className="-mr-1.5 -mt-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-50"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  )}
                </div>
                {m.email && (
                  <p className="mt-1 break-all font-mono text-[12px] text-txt-3">{m.email}</p>
                )}
                {m.address && (
                  <p className="mt-1 text-[12px] leading-[1.5] text-txt-3">地址：{m.address}</p>
                )}
                <p className="mt-1.5 font-mono text-[12px] text-txt-3">
                  {m.birthMonth != null && <>生日 {m.birthMonth} 月 · </>}
                  註冊 {fmtDate(m.createdAt)} · 訂單 {m.orderCount} · 累計{' '}
                  <span className="text-pink">{fmtHKD(m.totalSpent)}</span>
                </p>

                {/* 撳邊張卡，詳情即場喺嗰張卡下面展開（2026-07-29：取代彈窗，唔再「彈去第二度」） */}
                {selectedId === m.id && (
                  <div
                    className="mt-3 border-t pt-3"
                    style={{ borderColor: 'var(--space-line)' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {detailQuery.isLoading ? (
                      <LoadingBlock text="許願星搬緊會員資料…" />
                    ) : detailQuery.isError ? (
                      <p className="text-[12px] text-pink-soft">
                        載入失敗：{detailQuery.error.message}
                      </p>
                    ) : detail ? (
                      <>
                        <p className="text-[12px] text-txt-3">
                          年齡：<span className="text-txt-2">{detail.user.age ?? '—'}</span>
                        </p>
                        <p className="mt-1 text-[12px] text-txt-3">
                          生日月份：
                          <span className="text-txt-2">
                            {detail.user.birthMonth ? `${detail.user.birthMonth} 月` : '—'}
                          </span>
                        </p>
                        {/* Google 連結資料（2026-08-04）：已連結先顯示 Google 名稱＋Email */}
                        <p className="mt-1 text-[12px] text-txt-3">
                          Google：
                          {detail.user.googleLinked ? (
                            <span className="font-medium" style={{ color: 'var(--success)' }}>
                              已連結
                            </span>
                          ) : (
                            <span className="text-txt-2">未連結</span>
                          )}
                        </p>
                        {detail.user.googleLinked && (
                          <>
                            <p className="mt-1 text-[12px] text-txt-3">
                              Google 名稱：
                              <span className="text-txt-2">{detail.user.googleName || '—'}</span>
                            </p>
                            <p className="mt-1 break-all text-[12px] text-txt-3">
                              Google Email：
                              <span className="font-mono text-txt-2">
                                {detail.user.googleEmail || '—'}
                              </span>
                            </p>
                          </>
                        )}
                        {/* 修改資料／重設密碼（員工＋管理員） */}
                        {editingId === m.id ? (
                          <MemberEditForm
                            user={detail.user}
                            busy={updateMutation.isPending}
                            onCancel={() => setEditingId(null)}
                            onSave={(input) => updateMutation.mutate(input)}
                          />
                        ) : resettingId === m.id ? (
                          <ResetPasswordForm
                            user={detail.user}
                            busy={resetPwMutation.isPending}
                            onCancel={() => setResettingId(null)}
                            onSave={(newPassword) =>
                              resetPwMutation.mutate({ id: m.id, newPassword })
                            }
                          />
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(m.id);
                                setResettingId(null);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-txt-2 transition-colors hover:text-txt-1"
                              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                            >
                              <Pencil size={13} aria-hidden="true" /> 修改資料
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setResettingId(m.id);
                                setEditingId(null);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-txt-2 transition-colors hover:text-txt-1"
                              style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                            >
                              <KeyRound size={13} aria-hidden="true" /> 重設密碼
                            </button>
                          </div>
                        )}
                        <h5 className="mt-3 text-[11px] font-bold tracking-[0.08em] text-gold">
                          最近訂單（最多 10 張）
                        </h5>
                        {detail.recentOrders.length === 0 ? (
                          <p className="mt-1.5 text-[12px] text-txt-3">暫時冇訂單。</p>
                        ) : (
                          <ul className="mt-1 flex flex-col">
                            {detail.recentOrders.map((o) => (
                              <li
                                key={o.id}
                                className="flex items-center gap-2 border-t py-2 text-[12px]"
                                style={{ borderColor: 'var(--space-line)' }}
                              >
                                <span className="font-mono text-txt-1">{o.orderNo}</span>
                                <span className="text-[11px] text-txt-3">
                                  {DELIVERY_TEXT[o.deliveryMethod] ?? o.deliveryMethod}
                                </span>
                                <span className="ml-auto flex items-center gap-1.5">
                                  <StatusBadge status={o.status} />
                                  <span className="font-mono text-pink">{fmtHKD(o.total)}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-2 text-[11px] text-txt-3">再撳一下呢張卡收起詳情。</p>
                      </>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-txt-3 lg:hidden">撳任何一個會員，詳情即場喺嗰張卡下面展開。</p>

          {/* 桌面版（lg+）：表格。名欄唔截斷（whitespace-nowrap），太窄可以左右碌 */}
          <div className="mt-4 hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[880px] border-collapse text-[14px]">
            <thead>
              <tr
                className="border-b text-left text-[12px] text-txt-3"
                style={{ borderColor: 'var(--space-line)' }}
              >
                <th className="py-2 pr-3 font-normal">名</th>
                <th className="py-2 pr-3 font-normal">電話</th>
                <th className="py-2 pr-3 font-normal">Email</th>
                <th className="py-2 pr-3 font-normal">Google</th>
                <th className="py-2 pr-3 font-normal">地址</th>
                <th className="py-2 pr-3 font-normal">生日月份</th>
                <th className="py-2 pr-3 font-normal">註冊日期</th>
                <th className="w-16 py-2 pr-3 text-right font-normal">訂單數</th>
                <th className="w-28 py-2 text-right font-normal">累計消費</th>
                {canDelete && <th className="w-14 py-2 pl-3 text-right font-normal">刪除</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className="cursor-pointer border-b transition-colors last:border-0 hover:bg-white/5"
                  style={{ borderColor: 'var(--space-line)' }}
                >
                  <td className="whitespace-nowrap py-2.5 pr-4 font-medium text-txt-1">{m.name}</td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-2">{m.phone}</td>
                  <td className="max-w-0 truncate py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {m.email || '—'}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3">
                    <GoogleBadge linked={m.googleLinked} />
                  </td>
                  <td className="max-w-[140px] truncate py-2.5 pr-3 text-[13px] text-txt-3">
                    {m.address || '—'}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-[13px] text-txt-2">
                    {m.birthMonth != null ? `${m.birthMonth} 月` : '—'}
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[13px] text-txt-3">
                    {fmtDate(m.createdAt)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-[13px] text-txt-2">
                    {m.orderCount}
                  </td>
                  <td className="py-2.5 text-right font-mono text-[13px] text-pink">
                    {fmtHKD(m.totalSpent)}
                  </td>
                  <td className="py-2.5 pl-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        askDelete(m);
                      }}
                      disabled={removeMutation.isPending}
                      aria-label={`刪除會員 ${m.name}`}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-txt-3 transition-colors hover:text-pink-soft disabled:opacity-50"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[12px] text-txt-3">撳任何一行睇詳細資料。</p>
          </div>
        </>
      )}

      {/* 會員詳情彈窗（只限電腦版 lg+；手機/平板用卡片即場展開，詳情出喺你撳嘅位置）
          2026-07-29 走位修復：MemberList 嘅 <section> 有 backdrop-blur，會令 position:fixed
          以佢做定位基準 → 碌落下面撳會員，彈窗「彈咗去上面」。用 createPortal 直掛
          document.body，fixed 就實以瀏覽器視窗置中，撳邊行都喺你眼前出現。 */}
      {selectedId !== null &&
        createPortal(
          <div
            className="fixed inset-0 z-50 hidden h-dvh items-center justify-center bg-black/60 p-4 backdrop-blur-sm lg:flex"
          onClick={() => setSelectedId(null)}
          role="dialog"
          aria-modal="true"
          aria-label="會員詳細資料"
        >
          <div
            className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5"
            style={{ borderColor: 'var(--gold)', background: 'var(--space-1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {detailQuery.isLoading ? (
              <LoadingBlock text="許願星搬緊會員資料…" />
            ) : detailQuery.isError ? (
              <p className="py-8 text-center text-[14px] text-pink-soft">
                載入失敗：{detailQuery.error.message}
              </p>
            ) : detail ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[17px] font-bold text-txt-1">{detail.user.name}</h4>
                    <p className="mt-0.5 font-mono text-[13px] text-txt-3">
                      {detail.user.phone}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="關閉"
                    className="rounded-lg p-1.5 text-txt-3 transition-colors hover:text-txt-1"
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>

                {/* 基本資料（手機一行一項，唔再兩欄逼到「累計 HK$」斷行） */}
                <div className="mt-4 grid grid-cols-1 gap-y-2.5 text-[13px] sm:grid-cols-2 sm:gap-x-4">
                  <p className="text-txt-3">
                    Email：
                    <span className="break-all font-mono text-txt-2">{detail.user.email || '—'}</span>
                  </p>
                  <p className="text-txt-3">
                    年齡：<span className="text-txt-2">{detail.user.age ?? '—'}</span>
                  </p>
                  <p className="text-txt-3">
                    生日月份：
                    <span className="text-txt-2">
                      {detail.user.birthMonth ? `${detail.user.birthMonth} 月` : '—'}
                    </span>
                  </p>
                  <p className="text-txt-3">
                    註冊：
                    <span className="font-mono text-txt-2">{fmtDate(detail.user.createdAt)}</span>
                  </p>
                  <p className="col-span-full text-txt-3">
                    訂單數：
                    <span className="font-mono text-txt-2">{detail.orderCount}</span>
                    <span className="ml-3">累計：</span>
                    <span className="whitespace-nowrap font-mono text-pink">
                      {fmtHKD(detail.totalSpent)}
                    </span>
                  </p>
                  <p className="col-span-full text-txt-3">
                    地址：
                    <span className="whitespace-pre-wrap text-txt-1">
                      {detail.user.address || '—'}
                    </span>
                  </p>
                  {/* Google 連結資料（2026-08-04）：已連結先顯示 Google 名稱＋Email */}
                  <p className="col-span-full text-txt-3">
                    Google：
                    {detail.user.googleLinked ? (
                      <span className="font-medium" style={{ color: 'var(--success)' }}>
                        已連結
                      </span>
                    ) : (
                      <span className="text-txt-2">未連結</span>
                    )}
                  </p>
                  {detail.user.googleLinked && (
                    <>
                      <p className="col-span-full text-txt-3">
                        Google 名稱：
                        <span className="text-txt-2">{detail.user.googleName || '—'}</span>
                      </p>
                      <p className="col-span-full break-all text-txt-3">
                        Google Email：
                        <span className="font-mono text-txt-2">
                          {detail.user.googleEmail || '—'}
                        </span>
                      </p>
                    </>
                  )}
                </div>

                {/* 修改資料／重設密碼（員工＋管理員） */}
                {editingId === detail.user.id ? (
                  <MemberEditForm
                    user={detail.user}
                    busy={updateMutation.isPending}
                    onCancel={() => setEditingId(null)}
                    onSave={(input) => updateMutation.mutate(input)}
                  />
                ) : resettingId === detail.user.id ? (
                  <ResetPasswordForm
                    user={detail.user}
                    busy={resetPwMutation.isPending}
                    onCancel={() => setResettingId(null)}
                    onSave={(newPassword) =>
                      resetPwMutation.mutate({ id: detail.user.id, newPassword })
                    }
                  />
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(detail.user.id);
                        setResettingId(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-txt-2 transition-colors hover:text-txt-1"
                      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                    >
                      <Pencil size={13} aria-hidden="true" /> 修改資料
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResettingId(detail.user.id);
                        setEditingId(null);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-txt-2 transition-colors hover:text-txt-1"
                      style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                    >
                      <KeyRound size={13} aria-hidden="true" /> 重設密碼
                    </button>
                  </div>
                )}

                {/* 最近訂單 */}
                <h5 className="mt-5 text-[12px] font-bold tracking-[0.08em] text-gold">
                  最近訂單（最多 10 張）
                </h5>
                {detail.recentOrders.length === 0 ? (
                  <p className="mt-2 text-[13px] text-txt-3">暫時冇訂單。</p>
                ) : (
                  <ul className="mt-2 flex flex-col">
                    {detail.recentOrders.map((o) => (
                      <li
                        key={o.id}
                        className="flex items-center gap-3 border-t py-2 text-[13px]"
                        style={{ borderColor: 'var(--space-line)' }}
                      >
                        <span className="font-mono text-txt-1">{o.orderNo}</span>
                        <span className="hidden font-mono text-[12px] text-txt-3 sm:inline">
                          {fmtDateTime(o.createdAt)}
                        </span>
                        <span className="text-[12px] text-txt-3">
                          {DELIVERY_TEXT[o.deliveryMethod] ?? o.deliveryMethod}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          <StatusBadge status={o.status} />
                          <span className="font-mono text-pink">{fmtHKD(o.total)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </div>
        </div>,
          document.body,
        )}
    </section>
  );
}

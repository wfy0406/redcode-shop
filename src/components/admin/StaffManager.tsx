import { useState } from 'react';
import type { FormEvent } from 'react';
import { ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { fmtDate } from './format';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 員工帳號管理（admin-only）—— users.list / create / updateRole / remove
 * 管理員可以開員工／會員／管理員帳號，改權限、刪帳號（唔可以改刪自己）。
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

const ROLE_META: Record<string, { label: string; color: string }> = {
  admin: { label: '管理員', color: 'var(--gold)' },
  // 三級制（2026-08-06）：主管＝原有員工權限
  supervisor: { label: '主管', color: '#b79cff' },
  staff: { label: '員工', color: 'var(--success)' },
  member: { label: '會員', color: 'var(--text-3)' },
};

type UserRow = {
  id: number;
  name: string;
  phone: string;
  role: 'member' | 'staff' | 'admin';
  createdAt: Date;
};

export default function StaffManager({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const { user: me } = useAuth();
  const utils = trpc.useUtils();
  const listQuery = trpc.users.list.useQuery(undefined);
  const [form, setForm] = useState({ name: '', phone: '', password: '', role: 'staff' });
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  const createMutation = trpc.users.create.useMutation({
    onSuccess: () => {
      toast(`已開通帳號「${form.name.trim()}」`, 'success');
      setForm({ name: '', phone: '', password: '', role: 'staff' });
      setFormError(null);
      void utils.users.list.invalidate();
    },
    onError: (err) => toast(err.message || '開通失敗', 'error'),
  });

  const roleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast('已更新權限', 'success');
      void utils.users.list.invalidate();
    },
    onError: (err) => toast(err.message || '更新失敗', 'error'),
  });

  const removeMutation = trpc.users.remove.useMutation({
    onSuccess: () => {
      toast('已刪除帳號', 'info');
      setConfirmRemoveId(null);
      void utils.users.list.invalidate();
    },
    onError: (err) => {
      setConfirmRemoveId(null);
      toast(err.message || '刪除失敗', 'error');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.password) {
      setFormError('名稱、電話、密碼全部必填');
      return;
    }
    if (form.password.length < 6) {
      setFormError('密碼至少 6 位');
      return;
    }
    setFormError(null);
    createMutation.mutate({
      name: form.name.trim(),
      phone: form.phone.trim(),
      password: form.password,
      role: form.role as 'member' | 'staff' | 'admin',
    });
  };

  const users = (listQuery.data ?? []) as UserRow[];

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：開通帳號表單（5） */}
      <form
        onSubmit={submit}
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-5"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          <UserPlus size={16} className="text-gold" aria-hidden="true" />
          開通帳號
        </h3>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="nu-name" className="mb-1.5 block text-[14px] text-txt-2">
              名稱 *
            </label>
            <input
              id="nu-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              className={inputCls}
              placeholder="例如：同事阿欣"
            />
          </div>
          <div>
            <label htmlFor="nu-phone" className="mb-1.5 block text-[14px] text-txt-2">
              電話（登入用）*
            </label>
            <input
              id="nu-phone"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className={`${inputCls} font-mono`}
              placeholder="例如：91234567"
            />
          </div>
          <div>
            <label htmlFor="nu-password" className="mb-1.5 block text-[14px] text-txt-2">
              密碼（至少 6 位）*
            </label>
            <input
              id="nu-password"
              type="text"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className={`${inputCls} font-mono`}
              placeholder="開通後話俾同事知"
            />
          </div>
          <div>
            <label htmlFor="nu-role" className="mb-1.5 block text-[14px] text-txt-2">
              權限 *
            </label>
            <select
              id="nu-role"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              className={inputCls}
            >
              <option value="staff">員工（入後台操作，敏感操作需主管審批）</option>
              <option value="supervisor">主管（可以入後台審批訂單、管理商品）</option>
              <option value="admin">管理員（主管權限 + 管理帳號）</option>
              <option value="member">會員（普通客，唔入得後台）</option>
            </select>
          </div>
        </div>
        {formError && (
          <p className="mt-3 text-[13px] text-pink-soft" role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={createMutation.isPending}
          className="btn btn-primary mt-5 w-full disabled:opacity-60"
        >
          {createMutation.isPending ? (
            <WishingStar size={16} />
          ) : (
            <UserPlus size={16} aria-hidden="true" />
          )}
          開通帳號
        </button>
      </form>

      {/* 右：帳號列表（7） */}
      <div className="xl:col-span-7">
        <h3 className="text-[16px] font-bold text-txt-1">
          全部帳號
          <span className="ml-2 font-mono text-[13px] font-normal text-txt-3">
            {users.length} 個
          </span>
        </h3>
        {listQuery.isLoading ? (
          <LoadingBlock text="許願星搬緊名單…" />
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {users.map((u) => {
              const isMe = u.id === me?.id;
              const meta = ROLE_META[u.role] ?? ROLE_META.member;
              const removing = removeMutation.isPending && confirmRemoveId === u.id;
              return (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border px-4 py-3.5"
                  style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                >
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border"
                    style={{ borderColor: meta.color, color: meta.color }}
                  >
                    <ShieldCheck size={17} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-bold text-txt-1">
                      {u.name}
                      {isMe && <span className="ml-2 text-[12px] text-gold">（你）</span>}
                    </p>
                    <p className="mt-0.5 font-mono text-[12px] text-txt-3">
                      {u.phone} · 開通於 {fmtDate(u.createdAt)}
                    </p>
                  </div>
                  {/* 權限下拉（自己唔改得） */}
                  <select
                    value={u.role}
                    disabled={isMe || roleMutation.isPending}
                    onChange={(e) =>
                      roleMutation.mutate({
                        id: u.id,
                        role: e.target.value as 'member' | 'staff' | 'admin',
                      })
                    }
                    aria-label={`更改 ${u.name} 權限`}
                    className="h-9 rounded-lg border bg-space-2 px-2.5 text-[12px] transition-colors focus:border-pink disabled:opacity-50"
                    style={{ borderColor: meta.color, color: meta.color }}
                  >
                    <option value="member">會員</option>
                    <option value="staff">員工</option>
                    <option value="supervisor">主管</option>
                    <option value="admin">管理員</option>
                  </select>
                  {/* 刪除（自己唔刪得，兩步確認） */}
                  {isMe ? null : confirmRemoveId === u.id ? (
                    <button
                      type="button"
                      disabled={removing}
                      onClick={() => removeMutation.mutate({ id: u.id })}
                      className="btn btn-primary shrink-0 !px-4 !py-2 text-[12px] disabled:opacity-60"
                    >
                      {removing ? <WishingStar size={13} /> : null}
                      確認刪除？
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveId(u.id)}
                      aria-label={`刪除 ${u.name}`}
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

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Check, KeyRound } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import FormField from './FormField';

/**
 * 更改密碼玻璃卡（R3 §2）
 * 永遠展開三欄：目前密碼 → 新密碼 → 確認新密碼；
 * client 先檢查新密碼 ≥6 位 + 兩次一致先 call auth.changePassword；
 * server 錯誤（例如「舊密碼唔啱」）persist 顯示喺欄下，唔搖 input；
 * 成功：toast「密碼已更新」+ 清三欄，唔跳頁。
 */

interface PasswordCardProps {
  pushToast: (text: string) => void;
}

interface FieldErrors {
  old?: string;
  next?: string;
  confirm?: string;
  form?: string;
}

export default function PasswordCard({ pushToast }: PasswordCardProps) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const changePassword = trpc.auth.changePassword.useMutation();
  const newPasswordOk = newPassword.length >= 6;

  const clearError = (key: keyof FieldErrors) => {
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: FieldErrors = {};
    if (!oldPassword) next.old = '請輸入目前密碼';
    if (newPassword.length < 6) next.next = '新密碼至少要 6 個字符';
    if (confirmPassword !== newPassword) next.confirm = '兩次輸入嘅新密碼唔一樣';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      await changePassword.mutateAsync({ oldPassword, newPassword });
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setErrors({});
      pushToast('密碼已更新');
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : '更改密碼失敗，請稍後再試';
      // server 錯誤 persist 喺欄下；舊密碼相關掛返目前密碼欄
      if (msg.includes('舊密碼')) setErrors({ old: msg });
      else setErrors({ form: msg });
    }
  };

  return (
    <div
      className="rounded-2xl border p-6 md:p-8"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border"
          style={{ borderColor: 'var(--glass-border)', color: 'var(--lavender)' }}
          aria-hidden="true"
        >
          <KeyRound size={18} />
        </span>
        <h2 className="font-serif-tc text-2xl font-semibold text-txt-1">更改密碼</h2>
      </div>

      <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-5" noValidate>
        <FormField
          id="password-old"
          label="目前密碼"
          type="password"
          autoComplete="current-password"
          value={oldPassword}
          error={errors.old}
          onChange={(e) => {
            setOldPassword(e.target.value);
            clearError('old');
          }}
        />
        <FormField
          id="password-new"
          label="新密碼"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          error={errors.next}
          hint={
            newPassword ? (
              newPasswordOk ? (
                <span className="flex items-center gap-1 text-[12px] text-gold">
                  <Check size={12} aria-hidden="true" />
                  長度 OK
                </span>
              ) : (
                <span className="text-[12px] text-txt-3">至少 6 個字符</span>
              )
            ) : undefined
          }
          onChange={(e) => {
            setNewPassword(e.target.value);
            clearError('next');
          }}
        />
        <FormField
          id="password-confirm"
          label="確認新密碼"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          error={errors.confirm}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            clearError('confirm');
          }}
        />

        {errors.form && (
          <p role="alert" className="rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft">
            {errors.form}
          </p>
        )}

        <div>
          <button type="submit" disabled={changePassword.isPending} className="btn btn-primary disabled:opacity-50">
            {changePassword.isPending ? '更新中…' : '更新密碼'}
          </button>
        </div>
      </form>
    </div>
  );
}

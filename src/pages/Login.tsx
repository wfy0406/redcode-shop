import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import FormField from '@/components/account/FormField';
import WishingStar from '@/components/account/WishingStar';

/**
 * RedCode 設計系統 §P5 —— 會員登入 /login
 * 置中玻璃單卡（max 420px，--glass-bg-strong + blur 16px），卡頂 logo + 花體「Welcome back, star」。
 * 電話 + 密碼 → useAuth().login()；成功 → location.state?.from ?? '/account'。
 * 錯誤直接顯示後端訊息（如「電話號碼或密碼錯誤」）。
 */

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const state = location.state as { from?: string | { pathname?: string } } | null;
  const rawFrom = state?.from;
  const from = typeof rawFrom === 'string' ? rawFrom : (rawFrom?.pathname ?? '/account');

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!phone.trim()) {
      setError('請輸入電話號碼');
      return;
    }
    if (!password) {
      setError('請輸入密碼');
      return;
    }
    setSubmitting(true);
    try {
      await login(phone.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(errorMessage(err, '登入失敗，請稍後再試'));
      setSubmitting(false);
    }
  };

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-16 md:min-h-[calc(100dvh-72px)] md:px-8 md:py-24 xl:px-12">
      <div
        className="w-full max-w-[420px] rounded-2xl border p-8 md:p-10"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        {/* 卡頂：Logo + 花體襯字 */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="/logo.png" alt="RedCode Fashion Design" className="h-12 w-auto" />
          <p className="script text-3xl leading-[1.3]">Welcome back, star</p>
          <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">會員登入</h1>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <FormField
            id="login-phone"
            label="電話"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="852 1234 5678"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <FormField
            id="login-password"
            label="密碼"
            type="password"
            autoComplete="current-password"
            placeholder="你嘅密碼"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <p
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
                <path
                  d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
                  fill="var(--gold)"
                />
              </svg>
              {error}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn btn-primary w-full disabled:opacity-70">
            {submitting ? <WishingStar size={16} spinning /> : '登入'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-txt-2">
          未係會員？{' '}
          <Link to="/register" className="font-medium text-purple-text underline-offset-4 hover:underline">
            立即註冊
          </Link>
        </p>
      </div>
    </section>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import FormField from '@/components/account/FormField';
import WishingStar from '@/components/account/WishingStar';
import GoogleLoginButton from '@/components/account/GoogleLoginButton';

/**
 * RedCode 設計系統 §P5 —— 會員登入 /login
 * 置中玻璃單卡（max 420px，--glass-bg-strong + blur 16px），卡頂 logo + 花體「Welcome back, star」。
 * 電話 + 密碼 → useAuth().login()；成功 → location.state?.from ?? '/account'。
 * 錯誤直接顯示後端訊息（如「電話號碼或密碼錯誤」）。
 *
 * 2026-08-04 加：忘記密碼流程（email 收 6 位驗證碼 → 驗證 → 重設密碼）。
 * 同一張卡切 mode：login（登入）→ forgot（輸入 email 收碼）→ reset（驗證碼＋新密碼）→ done（成功返回登入）。
 */

type Mode = 'login' | 'forgot' | 'reset' | 'done';

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

const MODE_HEADER: Record<Mode, { script: string; title: string }> = {
  login: { script: 'Welcome back, star', title: '會員登入' },
  forgot: { script: 'No worries, star', title: '忘記密碼' },
  reset: { script: 'Almost there, star', title: '重設密碼' },
  done: { script: 'All set, star', title: '重設成功' },
};

export default function Login() {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [mode, setMode] = useState<Mode>('login');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  // 忘記密碼流程 state
  const [resetEmail, setResetEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

  const requestReset = trpc.auth.requestPasswordReset.useMutation({
    onSuccess: () => {
      setError(null);
      setInfo('如果你嘅 Email 有綁帳號，驗證碼已經寄出，10 分鐘內有效。請去信箱睇睇（記得睇埋垃圾郵件）。');
      setMode('reset');
    },
    onError: (err) => {
      setInfo(null);
      setError(errorMessage(err, '寄出失敗，請稍後再試'));
    },
  });

  const resetPw = trpc.auth.resetPasswordWithCode.useMutation({
    onSuccess: () => {
      setError(null);
      setInfo(null);
      setCode('');
      setNewPassword('');
      setNewPassword2('');
      setMode('done');
    },
    onError: (err) => {
      setInfo(null);
      setError(errorMessage(err, '重設失敗，請再試'));
    },
  });

  const state = location.state as { from?: string | { pathname?: string } } | null;
  const rawFrom = state?.from;
  const from = typeof rawFrom === 'string' ? rawFrom : (rawFrom?.pathname ?? '/account');

  const switchMode = (m: Mode) => {
    setError(null);
    setInfo(null);
    setMode(m);
  };

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

  const onRequestCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (requestReset.isPending) return;
    setError(null);
    setInfo(null);
    const email = resetEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('請輸入正確嘅 Email');
      return;
    }
    requestReset.mutate({ email });
  };

  const onResetPassword = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (resetPw.isPending) return;
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError('請輸入 Email 收到嘅 6 位驗證碼');
      return;
    }
    if (newPassword.length < 6) {
      setError('新密碼至少 6 位');
      return;
    }
    if (newPassword2 !== newPassword) {
      setError('兩次輸入嘅新密碼唔一樣');
      return;
    }
    resetPw.mutate({ email: resetEmail.trim(), code: code.trim(), newPassword });
  };

  const alertIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <path
        d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
        fill="var(--gold)"
      />
    </svg>
  );

  const errorBox = error && (
    <p
      role="alert"
      className="flex items-center gap-2 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft"
    >
      {alertIcon}
      {error}
    </p>
  );

  const infoBox = info && (
    <p
      role="status"
      className="flex items-center gap-2 rounded-xl border border-gold bg-space-2 px-4 py-3 text-[13px] leading-[1.7] text-gold"
    >
      {alertIcon}
      {info}
    </p>
  );

  const header = MODE_HEADER[mode];

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
          <p className="script text-3xl leading-[1.3]">{header.script}</p>
          <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">{header.title}</h1>
        </div>

        {mode === 'login' && (
          <>
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

              <div className="-mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="text-[13px] text-purple-text underline-offset-4 hover:underline"
                >
                  忘記密碼？
                </button>
              </div>

              {errorBox}

              <button type="submit" disabled={submitting} className="btn btn-primary w-full disabled:opacity-70">
                {submitting ? <WishingStar size={16} spinning /> : '登入'}
              </button>
            </form>

            {/* 或：Google 一掣登入（首次用會自動開會員戶口） */}
            <div className="mt-6 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1" style={{ background: 'var(--glass-border)' }} />
              <span className="text-xs text-txt-3">或</span>
              <span className="h-px flex-1" style={{ background: 'var(--glass-border)' }} />
            </div>
            <div className="mt-4">
              {googleSubmitting ? (
                <p className="flex items-center justify-center gap-2 text-sm text-txt-2">
                  <WishingStar size={16} spinning /> Google 登入中…
                </p>
              ) : (
                <GoogleLoginButton
                  onCredential={async (idToken) => {
                    setError(null);
                    setGoogleSubmitting(true);
                    try {
                      await loginWithGoogle(idToken);
                      navigate(from, { replace: true });
                    } catch (err) {
                      setError(errorMessage(err, 'Google 登入失敗，請稍後再試'));
                      setGoogleSubmitting(false);
                    }
                  }}
                  onError={(msg) => setError(msg)}
                />
              )}
            </div>

            <p className="mt-6 text-center text-sm text-txt-2">
              未係會員？{' '}
              <Link to="/register" className="font-medium text-purple-text underline-offset-4 hover:underline">
                立即註冊
              </Link>
            </p>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <form onSubmit={onRequestCode} noValidate className="flex flex-col gap-5">
              <p className="text-sm leading-[1.8] text-txt-2">
                輸入你註冊／會員資料綁定嘅 Email，我哋會寄一個 <b className="text-txt-1">6 位驗證碼</b>俾你重設密碼。
              </p>
              <FormField
                id="forgot-email"
                label="Email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
              />

              {errorBox}

              <button
                type="submit"
                disabled={requestReset.isPending}
                className="btn btn-primary w-full disabled:opacity-70"
              >
                {requestReset.isPending ? <WishingStar size={16} spinning /> : '寄出驗證碼'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-txt-2">
              諗返起密碼？{' '}
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="font-medium text-purple-text underline-offset-4 hover:underline"
              >
                返回登入
              </button>
            </p>
          </>
        )}

        {mode === 'reset' && (
          <>
            <form onSubmit={onResetPassword} noValidate className="flex flex-col gap-5">
              <div
                className="flex items-center justify-between gap-3 rounded-xl border bg-space-2 px-4 py-3"
                style={{ borderColor: 'var(--glass-border)' }}
              >
                <span className="truncate text-sm text-txt-2">{resetEmail}</span>
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  className="shrink-0 text-[13px] text-purple-text underline-offset-4 hover:underline"
                >
                  更改
                </button>
              </div>

              <FormField
                id="reset-code"
                label="驗證碼"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="Email 收到嘅 6 位數字"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <FormField
                id="reset-new-password"
                label="新密碼"
                type="password"
                autoComplete="new-password"
                placeholder="至少 6 位"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <FormField
                id="reset-new-password2"
                label="確認新密碼"
                type="password"
                autoComplete="new-password"
                placeholder="再輸入一次新密碼"
                value={newPassword2}
                onChange={(e) => setNewPassword2(e.target.value)}
              />

              {infoBox}
              {errorBox}

              <button
                type="submit"
                disabled={resetPw.isPending}
                className="btn btn-primary w-full disabled:opacity-70"
              >
                {resetPw.isPending ? <WishingStar size={16} spinning /> : '重設密碼'}
              </button>
            </form>

            <p className="mt-5 text-center text-sm text-txt-2">
              收唔到驗證碼？{' '}
              <button
                type="button"
                disabled={requestReset.isPending}
                onClick={() => {
                  setError(null);
                  requestReset.mutate({ email: resetEmail.trim() });
                }}
                className="font-medium text-purple-text underline-offset-4 hover:underline disabled:opacity-60"
              >
                {requestReset.isPending ? '寄出中…' : '重新寄出'}
              </button>
            </p>
            <p className="mt-3 text-center text-sm text-txt-2">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="font-medium text-purple-text underline-offset-4 hover:underline"
              >
                返回登入
              </button>
            </p>
          </>
        )}

        {mode === 'done' && (
          <div className="flex flex-col items-center gap-6 text-center">
            <p className="text-sm leading-[1.9] text-txt-2">
              密碼已經重設成功 ✓<br />
              請用新密碼登入你嘅帳號。
            </p>
            <button type="button" onClick={() => switchMode('login')} className="btn btn-primary w-full">
              返回登入
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import FormField from '@/components/account/FormField';
import WishingStar from '@/components/account/WishingStar';
import GoogleLoginButton from '@/components/account/GoogleLoginButton';

/**
 * RedCode 設計系統 §P5 —— 會員註冊 /register
 * 玻璃卡表單：寶寶（買家）姓名、電話（登入帳號，亦係 WhatsApp 通知渠道）、
 * 密碼、確認密碼、Email（2026-08-03 加；2026-08-04 起改必填，Glo 要求）、地址（選填）、年齡（選填）、
 * 生日月份（選填，2026-07-29 加）。
 * 前端驗證：必填 / 電話 8 位數字起 / 密碼 ≥6 位 / 兩次密碼一致 / Email 格式；
 * 後端 CONFLICT（電話已註冊／Email 已綁定）友善顯示。成功自動登入 → /account。
 */

type FieldErrors = {
  name?: string;
  phone?: string;
  password?: string;
  confirm?: string;
  email?: string;
  age?: string;
};

function backendMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return fallback;
}

function isConflict(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'data' in err &&
    (err as { data?: { code?: string } }).data?.code === 'CONFLICT'
  );
}

/** 電話格式：去除空格/連字後，至少 8 位數字 */
function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

export default function Register() {
  const { register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [age, setAge] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = '請輸入你嘅姓名';
    const normalized = normalizePhone(phone);
    if (!normalized) next.phone = '請輸入電話號碼';
    else if (!/^\d{8,}$/.test(normalized)) next.phone = '電話號碼要至少 8 位數字';
    if (password.length < 6) next.password = '密碼要至少 6 位';
    if (confirm !== password) next.confirm = '兩次密碼唔一致，請再確認';
    // Email 必填（2026-08-04 Glo 要求）：留空擋、格式唔啱擋
    if (!email.trim()) next.email = '請輸入你嘅 Email（歡迎信同優惠碼會寄去呢個信箱）';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      next.email = 'Email 格式唔啱，請再檢查';
    if (age.trim()) {
      const n = Number(age);
      if (!Number.isInteger(n) || n < 0 || n > 150) next.age = '請輸入有效年齡（0–150）';
    }
    return next;
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSubmitting(true);
    try {
      await register({
        name: name.trim(),
        phone: normalizePhone(phone),
        password,
        email: email.trim(),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(age.trim() ? { age: Number(age) } : {}),
        ...(birthMonth ? { birthMonth: Number(birthMonth) } : {}),
      });
      navigate('/account', { replace: true });
    } catch (err) {
      if (isConflict(err)) {
        // CONFLICT 分兩種：撞 email 定撞電話，跟後端訊息分辨
        const msg = backendMessage(err, '');
        if (msg.toLowerCase().includes('email')) {
          setErrors({ email: msg });
        } else {
          setErrors({ phone: '呢個電話號碼已經註冊過，直接去登入啦' });
        }
      } else {
        setSubmitError(backendMessage(err, '註冊失敗，請稍後再試'));
      }
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
          <p className="script text-3xl leading-[1.3]">Make a wish, join us</p>
          <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">會員註冊</h1>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
          <FormField
            id="reg-name"
            label="寶寶姓名"
            autoComplete="name"
            placeholder="Glo Glo 想點稱呼你？"
            value={name}
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
          />
          <FormField
            id="reg-phone"
            label="電話（登入帳號）"
            hint={<span className="text-[13px] text-txt-3">用嚟通知你訂單狀態</span>}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="852 1234 5678"
            value={phone}
            error={errors.phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <FormField
            id="reg-email"
            label="Email"
            hint={<span className="text-[13px] text-txt-3">收歡迎信＋迎新優惠碼；日後忘記密碼都可以經 Email 重設</span>}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            error={errors.email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <FormField
            id="reg-password"
            label="密碼"
            type="password"
            autoComplete="new-password"
            placeholder="至少 6 位"
            value={password}
            error={errors.password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <FormField
            id="reg-confirm"
            label="確認密碼"
            type="password"
            autoComplete="new-password"
            placeholder="再輸入一次"
            value={confirm}
            error={errors.confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <FormField
            id="reg-address"
            label="地址"
            optional
            autoComplete="street-address"
            placeholder="收貨地址，遲啲填都得"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <FormField
            id="reg-age"
            label="年齡"
            optional
            type="number"
            inputMode="numeric"
            min={0}
            max={150}
            placeholder="幫 Glo Glo 揀更啱你嘅款"
            value={age}
            error={errors.age}
            onChange={(e) => setAge(e.target.value)}
          />
          {/* 生日月份（選填）：下拉揀 1–12 月；舊會員留空都得，之後可以補 */}
          <div className="w-full">
            <label
              htmlFor="reg-birth-month"
              className="mb-2 flex items-baseline justify-between gap-2 text-sm text-txt-2"
            >
              <span>
                生日月份
                <span className="ml-2 text-[13px] text-txt-3">（選填）</span>
              </span>
              <span className="text-[13px] text-txt-3">Glo Glo 想記住你嘅大日子</span>
            </label>
            <select
              id="reg-birth-month"
              value={birthMonth}
              onChange={(e) => setBirthMonth(e.target.value)}
              className={`h-12 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[15px] transition-[border-color,box-shadow] duration-200 focus:border-pink focus:shadow-[0_0_0_3px_rgba(255,0,84,0.15)] focus:outline-none ${
                birthMonth ? 'text-txt-1' : 'text-txt-3'
              }`}
            >
              <option value="">揀月份…</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {i + 1} 月
                </option>
              ))}
            </select>
          </div>

          {submitError && (
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
              {submitError}
            </p>
          )}

          <button type="submit" disabled={submitting} className="btn btn-primary w-full disabled:opacity-70">
            {submitting ? <WishingStar size={16} spinning /> : '註冊'}
          </button>
        </form>

        {/* 或：Google 一掣開戶（首次用會自動建立會員帳號，之後一掣登入） */}
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
                setSubmitError(null);
                setGoogleSubmitting(true);
                try {
                  await loginWithGoogle(idToken);
                  navigate('/account', { replace: true });
                } catch (err) {
                  setSubmitError(backendMessage(err, 'Google 登入失敗，請稍後再試'));
                  setGoogleSubmitting(false);
                }
              }}
              onError={(msg) => setSubmitError(msg)}
            />
          )}
        </div>

        <p className="mt-6 text-center text-sm text-txt-2">
          已有帳號？{' '}
          <Link to="/login" className="font-medium text-purple-text underline-offset-4 hover:underline">
            登入
          </Link>
        </p>
      </div>
    </section>
  );
}

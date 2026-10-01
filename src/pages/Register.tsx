import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import FormField from '@/components/account/FormField';
import WishingStar from '@/components/account/WishingStar';
import GoogleLoginButton from '@/components/account/GoogleLoginButton';
import RegionStationPicker from '@/components/shop/RegionStationPicker';
import PushPermissionGuide from '@/components/push/PushPermissionGuide';
import { isPushSupported } from '@/lib/pushClient';

/**
 * RedCode 設計系統 §P5 —— 會員註冊 /register
 * 玻璃卡表單：寶寶（買家）姓名、電話（登入帳號，亦係 WhatsApp 通知渠道）、
 * 密碼、確認密碼、Email（2026-08-03 加；2026-08-04 起改必填，Glo 要求）、地址（選填）、
 * 預設取貨方式（2026-08-08 加，Glo 要求：送貨上門／順豐站／智能櫃，自取可填站點；結帳自動帶入）、
 * 年齡（選填）、生日月份（選填，2026-07-29 加）。
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
  // 預設收件地區（2026-09-29 v2.1.0 VIP+免運）：香港（預設）／澳門／國外；國外只可以送貨上門
  const [region, setRegion] = useState<'HK' | 'MO' | 'OVERSEAS'>('HK');
  // 預設取貨方式（2026-08-08 Glo 要求）：結帳自動帶入；送貨上門用上面嘅地址欄
  const [deliveryMethod, setDeliveryMethod] = useState<'address' | 'sf_station' | 'sf_locker'>('address');
  // 自取站點（v2.1.0）：RegionStationPicker 揀（唔再自由填字）；國外單唔揀得自取
  const [stationId, setStationId] = useState<string | undefined>(undefined);
  // v2.2.28（老闆回報「註冊揀咗站但會員中心寫未揀」）：連站名快照一齊存，
  // 會員中心摘要／結帳顯示／WMS／email 都係用呢個名
  const [stationName, setStationName] = useState<string | undefined>(undefined);
  const [age, setAge] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  // 直接促銷同意（2026-08-05 Glo 要求，PDPO：唔可以預先剔選，要會員主動剔先算同意）
  const [agreeMarketing, setAgreeMarketing] = useState(false);
  // 直播開播通知（v2.2.0）：剔咗＝註冊成功後彈 PushPermissionGuide 綁定呢部裝置；
  // 失敗/拒絕唔阻塞註冊（guide 入面會提示可以稍後喺會員中心開返）
  const [wantLivePush, setWantLivePush] = useState(false);
  const [showPushGuide, setShowPushGuide] = useState(false);
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
    // 國外單只支援送貨上門（同結帳頁同一規則）
    const effectiveMethod = region === 'OVERSEAS' ? 'address' : deliveryMethod;
    try {
      // v2.1.0：region／stationId 後端 register 已接；useAuth 嘅 RegisterInput 型別未加
      // 呢兩個欄（主線整合時補型別），呢度用 assertion 繞過多餘屬性檢查
      await register({
        name: name.trim(),
        phone: normalizePhone(phone),
        password,
        email: email.trim(),
        ...(address.trim() ? { address: address.trim() } : {}),
        deliveryMethod: effectiveMethod,
        region,
        ...(effectiveMethod !== 'address' && stationId
          ? { stationId, pickupPoint: stationName }
          : {}),
        ...(age.trim() ? { age: Number(age) } : {}),
        ...(birthMonth ? { birthMonth: Number(birthMonth) } : {}),
        marketingOptIn: agreeMarketing,
      } as Parameters<typeof register>[0]);
      // v2.2.12 修復（老闆回報「剔咗通知但註冊後無反應」）：剔咗開播通知
      // 就要停一停彈綁定講解——之前漏咗呢步，直頭跳去會員中心，
      // PushPermissionGuide 永遠冇機會彈。guide onClose 入面會 navigate 去 /account。
      if (wantLivePush) {
        setShowPushGuide(true);
        setSubmitting(false);
        return;
      }
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
          {/* 預設收件地區（v2.1.0 VIP+免運）：影響免運同可取貨方式；國外只可以送貨上門 */}
          <div className="w-full">
            <span className="mb-2 flex items-baseline justify-between gap-2 text-sm text-txt-2">
              <span>
                預設收件地區
                <span className="ml-2 text-[13px] text-txt-3">（選填）</span>
              </span>
              <span className="text-[13px] text-txt-3">澳門／國外單不包郵</span>
            </span>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="預設收件地區">
              {(
                [
                  ['HK', '香港'],
                  ['MO', '澳門'],
                  ['OVERSEAS', '國外'],
                ] as const
              ).map(([value, label]) => {
                const active = region === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setRegion(value);
                      setStationId(undefined);
                      if (value === 'OVERSEAS') setDeliveryMethod('address');
                    }}
                    aria-pressed={active}
                    className="h-12 rounded-xl border text-[14px] transition-[border-color,box-shadow] duration-200"
                    style={
                      active
                        ? {
                            borderColor: 'var(--pink)',
                            background: 'var(--pink-haze)',
                            color: 'var(--txt-1)',
                            fontWeight: 600,
                          }
                        : {
                            borderColor: 'var(--space-line)',
                            background: 'var(--space-2)',
                            color: 'var(--txt-3)',
                          }
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          {/* 預設取貨方式（2026-08-08 Glo 要求）：結帳會自動帶入，客人到時照樣可以改；
              揀送貨上門就用上面嘅地址欄；自取改用站點下拉（v2.1.0） */}
          <div className="w-full">
            <span className="mb-2 flex items-baseline justify-between gap-2 text-sm text-txt-2">
              <span>
                預設取貨方式
                <span className="ml-2 text-[13px] text-txt-3">（選填）</span>
              </span>
              <span className="text-[13px] text-txt-3">結帳嗰陣自動帶入</span>
            </span>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="預設取貨方式">
              {(
                [
                  ['address', '送貨上門'],
                  ['sf_station', '順豐站／自提點／智能櫃'],
                ] as const
              ).map(([value, label]) => {
                // v2.2.27（老闆指令「一個按鈕搞掂」）：自取一粒制——揀站時自動歸類；
                // 自取制亮起條件＝非送貨上門（揀咗智能櫃自動轉 sf_locker 都照樣亮）
                const active =
                  value === 'address'
                    ? deliveryMethod === 'address'
                    : deliveryMethod !== 'address';
                const disabled = region === 'OVERSEAS' && value !== 'address';
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      if (disabled || active) return;
                      setDeliveryMethod(value);
                      setStationId(undefined);
                      setStationName(undefined);
                    }}
                    disabled={disabled}
                    aria-pressed={active}
                    className="inline-flex h-12 items-center justify-center gap-1.5 rounded-xl border px-2 text-center text-[14px] leading-[1.25] transition-[border-color,box-shadow] duration-200 disabled:cursor-not-allowed disabled:opacity-40"
                    style={
                      active
                        ? {
                            borderColor: 'var(--pink)',
                            background: 'var(--pink-haze)',
                            color: 'var(--txt-1)',
                            fontWeight: 600,
                          }
                        : {
                            borderColor: 'var(--space-line)',
                            background: 'var(--space-2)',
                            color: 'var(--txt-3)',
                          }
                    }
                  >
                    {/* 選中提示點（radar-node 式發光環，靜態 box-shadow 唔會觸發動畫限制） */}
                    {active && value !== 'address' && (
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          background: 'var(--pink)',
                          boxShadow: '0 0 0 3px rgba(254,1,126,0.22)',
                        }}
                        aria-hidden="true"
                      />
                    )}
                    {label}
                  </button>
                );
              })}
            </div>
            {deliveryMethod !== 'address' && region !== 'OVERSEAS' && (
              <div className="mt-3">
                <RegionStationPicker
                  region={region === 'MO' ? 'MO' : 'HK'}
                  method={deliveryMethod}
                  value={stationId}
                  onChange={(id, name, type) => {
                    setStationId(id);
                    setStationName(name);
                    // v2.2.25：附近清單揀咗邊型，類別自動跟（順豐站／自提點→sf_station；智能櫃→sf_locker）
                    if (type === 'SF_LOCKER') setDeliveryMethod('sf_locker');
                    else if (type === 'SF_STATION' || type === 'SERVICE_POINT') setDeliveryMethod('sf_station');
                  }}
                />
              </div>
            )}
          </div>
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

          {/* 直接促銷同意（2026-08-05 Glo 要求）：對應私隱政策第 7 節；
              預設唔剔（沉默唔當同意），剔咗先會收到優惠/直播推廣訊息 */}
          <label
            htmlFor="reg-marketing"
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-space-line bg-space-2 px-4 py-3.5"
          >
            <input
              id="reg-marketing"
              type="checkbox"
              checked={agreeMarketing}
              onChange={(e) => setAgreeMarketing(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-pink"
            />
            <span className="text-[13px] leading-[1.7] text-txt-2">
              我同意 RedCode 用我嘅姓名、電話同 Email，經電郵或 WhatsApp 發送商品、直播同優惠資訊畀我
              <span className="text-txt-3">（選填；可以隨時免費拒絕接收，詳情見</span>
              <Link to="/privacy" className="text-pink-soft underline underline-offset-2">
                私隱政策
              </Link>
              <span className="text-txt-3">第 7 節）。</span>
            </span>
          </label>

          {/* 直播開播通知（v2.2.0）：綁定呢部裝置收 Web Push；獨立於上面嘅促銷同意，
              唔預先剔選；失敗/拒絕唔阻塞註冊，可稍後喺會員中心開返 */}
          <label
            htmlFor="reg-live-push"
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-space-line bg-space-2 px-4 py-3.5"
          >
            <input
              id="reg-live-push"
              type="checkbox"
              checked={wantLivePush}
              onChange={(e) => setWantLivePush(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#F5C518]"
            />
            <span className="text-[13px] leading-[1.7] text-txt-2">
              📺 接收直播開播通知（綁定呢部裝置）
              <span className="block text-txt-3">
                Glo Glo 一開播，呢部裝置就會收到通知；只用嚟話你知開播，唔會做其他推廣。可以隨時喺會員中心取消綁定。
              </span>
            </span>
          </label>

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

      {/* 直播通知權限講解（註冊成功後先彈；無論成功與否都入會員中心，唔阻塞註冊） */}
      <PushPermissionGuide
        open={showPushGuide}
        onClose={() => {
          setShowPushGuide(false);
          navigate('/account', { replace: true });
        }}
      />
    </section>
  );
}

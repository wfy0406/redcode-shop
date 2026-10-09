import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Calendar, Crown, Gem, Gift, ReceiptText } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { trpc } from '@/providers/trpc';
import WishingStar from '@/components/account/WishingStar';
import OrderCard from '@/components/account/OrderCard';
import GuestOrderCard, { type GuestOrderPayload } from '@/components/shop/GuestOrderCard';
import ClaimGuestOrderModal from '@/components/shop/ClaimGuestOrderModal';
import { DotsLoader } from '@/components/shop/form-bits';

/**
 * 我的訂單 /orders —— 2026-07-30 由會員中心抽出嘅獨立頁
 * 背景：有客人唔識撳會員名入會員中心搵訂單，Glo 要求主選單一撳就到。
 * 內容同會員中心嘅訂單段一致：trpc.orders.myOrders + 日期搜尋 + OrderCard；
 * 待付款／被退回嘅單，OrderCard 會內嵌 PaymentProofDropzone 即場上傳截圖。
 *
 * 2026-10-09（訪客購買）：未登入視圖改做上下兩區——上：會員登入卡（主路徑）；
 * 下：查單卡（雙因子：訂單編號＋落單電話，統一失敗訊息防枚舉；訪客單＋會員單都查到）。
 * 魔法連結 ?guest=<orderNo>&token=<uuid>（確認 email 入面嗰條）自動帶入查單，
 * token 直入唔使電話，而且永遠唔顯示喺 UI。
 * 查單擴展（2026-10-09 下昼）：訪客單標示「訪客單」＋下面推薦註冊會員；
 * 會員單只顯示基本資料＋引導登入；訪客單可以「移入會員訂單」——
 * 未登入先去登入，返嚟自動彈確認框（?claim=1），確認後訂單歸入會員旗下。
 * 已登入會員維持原有訂單列表，唔顯示查單區；帶 guest+token 連結登入中會彈移入確認框。
 */

/** 查單結果：訪客單（完整 payload）｜會員單（基本資料，引導登入） */
type LookupResult =
  | ({ kind: 'guest' } & GuestOrderPayload)
  | { kind: 'member'; orderNo: string; status: string; createdAt: string };

/** 會員單查單結果嘅狀態文字（同 StatusBadge 口徑一致，齋文字版） */
const MEMBER_STATUS_LABEL: Record<string, string> = {
  pending_payment: '等待付款',
  payment_review: '核實付款中',
  approved: '已確認，準備出貨',
  shipped: '已寄出',
  completed: '已完成',
  cancelled: '已取消',
  rejected: '付款被退回',
};

const WHATSAPP_URL = 'https://wa.me/85254835368';

/** 本地日子（YYYY-MM-DD）對照：createdAt 係咪同一日 */
function sameLocalDay(d: Date | string, ymd: string): boolean {
  const date = d instanceof Date ? d : new Date(d);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` === ymd;
}

/** 查單卡（未登入視圖下半部）——訪客單＋會員單都查到 */
function GuestLookupSection() {
  const utils = trpc.useUtils();
  const [params] = useSearchParams();
  const [orderNo, setOrderNo] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [resultToken, setResultToken] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const magicTried = useRef(false);

  // 魔法連結自動帶入：?guest=<orderNo>&token=<uuid> → token 直入查（跳過電話）
  useEffect(() => {
    const g = params.get('guest');
    const t = params.get('token');
    if (!g || !t || magicTried.current) return;
    magicTried.current = true;
    setOrderNo(g);
    setBusy(true);
    utils.orders.guestByToken
      .fetch({ orderNo: g, token: t })
      .then((data) => {
        setResult({ kind: 'guest', ...(data as GuestOrderPayload) });
        setResultToken(t); // guestByToken 唔返 token，用返 URL 嗰個付款
      })
      .catch(() => setError('搵唔到呢張訂單喎——核對返訂單編號同電話係咪落單嗰組。'))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // 查到結果：focus 落結果卡（screen reader 直接落喺結果）
  useEffect(() => {
    if (result && resultRef.current) resultRef.current.focus();
  }, [result]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setResult(null);
    if (!orderNo.trim() || !phone.trim()) {
      setError('兩欄都要填——訂單編號同落單電話。');
      return;
    }
    setBusy(true);
    try {
      const data = (await utils.orders.guestLookup.fetch({ orderNo: orderNo.trim(), phone: phone.trim() })) as LookupResult;
      setResult(data);
      // 訪客單：電話核實過先返 token（付款＋移入會員都要靠佢）；會員單冇 token
      setResultToken(data.kind === 'guest' ? (data.guestToken ?? null) : null);
    } catch (err) {
      const code = (err as { data?: { code?: string } })?.data?.code;
      if (code === 'TOO_MANY_REQUESTS') setError('查得太密啦，唞一分鐘再試。');
      else setError('搵唔到呢張訂單喎——核對返訂單編號同電話係咪落單嗰組。');
    } finally {
      setBusy(false);
    }
  };

  /** 倒數到 0：refetch 確認後端已取消（有 token 行 token 路徑，否則行電話路徑；會員單唔使倒數） */
  const refresh = async () => {
    if (!result || result.kind !== 'guest') return;
    try {
      if (resultToken) {
        const data = await utils.orders.guestByToken.fetch({ orderNo: result.orderNo, token: resultToken });
        setResult({ kind: 'guest', ...(data as GuestOrderPayload) });
      } else {
        const data = (await utils.orders.guestLookup.fetch({ orderNo: result.orderNo, phone: phone.trim() })) as LookupResult;
        setResult(data);
      }
    } catch {
      // 已取消／查唔到：照舊顯示原卡（逾時態由 secondsLeft 話事）
    }
  };

  const inputCls =
    'mt-2 h-11 w-full rounded-xl border bg-space-2 px-4 text-[15px] text-txt-1 placeholder:text-txt-disabled transition-colors focus:border-pink';

  return (
    <>
      <div
        className="flex w-full max-w-[420px] flex-col rounded-2xl border p-8"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="font-serif-tc text-xl font-semibold text-txt-1">查詢訂單</h2>
            <p className="mt-1 text-[13px] text-txt-3">訪客單、會員單都查到——輸入訂單編號同落單電話就得。</p>
          </div>
          <img src="/guest/glo-magnifier.png" alt="" className="glo-sway w-16 shrink-0" loading="lazy" aria-hidden="true" />
        </div>

        <form onSubmit={(e) => void onSubmit(e)} className="mt-4">
          <div>
            <label htmlFor="gl-orderno" className="text-sm text-txt-2">
              訂單編號（確認 email 度搵到）
            </label>
            <input
              id="gl-orderno"
              type="text"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
              autoCapitalize="characters"
              className={`${inputCls} font-mono uppercase tracking-wider`}
              style={{ borderColor: error ? 'var(--pink)' : 'var(--space-line)' }}
              placeholder="RC202610094821"
            />
          </div>
          <div className="mt-3">
            <label htmlFor="gl-phone" className="text-sm text-txt-2">
              電話號碼
            </label>
            <input
              id="gl-phone"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputCls}
              style={{ borderColor: error ? 'var(--pink)' : 'var(--space-line)' }}
              placeholder="落單嗰陣填嘅電話"
            />
          </div>
          {error && (
            <div role="alert" className="mt-3" style={{ animation: 'promo-fade-in .2s ease-out' }}>
              <p className="text-[13px] text-pink-soft">{error}</p>
              <p className="mt-1 text-[12px] text-txt-3">
                多次都搵唔到？
                <a
                  href={`${WHATSAPP_URL}?text=${encodeURIComponent('你好，我查唔到訪客訂單，想請你哋幫手。')}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-gold underline underline-offset-4"
                >
                  WhatsApp 我哋幫手
                </a>
              </p>
            </div>
          )}
          <button type="submit" disabled={busy} className={`btn w-full mt-4 ${result ? 'btn-primary' : 'btn-secondary'}`}>
            {busy ? <DotsLoader /> : '查詢訂單'}
          </button>
        </form>
      </div>

      {/* 查單結果卡（同 max-w 對齊，lg 拉闊）：訪客單→完整卡＋註冊推薦；會員單→引導登入卡 */}
      {result?.kind === 'guest' && (
        <div className="mt-6 flex w-full max-w-[420px] flex-col gap-5 lg:max-w-[560px]">
          <GuestOrderCard order={result} guestToken={resultToken} onExpire={() => void refresh()} focusRef={resultRef} />
          <RegisterUpsell phone={phone.trim()} />
        </div>
      )}
      {result?.kind === 'member' && (
        <div className="mt-6 w-full max-w-[420px] lg:max-w-[560px]">
          <MemberOrderHint result={result} focusRef={resultRef} />
        </div>
      )}
    </>
  );
}

/** 會員單查單結果：只顯示基本資料＋引導登入（詳情要登入會員先睇到） */
function MemberOrderHint({
  result,
  focusRef,
}: {
  result: { kind: 'member'; orderNo: string; status: string; createdAt: string };
  focusRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const created = new Date(result.createdAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const createdLabel = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      aria-live="polite"
      aria-label={`會員訂單 ${result.orderNo}`}
      className="relative w-full overflow-hidden rounded-2xl border p-6"
      style={{
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: 'rgba(245,197,24,0.4)',
        animation: 'promo-fade-in .2s ease-out',
      }}
    >
      {/* 超大描邊水印（裝飾） */}
      <span
        aria-hidden="true"
        className="script pointer-events-none absolute -bottom-5 right-1 select-none leading-none"
        style={{ fontSize: '72px', color: 'transparent', WebkitTextStroke: '1px rgba(245,197,24,0.22)' }}
      >
        member
      </span>

      <div className="relative flex flex-wrap items-center gap-2.5">
        <span className="font-mono text-[15px] font-bold tracking-wider text-gold">{result.orderNo}</span>
        <span
          className="rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide"
          style={{ color: 'var(--gold)', borderColor: 'rgba(245,197,24,0.45)', background: 'rgba(245,197,24,0.08)' }}
        >
          會員單
        </span>
        <span className="ml-auto text-[12px] text-txt-3">{createdLabel}</span>
      </div>
      <p className="relative mt-3 text-[13.5px] text-txt-2">
        狀態：<span className="font-semibold text-txt-1">{MEMBER_STATUS_LABEL[result.status] ?? result.status}</span>
      </p>

      <div className="relative my-4 h-px" style={{ background: 'var(--space-line)' }} aria-hidden="true" />

      <p className="relative text-[14px] leading-[1.8] text-txt-2">
        呢張單係會員帳號落嘅——登入返你嘅會員，就睇到完整詳情、出貨進度同正式單據。
      </p>
      <Link to="/login" state={{ from: '/orders' }} className="btn btn-primary relative mt-4 w-full">
        登入會員睇詳情 →
      </Link>
      <p className="relative mt-3 text-center text-[12px] text-txt-3">
        唔記得密碼／帳號有問題？
        <a
          href={`${WHATSAPP_URL}?text=${encodeURIComponent(`你好，我嘅會員訂單 ${result.orderNo} 想查詳情，但登入唔到。`)}`}
          target="_blank"
          rel="noreferrer"
          className="text-gold underline underline-offset-4"
        >
          WhatsApp 我哋
        </a>
      </p>
    </div>
  );
}

/** 訪客查單結果下面嘅註冊推薦（bento 著數格） */
function RegisterUpsell({ phone }: { phone: string }) {
  const benefits = [
    { icon: Crown, title: 'VIP 折扣價', desc: '會員專屬折扣，等級愈高愈著數' },
    { icon: Gem, title: '落單儲積分', desc: '每張單自動儲分，換購物優惠' },
    { icon: ReceiptText, title: '訂單自動記低', desc: '唔使再輸入單號，一撳查晒' },
    { icon: Gift, title: '生日月份禮遇', desc: '生日嗰個月有專屬驚喜' },
  ];
  return (
    <div
      className="w-full rounded-2xl border p-6"
      style={{
        background: 'var(--glass-bg-strong)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderColor: 'var(--glass-border)',
        animation: 'promo-fade-in .25s ease-out',
      }}
    >
      <p className="script text-2xl">Join the family ✦</p>
      <h3 className="mt-1 font-serif-tc text-lg font-semibold text-txt-1">開個帳號，著數多好多</h3>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {benefits.map((b) => (
          <div key={b.title} className="rounded-xl border px-3 py-2.5" style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}>
            <b.icon size={15} className="text-gold" aria-hidden="true" />
            <p className="mt-1.5 text-[13px] font-semibold text-txt-1">{b.title}</p>
            <p className="mt-0.5 text-[11.5px] leading-[1.5] text-txt-3">{b.desc}</p>
          </div>
        ))}
      </div>
      <Link
        to={/^\d{8}$/.test(phone) ? `/register?phone=${phone}` : '/register'}
        className="btn btn-primary mt-4 w-full"
      >
        免費註冊會員 →
      </Link>
      <p className="mt-2 text-center text-[12px] text-txt-3">
        用返落單電話註冊，之後落單唔使再填資料，仲可以將呢張單移入會員旗下
      </p>
    </div>
  );
}

export default function MyOrders() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  // 我的訂單日期搜尋（空字串 = 唔篩）
  const [orderDate, setOrderDate] = useState('');
  // 訪客單移入（2026-10-09）：登入狀態下帶 ?guest=<orderNo>&token=<uuid> 入嚟（撳「移入會員訂單」去登入返嚟，
  // 或者登入中撳 email 魔法連結）→ 彈確認框問「是否將該訪客訂單移入至你的會員旗下？」
  const [params] = useSearchParams();
  const claimOrderNo = params.get('guest') ?? '';
  const claimToken = params.get('token') ?? '';
  const [claimDismissed, setClaimDismissed] = useState(false);

  const ordersQuery = trpc.orders.myOrders.useQuery(undefined, { enabled: !!user });

  /** 移入框關閉／完成：清走 URL params（唔好 refresh 又彈），完成時 refetch 訂單列表 */
  const clearClaimParams = (claimed: boolean) => {
    setClaimDismissed(true);
    if (claimed) void utils.orders.myOrders.invalidate();
    void navigate('/orders', { replace: true });
  };
  // orderItems 無商品圖快照，用 products.list 對照 productId 攞縮圖
  const productsQuery = trpc.products.list.useQuery();

  const productImages = useMemo(() => {
    const map: Record<number, string> = {};
    for (const p of productsQuery.data ?? []) map[p.id] = p.image;
    return map;
  }, [productsQuery.data]);

  // 驗證會員 session 中
  if (isLoading) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        <WishingStar size={32} spinning />
      </section>
    );
  }

  // 未登入：上會員登入卡＋下訪客查單卡（2026-10-09 訪客購買）
  if (!user) {
    return (
      <section className="mx-auto flex min-h-[calc(100dvh-60px)] w-full max-w-[1280px] flex-col items-center justify-center px-5 py-24 md:min-h-[calc(100dvh-72px)] md:px-8 xl:px-12">
        {/* 上：會員登入區（主路徑） */}
        <div
          className="flex w-full max-w-[420px] flex-col items-center gap-6 rounded-2xl border p-8 text-center"
          style={{
            background: 'var(--glass-bg-strong)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderColor: 'var(--glass-border)',
          }}
        >
          <WishingStar size={36} />
          <div>
            <h1 className="font-serif-tc text-2xl font-semibold leading-[1.3] text-txt-1">會員登入</h1>
            <p className="mt-2 text-[15px] text-txt-2">會員登入就睇晒全部訂單，仲有 VIP 折扣同積分。</p>
          </div>
          <Link to="/login" state={{ from: '/orders' }} className="btn btn-primary w-full">
            去登入
          </Link>
        </div>

        {/* 分隔：金線小標 */}
        <p className="my-6 flex items-center gap-3" aria-hidden="true">
          <span className="h-px w-10" style={{ background: 'linear-gradient(90deg, transparent, var(--gold))' }} />
          <span className="font-mono text-[10px] font-bold tracking-[0.32em] text-txt-3">或者 OR</span>
          <span className="h-px w-10" style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }} />
        </p>

        {/* 下：訪客查單區 */}
        <GuestLookupSection />
      </section>
    );
  }

  const orders = ordersQuery.data ?? [];
  const filteredOrders = orderDate
    ? orders.filter((o) => sameLocalDay(o.createdAt, orderDate))
    : orders;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">My wishes</p>
      <div className="mt-2 flex items-baseline justify-between gap-4">
        <h1 className="font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">我的訂單</h1>
        {orders.length > 0 && <span className="font-mono text-sm text-txt-3">{orders.length} 張</span>}
      </div>
      <p className="mt-3 max-w-xl text-[15px] text-txt-2">
        未過數嘅單可以喺下面即場網上付款，或者上傳付款截圖。
      </p>

      {/* 按日期搜尋訂單 */}
      {orders.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label
            className="flex h-11 items-center gap-2 rounded-full border px-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <Calendar size={15} className="shrink-0 text-txt-3" aria-hidden="true" />
            <input
              type="date"
              value={orderDate}
              onChange={(e) => setOrderDate(e.target.value)}
              aria-label="按日期搜尋訂單"
              className="bg-transparent font-mono text-[13px] text-txt-1 focus:outline-none"
            />
          </label>
          {orderDate && (
            <>
              <button
                type="button"
                onClick={() => setOrderDate('')}
                className="text-[13px] text-lavender underline underline-offset-4 transition-colors hover:text-txt-1"
              >
                清除日期
              </button>
              <span className="font-mono text-[12px] text-txt-3">{filteredOrders.length} 張符合</span>
            </>
          )}
        </div>
      )}

      {ordersQuery.isLoading ? (
        <div className="flex justify-center py-20">
          <WishingStar size={28} spinning />
        </div>
      ) : ordersQuery.isError ? (
        <p role="alert" className="mt-6 rounded-xl border border-pink bg-space-2 px-4 py-3 text-[13px] text-pink-soft">
          訂單載入失敗，請稍後重新整理。
        </p>
      ) : orders.length === 0 ? (
        /* 空訂單狀態 */
        <div className="mt-8 flex flex-col items-center gap-5 rounded-2xl border border-space-line bg-space-2 px-6 py-16 text-center">
          <img src="/empty-cart.svg" alt="" className="h-32 w-auto opacity-90" loading="lazy" />
          <p className="script text-3xl">No wishes yet</p>
          <p className="max-w-sm text-[15px] text-txt-2">你仲未有訂單。去揀件啱心水嘅衫，許個願先啦。</p>
          <Link to="/products" className="btn btn-secondary">
            去揀衫
          </Link>
        </div>
      ) : filteredOrders.length === 0 ? (
        <p className="mt-6 rounded-xl border border-space-line bg-space-2 px-4 py-6 text-center text-[14px] text-txt-3">
          呢一日冇訂單，揀另一日睇睇。
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {filteredOrders.map((order) => (
            <OrderCard key={order.id} order={order} productImages={productImages} />
          ))}
        </div>
      )}

      {/* 訪客單移入確認框（登入中帶 guest+token 連結入嚟先彈） */}
      {claimOrderNo && claimToken && !claimDismissed && (
        <ClaimGuestOrderModal
          orderNo={claimOrderNo}
          guestToken={claimToken}
          onClose={() => clearClaimParams(false)}
          onClaimed={() => clearClaimParams(true)}
        />
      )}
    </section>
  );
}

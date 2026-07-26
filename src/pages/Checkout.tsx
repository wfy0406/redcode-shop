import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Check, Copy, MessageCircle } from 'lucide-react';
import DuotoneImage from '@/components/DuotoneImage';
import LoginPrompt from '@/components/cart/LoginPrompt';
import PaymentDropzone from '@/components/cart/PaymentDropzone';
import { StarGlyph, WishStarBurst, WishStarSpinner } from '@/components/cart/WishingStar';
import { formatHKD } from '@/components/cart/format';
import { cartSubtotal, lineTotal, unitPrice } from '@/components/cart/types';
import type { CartLine, CreatedOrder } from '@/components/cart/types';
import { trpc } from '@/providers/trpc';
import { useAuth } from '@/hooks/useAuth';
import { getToken } from '@/lib/auth';

/**
 * RedCode 結帳（design-system.md §P7，含付款截圖上傳）
 * 三步玻璃進度條（步驟點 = 四角星，完成步驟填金）：
 * ① 確認訂單：cart 項目 + 總計；收貨地址 textarea（預填 user.address）+ 備註
 * ② 付款：orders.create → 收款資料卡（FPS 轉數快／銀行轉帳 佔位 + TODO 換真資料）
 *    + dropzone 上傳付款截圖（fetch POST /api/upload，Bearer token）→ orders.attachPaymentProof
 * ③ 完成：許願星著燈 + 訂單編號 + 「職員審核中」+ 去會員中心 CTA
 * 未登入：玻璃卡提示（同 Cart）
 */

// TODO: 換返 RedCode 真 WhatsApp 號碼
const WHATSAPP_URL = 'https://wa.me/85200000000';

// TODO: 換返 RedCode 真收款資料（而家係佔位，上線前必換）
const PAYMENT_METHODS = [
  {
    label: 'FPS 轉數快',
    account: '9123 4567',
    hint: '戶口名稱：RedCode HK Limited',
    copyValue: '91234567',
  },
  {
    label: '銀行轉帳',
    account: 'HSBC 123-456789-001',
    hint: '戶口名稱：RedCode HK Limited',
    copyValue: '123-456789-001',
  },
] as const;

const STEP_LABELS = ['確認訂單', '付款', '完成'] as const;

/** 上傳／attach 錯誤翻譯（api/boot.ts / ordersRouter 嘅英文訊息 → 中文提示） */
function friendlyUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : '';
  if (raw.includes('Only jpg/png/webp')) return '只支援 JPG / PNG / WebP 圖片';
  if (raw.includes('File too large')) return '檔案大過 10MB，請壓縮細啲再試';
  if (raw === 'Unauthorized' || raw.includes('401')) return '登入已過期，請重新登入後再試';
  if (raw.includes('唔可以上傳付款證明') || raw.includes('訂單不存在')) return raw;
  if (raw === 'Failed to fetch' || raw.includes('NetworkError')) return '網絡唔穩定，請再試一次';
  return raw || '上傳失敗，請再試一次';
}

/* ---------- 複製鈕（DM Mono 帳號 / 訂單編號用） ---------- */
function CopyButton({ text, label = '複製' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard 唔可用就靜默（用戶仍可手動抄）
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      className="btn btn-secondary !px-4 !py-2 !text-[13px]"
      aria-label={`${label} ${text}`}
    >
      {copied ? (
        <>
          <Check size={14} aria-hidden="true" /> 已複製
        </>
      ) : (
        <>
          <Copy size={14} aria-hidden="true" /> {label}
        </>
      )}
    </button>
  );
}

/* ---------- 三步玻璃進度條（步驟點 = 四角星，完成填金） ---------- */
function StepBar({ step }: { step: number }) {
  return (
    <ol
      className="mt-8 flex items-center gap-2 rounded-2xl border px-4 py-4 md:gap-3 md:px-6"
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderColor: 'var(--glass-border)',
      }}
      aria-label="結帳進度"
    >
      {STEP_LABELS.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none md:gap-3">
            <span
              className="flex shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <StarGlyph
                size={current ? 22 : 18}
                color={done ? 'var(--gold)' : current ? 'var(--pink)' : 'var(--space-4)'}
              />
            </span>
            <span
              className={`truncate text-sm md:text-[15px] ${
                done ? 'text-gold' : current ? 'font-medium text-txt-1' : 'text-txt-3'
              }`}
              aria-current={current ? 'step' : undefined}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 && (
              <span
                className="mx-1 h-px min-w-4 flex-1 md:mx-2"
                style={{ background: done ? 'var(--gold)' : 'var(--space-line)' }}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- §3.7 流星頭進度條（上傳中） ---------- */
const METEOR_STYLES = `
@keyframes meteor-run { from { transform: translateX(-110%); } to { transform: translateX(260%); } }
.meteor-segment { animation: meteor-run 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .meteor-segment { animation: none; transform: translateX(60%); } }
`;

function MeteorProgressBar() {
  return (
    <div className="mt-5" role="status" aria-label="上傳中">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-space-4">
        <span
          className="meteor-segment absolute inset-y-0 left-0 w-2/5 rounded-full"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--gold))',
          }}
        />
      </div>
      <p className="mt-2.5 flex items-center justify-center gap-2 text-[13px] text-txt-3">
        <WishStarSpinner size={14} />
        上傳緊，唔好閂頁面…
      </p>
      <style>{METEOR_STYLES}</style>
    </div>
  );
}

/* ---------- ① 確認訂單 ---------- */
interface ConfirmStepProps {
  items: CartLine[];
  onCreated: (order: CreatedOrder) => void;
}

function ConfirmStep({ items, onCreated }: ConfirmStepProps) {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const createOrder = trpc.orders.create.useMutation();

  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 預填會員地址（唔覆蓋用戶已改嘅內容）
  useEffect(() => {
    const saved = user?.address;
    if (saved) setAddress((prev) => (prev.trim() ? prev : saved));
  }, [user?.address]);

  const subtotal = cartSubtotal(items);

  const onCreate = async () => {
    setError(null);
    try {
      const created = await createOrder.mutateAsync({
        address: address.trim() || undefined,
        note: note.trim() || undefined,
      });
      // 後端已清車，invalidate 令購物車頁 / badge 同步
      void utils.cart.list.invalidate();
      onCreated(created as CreatedOrder);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err instanceof Error ? err.message : '建立訂單失敗，請再試一次');
    }
  };

  if (items.length === 0) {
    return (
      <div className="mt-14 flex flex-col items-center pb-8 text-center">
        <img src="/empty-cart.png" alt="" className="w-52 max-w-full md:w-64" />
        <p className="mt-6 font-serif-tc text-2xl font-semibold text-txt-1">購物車係空嘅</p>
        <p className="mt-2 max-w-sm text-[15px] text-txt-2">
          未有嘢好結帳喎，去揀件衫先啦。
        </p>
        <Link to="/products" className="btn btn-secondary mt-8">
          去逛逛
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* 左：訂單項目 */}
      <div>
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">訂單內容</h2>
        <ul className="mt-4 divide-y" style={{ borderColor: 'var(--space-line)' }}>
          {items.map((line) => {
            const unit = unitPrice(line);
            return (
              <li key={line.id} className="flex items-center gap-4 py-4">
                <DuotoneImage
                  src={line.product.image}
                  alt={line.product.name}
                  wrapperClassName="h-16 w-16 shrink-0 rounded-lg border"
                  className="h-full w-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-txt-1">{line.product.name}</p>
                  <p className="mt-0.5 font-mono text-[13px] text-txt-3">
                    {line.product.sku}
                    {line.size ? ` · 尺寸 ${line.size}` : ''}
                  </p>
                  <p className="mt-1 font-mono text-sm text-txt-2">
                    {line.quantity} × {formatHKD(unit)}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-base text-txt-1">
                  {formatHKD(lineTotal(line))}
                </p>
              </li>
            );
          })}
        </ul>
        <div
          className="flex items-baseline justify-between border-t pt-4"
          style={{ borderColor: 'var(--space-line)' }}
        >
          <span className="text-[15px] text-txt-2">總計（運費順豐到付）</span>
          <span className="font-mono text-2xl text-pink">{formatHKD(subtotal)}</span>
        </div>
      </div>

      {/* 右：收貨資料（§4.6 表單） */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">收貨資料</h2>

        <div className="mt-5">
          <label htmlFor="checkout-address" className="text-sm text-txt-2">
            收貨地址（選填）
          </label>
          <textarea
            id="checkout-address"
            rows={3}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="住宅地址 / 順豐站 / 智能櫃 / 自取點…"
            className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] leading-relaxed text-txt-1 placeholder:text-txt-disabled focus:border-pink"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>

        <div className="mt-4">
          <label htmlFor="checkout-note" className="text-sm text-txt-2">
            備註（選填）
          </label>
          <textarea
            id="checkout-note"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：想邊日收貨、直播講過嘅要求…"
            className="mt-2 w-full rounded-xl border bg-space-2 p-4 text-[15px] leading-relaxed text-txt-1 placeholder:text-txt-disabled focus:border-pink"
            style={{ borderColor: 'var(--space-line)' }}
          />
        </div>

        {error && (
          <p role="alert" className="mt-4 flex items-center gap-2 text-[13px] text-pink-soft">
            <StarGlyph size={12} className="shrink-0" />
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void onCreate()}
          disabled={createOrder.isPending}
          className="btn btn-primary mt-6 w-full disabled:opacity-70"
        >
          {createOrder.isPending ? <WishStarSpinner /> : '建立訂單，去付款'}
        </button>
        <p className="mt-3 text-center text-[13px] text-txt-3">
          建立訂單後先好過數，購物車會即時清空
        </p>
      </div>
    </div>
  );
}

/* ---------- ② 付款（收款資料 + 截圖上傳） ---------- */
interface PaymentStepProps {
  order: CreatedOrder;
  onDone: () => void;
}

function PaymentStep({ order, onDone }: PaymentStepProps) {
  const utils = trpc.useUtils();
  const attachProof = trpc.orders.attachPaymentProof.useMutation();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // preview object URL 要記得 revoke
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onSelect = (selected: File) => {
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
  };

  const onUpload = async () => {
    if (!file) {
      setError('請先揀返張付款截圖');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      // 1) 上傳圖片去 /api/upload（multipart form-data，欄位名 file，Bearer JWT）
      const form = new FormData();
      form.append('file', file);
      const token = getToken();
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const data = (await res.json().catch(() => null)) as {
        path?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.path) {
        throw new Error(data?.error ?? `上傳失敗（HTTP ${res.status}）`);
      }

      // 2) 將 path 掛上訂單（狀態轉 payment_review）
      await attachProof.mutateAsync({ orderId: order.id, imagePath: data.path });
      void utils.orders.myOrders.invalidate();
      onDone();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(friendlyUploadError(err));
      setUploading(false);
    }
  };

  return (
    <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* 左：收款資料卡 */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <p className="text-sm text-txt-2">應付金額</p>
        <p className="mt-1 font-mono text-[32px] leading-[1.2] text-pink">
          {formatHKD(order.total)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm text-txt-3">訂單編號</span>
          <span className="font-mono text-sm text-txt-1">{order.orderNo}</span>
          <CopyButton text={order.orderNo} />
        </div>

        <ul className="mt-6 space-y-3">
          {PAYMENT_METHODS.map((method) => (
            <li
              key={method.label}
              className="flex items-center justify-between gap-4 rounded-xl border p-4"
              style={{
                borderColor: 'var(--glass-border)',
                background: 'rgba(255,255,255,.03)',
              }}
            >
              <div className="min-w-0">
                <p className="font-medium text-txt-1">{method.label}</p>
                <p className="mt-1 font-mono text-sm text-lavender">{method.account}</p>
                <p className="mt-0.5 text-[13px] text-txt-3">{method.hint}</p>
              </div>
              <CopyButton text={method.copyValue} />
            </li>
          ))}
        </ul>

        <p className="mt-5 text-[13px] leading-relaxed text-txt-3">
          過數嗰陣喺備註寫返訂單編號，對數會快啲。過完數喺右邊上傳截圖。
        </p>
      </div>

      {/* 右：付款截圖上傳 */}
      <div
        className="h-fit rounded-2xl border p-6"
        style={{
          background: 'var(--glass-bg-strong)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderColor: 'var(--glass-border)',
        }}
      >
        <h2 className="font-serif-tc text-xl font-semibold text-txt-1">上傳付款截圖</h2>
        <div className="mt-4">
          <PaymentDropzone
            file={file}
            previewUrl={previewUrl}
            disabled={uploading}
            onSelect={onSelect}
          />
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-txt-3">
          上傳後 Glo Glo 團隊會盡快對數，WhatsApp 通知你 💫
        </p>

        {error && (
          <p role="alert" className="mt-3 flex items-center gap-2 text-[13px] text-pink-soft">
            <StarGlyph size={12} className="shrink-0" />
            {error}
          </p>
        )}

        {uploading ? (
          <MeteorProgressBar />
        ) : (
          <button
            type="button"
            onClick={() => void onUpload()}
            disabled={!file || attachProof.isPending}
            className="btn btn-primary mt-5 w-full disabled:opacity-50"
          >
            上傳付款截圖
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- ③ 完成 ---------- */
function SuccessStep({ order }: { order: CreatedOrder }) {
  const whatsappTrack = `${WHATSAPP_URL}?text=${encodeURIComponent(
    `你好，想查詢訂單 ${order.orderNo} 嘅狀態`,
  )}`;

  return (
    <div className="mt-14 flex flex-col items-center pb-8 text-center">
      <WishStarBurst />
      <p className="script mt-8 text-4xl md:text-5xl">Thank you, wish granted!</p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <span className="text-sm text-txt-3">訂單編號</span>
        <span className="font-mono text-xl text-txt-1 md:text-2xl">{order.orderNo}</span>
        <CopyButton text={order.orderNo} label="複製訂單編號" />
      </div>

      <p className="mt-5 max-w-md text-[15px] leading-relaxed text-txt-2">
        付款截圖已收到，而家<span className="font-medium text-gold">職員審核中</span>。
        Glo Glo 團隊對完數會 WhatsApp 通知你，一般一個工作天內搞掂。
        你可以隨時去會員中心睇訂單狀態。
      </p>

      <div className="mt-8 flex flex-wrap justify-center gap-4">
        <Link to="/account" className="btn btn-primary">
          去會員中心睇訂單
        </Link>
        <a
          href={whatsappTrack}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-whatsapp"
        >
          <MessageCircle size={16} aria-hidden="true" />
          WhatsApp 追蹤訂單
        </a>
      </div>
    </div>
  );
}

/* ---------- 頁面 ---------- */
export default function Checkout() {
  const { user, isLoading: authLoading } = useAuth();

  const cartQuery = trpc.cart.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const [step, setStep] = useState(0);
  const [order, setOrder] = useState<CreatedOrder | null>(null);

  const items = (cartQuery.data ?? []) as CartLine[];

  const renderStep = () => {
    if (step === 2 && order) return <SuccessStep order={order} />;
    if (step === 1 && order) {
      return <PaymentStep order={order} onDone={() => setStep(2)} />;
    }
    if (cartQuery.isLoading) {
      return (
        <div className="mt-10 space-y-4" aria-label="訂單載入中">
          {[0, 1].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-space-2" />
          ))}
        </div>
      );
    }
    if (cartQuery.isError) {
      return (
        <div
          className="mx-auto mt-12 max-w-[420px] rounded-3xl border p-8 text-center"
          style={{ background: 'var(--glass-bg-strong)', borderColor: 'var(--glass-border)' }}
        >
          <p role="alert" className="text-[15px] text-pink-soft">
            購物車載入失敗：{cartQuery.error.message}
          </p>
          <button
            type="button"
            className="btn btn-secondary mt-6"
            onClick={() => void cartQuery.refetch()}
          >
            再試一次
          </button>
        </div>
      );
    }
    return (
      <ConfirmStep
        items={items}
        onCreated={(created) => {
          setOrder(created);
          setStep(1);
        }}
      />
    );
  };

  return (
    <section className="mx-auto max-w-[1280px] px-5 py-12 md:px-8 md:py-16 xl:px-12">
      <p className="script text-3xl">Checkout</p>
      <h1 className="mt-2 font-serif-tc text-3xl font-bold leading-[1.2] text-txt-1 md:text-[44px]">
        結帳
      </h1>

      {authLoading ? (
        <div className="mt-10 h-24 animate-pulse rounded-2xl bg-space-2" aria-label="載入中" />
      ) : !user ? (
        <LoginPrompt message="登入會員之後，先可以結帳同上傳付款截圖。" />
      ) : (
        <>
          <StepBar step={step} />
          {renderStep()}
        </>
      )}
    </section>
  );
}

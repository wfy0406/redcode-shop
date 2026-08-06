import { useState } from 'react';
import { ImagePlus, Mail, Send, Users, X } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { getToken } from '@/lib/auth';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 促銷電郵（2026-08-05 Glo 要求）—— promo.marketingAudience / promo.sendMarketingEmail
 * 左：撰寫電郵（主旨＋內文＋選填優惠碼＋選填圖片最多 3 張）＋即時預覽（款同官網 branded 電郵一樣）；
 * 右：收件人數（註冊時剔咗同意收推廣嘅會員）＋兩步確認寄出。
 * 合規：每封底部由系統自動附加「免費拒絕接收」方法（PDPO 第 6A 部），呢度改唔到。
 * 圖片（2026-08-05 Glo 要求）：經 /api/upload 上傳去網站 disk（同付款截圖同一套），
 * 電郵入面用絕對 URL 顯示，順序排喺內文下面、優惠碼之前。
 */

const inputCls =
  'h-11 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[14px] text-txt-1 placeholder:text-txt-disabled focus:border-pink';

export default function MarketingEmailCard({
  toast,
}: {
  toast: (text: string, kind?: ToastKind) => void;
}) {
  const audienceQuery = trpc.promo.marketingAudience.useQuery(undefined);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [promoCode, setPromoCode] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // 圖片上傳（2026-08-05）：經 /api/upload 落網站 disk，攞返 /uploads/xxx 路徑
  const uploadImage = async (file: File) => {
    setFormError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        throw new Error(data.error || '上傳失敗，請再試');
      }
      setImages((cur) => [...cur, data.path as string]);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '上傳失敗，請再試');
    } finally {
      setUploading(false);
    }
  };

  const sendMutation = trpc.promo.sendMarketingEmail.useMutation({
    onSuccess: (r) => {
      setConfirming(false);
      // 三級制（2026-08-06）：員工提交寄信會進入審批，主管/管理員批准先真係寄出
      if (r && 'pendingApproval' in r) {
        toast('已提交審批，主管/管理員批准後先會寄出 ⏳', 'info');
        return;
      }
      if (r && r.failed === 0) {
        toast(`已寄出促銷電郵畀 ${r.sent} 位會員 ✓`, 'success');
        setSubject('');
        setBody('');
        setPromoCode('');
        setImages([]);
      } else if (r) {
        toast(
          `寄出完成：成功 ${r.sent} 位、失敗 ${r.failed} 位${r.error ? `（${r.error}）` : ''}`,
          'info',
        );
      }
    },
    onError: (err) => {
      setConfirming(false);
      toast(err.message || '寄出失敗，請再試', 'error');
    },
  });

  const audience = audienceQuery.data?.count ?? 0;

  const trySend = () => {
    if (!subject.trim()) return setFormError('主旨必填');
    if (!body.trim()) return setFormError('內文必填');
    setFormError(null);
    setConfirming(true);
  };

  const doSend = () => {
    sendMutation.mutate({
      subject: subject.trim(),
      body: body.trim(),
      ...(promoCode.trim() ? { promoCode: promoCode.trim() } : {}),
      ...(images.length ? { imageUrls: images } : {}),
    });
  };

  // 預覽用：空行分段（同後端 sendMarketingEmail 嘅砌法一致）
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
      {/* 左：撰寫＋預覽（7） */}
      <div
        className="rounded-2xl border p-5 backdrop-blur-xl md:p-6 xl:col-span-7"
        style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
      >
        <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
          <Mail size={16} className="text-gold" aria-hidden="true" />
          撰寫促銷電郵
        </h3>
        <div className="mt-5 flex flex-col gap-4">
          <div>
            <label htmlFor="mk-subject" className="mb-1.5 block text-[14px] text-txt-2">
              主旨 *
            </label>
            <input
              id="mk-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className={inputCls}
              placeholder="例如：夏日新貨上架，會員率先睇"
              maxLength={80}
            />
            <p className="mt-1 text-[12px] text-txt-3">寄出時會自動加「【RedCode】」前綴。</p>
          </div>
          <div>
            <label htmlFor="mk-body" className="mb-1.5 block text-[14px] text-txt-2">
              內文 *
            </label>
            <textarea
              id="mk-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              className="w-full rounded-xl border border-space-line bg-space-2 px-4 py-3 text-[14px] leading-relaxed text-txt-1 placeholder:text-txt-disabled focus:border-pink focus:outline-none"
              placeholder={'同寶寶們講下今期有咩筍嘢～\n\n空一行就會分段。'}
              maxLength={3000}
            />
            <p className="mt-1 text-[12px] text-txt-3">
              純文字就得，空一行分段；開頭會自動加「（會員名）寶寶，你好呀」，結尾有 Glo Glo 署名。
            </p>
          </div>
          <div>
            <label htmlFor="mk-code" className="mb-1.5 block text-[14px] text-txt-2">
              優惠碼（選填）
            </label>
            <input
              id="mk-code"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              className={`${inputCls} font-mono uppercase tracking-wider`}
              placeholder="填咗會喺電郵中間用品牌盒突出顯示"
              maxLength={32}
            />
            <p className="mt-1 text-[12px] text-txt-3">優惠碼要係已存在兼啟用中，先寄得出去。</p>
          </div>
          <div>
            <label className="mb-1.5 block text-[14px] text-txt-2">圖片（選填，最多 3 張）</label>
            <div className="flex flex-wrap items-center gap-3">
              {images.map((u) => (
                <div key={u} className="relative">
                  <img
                    src={u}
                    alt="已上傳嘅推廣圖片"
                    className="h-20 w-20 rounded-lg border object-cover"
                    style={{ borderColor: 'var(--space-line)' }}
                  />
                  <button
                    type="button"
                    onClick={() => setImages((cur) => cur.filter((x) => x !== u))}
                    aria-label="移除呢張圖"
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border text-txt-1 transition-colors hover:text-pink-soft"
                    style={{ borderColor: 'var(--space-line)', background: 'var(--space-1)' }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {images.length < 3 && (
                <label
                  className={`flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-[11px] text-txt-3 transition-colors hover:text-txt-1 ${uploading ? 'pointer-events-none opacity-60' : ''}`}
                  style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
                >
                  {uploading ? <WishingStar size={16} /> : <ImagePlus size={18} aria-hidden="true" />}
                  {uploading ? '上傳緊…' : '加圖'}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadImage(f);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>
            <p className="mt-1 text-[12px] text-txt-3">
              JPG／PNG／WebP，最大 10MB；會順序顯示喺內文下面、優惠碼之前。
            </p>
          </div>
        </div>
        {formError && (
          <p className="mt-3 flex items-center gap-1.5 text-[13px] text-pink-soft" role="alert">
            <span
              className="inline-block h-2 w-2 rotate-45"
              style={{ background: 'var(--gold)' }}
              aria-hidden="true"
            />
            {formError}
          </p>
        )}

        {/* 即時預覽（仿 branded 電郵：白卡＋粉紅 kicker＋serif 標題） */}
        <div className="mt-6">
          <p className="mb-2 text-[12px] tracking-[0.08em] text-txt-3">預覽（大概效果）</p>
          <div className="rounded-xl bg-[#f5f2ec] p-4">
            <div className="mx-auto max-w-[440px] border bg-white px-6 py-6" style={{ borderColor: '#e7e1d6' }}>
              <p
                className="text-[10px] font-bold"
                style={{ letterSpacing: '3px', color: '#e6007e' }}
              >
                REDCODE · 優惠速遞
              </p>
              <p className="mt-2 font-serif-tc text-[20px] font-bold leading-[1.4] text-[#17140f]">
                {subject.trim() || '（主旨會喺呢度出現）'}
              </p>
              <div className="my-4 border-t" style={{ borderColor: '#e7e1d6' }} />
              <div className="text-[13.5px] leading-[1.9] text-[#3f3a33]">
                <p>（會員名）寶寶，你好呀 💕</p>
                {paragraphs.length === 0 ? (
                  <p className="mt-2 text-[#b3aa9c]">（內文會喺呢度出現）</p>
                ) : (
                  paragraphs.map((p, i) => (
                    <p key={i} className="mt-2 whitespace-pre-wrap">
                      {p}
                    </p>
                  ))
                )}
                {images.map((u) => (
                  <img key={u} src={u} alt="推廣圖片" className="mt-3 w-full rounded-lg" />
                ))}
                {promoCode.trim() && (
                  <div
                    className="mt-4 border px-4 py-4 text-center"
                    style={{ borderColor: '#e7e1d6', background: '#faf8f2' }}
                  >
                    <p className="text-[10px] font-bold" style={{ letterSpacing: '2px', color: '#b3aa9c' }}>
                      今期優惠碼
                    </p>
                    <p
                      className="mt-1.5 font-serif-tc text-[22px] font-bold text-[#17140f]"
                      style={{ letterSpacing: '5px' }}
                    >
                      {promoCode.trim()}
                    </p>
                  </div>
                )}
                <div className="mt-5 text-center">
                  <span className="inline-block bg-[#17140f] px-8 py-2.5 text-[11px] font-bold tracking-[3px] text-white">
                    去官網睇新貨
                  </span>
                </div>
                <p className="mt-4 text-[11.5px] leading-[1.8] text-[#8d857a]">
                  呢封係推廣電郵……如果唔想再收到，隨時可以去我哋官網<span style={{ color: '#e6007e' }}>會員中心</span>嘅「優惠資訊」停用咗佢，系統會將你喺推廣名單剔除。（呢段系統自動附加）
                </p>
                <p className="mt-3">
                  期待喺直播間見到你 ✦
                  <br />
                  Glo Glo 上
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 右：收件人＋寄出（5） */}
      <div className="xl:col-span-5">
        <div
          className="rounded-2xl border p-5 backdrop-blur-xl md:p-6"
          style={{ borderColor: 'var(--glass-border)', background: 'var(--glass-bg)' }}
        >
          <h3 className="flex items-center gap-2 text-[16px] font-bold text-txt-1">
            <Users size={16} className="text-lavender" aria-hidden="true" />
            收件人
          </h3>
          {audienceQuery.isLoading ? (
            <LoadingBlock text="許願星數緊人…" />
          ) : audienceQuery.isError ? (
            <p className="py-6 text-center text-[14px] text-pink-soft">
              載入失敗：{audienceQuery.error.message}
            </p>
          ) : (
            <>
              <p className="mt-4 font-mono text-[40px] leading-none text-gold">{audience}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-txt-2">
                位會員註冊時剔咗「同意接收推廣資訊」，呢封電郵<strong>只會</strong>寄畀佢哋。
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-txt-3">
                冇同意嘅會員一律唔會收到（私隱政策第 7 節承諾）。想多啲人收到，就喺直播提提寶寶哋註冊時剔選接收推廣。
              </p>
            </>
          )}

          {/* 寄出（兩步確認） */}
          <div className="mt-6 border-t pt-5" style={{ borderColor: 'var(--space-line)' }}>
            {confirming ? (
              <div>
                <p className="text-[14px] font-bold text-txt-1">
                  確認寄出畀 {audience} 位會員？
                </p>
                <p className="mt-1 text-[13px] text-txt-3">
                  寄出後唔收得返，主旨同內文請再對一次。
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={doSend}
                    disabled={sendMutation.isPending}
                    className="btn btn-primary flex-1 disabled:opacity-60"
                  >
                    {sendMutation.isPending ? <WishingStar size={16} /> : <Send size={15} aria-hidden="true" />}
                    {sendMutation.isPending ? '寄出緊…' : '確認寄出'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={sendMutation.isPending}
                    className="btn btn-secondary"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={trySend}
                disabled={audienceQuery.isLoading || audience === 0}
                className="btn btn-primary w-full disabled:opacity-60"
              >
                <Send size={16} aria-hidden="true" />
                寄出促銷電郵
              </button>
            )}
            {audience === 0 && !audienceQuery.isLoading && (
              <p className="mt-2 text-center text-[12px] text-txt-3">
                暫時冇會員同意接收推廣，未有收件人。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

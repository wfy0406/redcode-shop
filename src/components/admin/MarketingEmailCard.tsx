import { useState } from 'react';
import { Mail, Send, Users } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import WishingStar, { LoadingBlock } from './WishingStar';
import type { ToastKind } from './useToasts';

/**
 * 促銷電郵（2026-08-05 Glo 要求）—— promo.marketingAudience / promo.sendMarketingEmail
 * 左：撰寫電郵（主旨＋內文＋選填優惠碼）＋即時預覽（款同官網 branded 電郵一樣）；
 * 右：收件人數（註冊時剔咗同意收推廣嘅會員）＋兩步確認寄出。
 * 合規：每封底部由系統自動附加「免費拒絕接收」方法（PDPO 第 6A 部），呢度改唔到。
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
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const sendMutation = trpc.promo.sendMarketingEmail.useMutation({
    onSuccess: (r) => {
      setConfirming(false);
      if (r && r.failed === 0) {
        toast(`已寄出促銷電郵畀 ${r.sent} 位會員 ✓`, 'success');
        setSubject('');
        setBody('');
        setPromoCode('');
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
                  呢封係推廣電郵……如果唔想再收到，隨時 WhatsApp 或 E-Mail 話我哋知，我哋會免費將你喺推廣名單剔除。（呢段系統自動附加）
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

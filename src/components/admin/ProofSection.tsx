import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { AdminOrder, AdminProof, ReviewHandler } from './types';
import { fmtDateTime } from './format';
import WishingStar from './WishingStar';

/**
 * 付款截圖審批區 —— 訂單詳情入面顯示所有 proofs
 * - 大圖顯示，click 開燈箱
 * - pending proof：「批准 A」（--success 實心深字）/「拒絕 R」（--pink 描邊，必填原因 + 備註）
 */

const REJECT_REASONS = ['金額不符', '睇唔到入數資料', '截圖模糊不清', '重複上傳', '其他'];

const PROOF_STATUS_META: Record<AdminProof['status'], { label: string; className: string }> = {
  pending: { label: '待審批', className: 'border-gold/70 text-gold' },
  approved: { label: '已批准', className: 'border-success/60 text-success' },
  rejected: { label: '已拒絕', className: 'border-pink/70 text-pink-soft' },
};

interface ProofSectionProps {
  order: AdminOrder;
  onReview: ReviewHandler;
  reviewingProofId: number | null;
  onOpenLightbox: (src: string) => void;
  /** 大圖模式（審批工作枱右欄） */
  large?: boolean;
}

/** 鍵盤 R 用：父層經 ref 打開指定 proof 嘅拒絕表單 */
export interface ProofSectionHandle {
  openRejectForm: (proofId: number) => void;
}

const ProofSection = forwardRef<ProofSectionHandle, ProofSectionProps>(function ProofSection(
  { order, onReview, reviewingProofId, onOpenLightbox, large = false },
  ref,
) {
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [reason, setReason] = useState(REJECT_REASONS[0]);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    openRejectForm: (proofId: number) => {
      setRejectingId(proofId);
      setNote('');
      setNoteError(false);
    },
  }));

  // 拒絕表單打開後 focus 備註欄（DOM 操作，屬 external system）
  useEffect(() => {
    if (rejectingId != null) noteRef.current?.focus();
  }, [rejectingId]);

  if (order.proofs.length === 0) {
    return <p className="text-[14px] text-txt-3">未收到付款截圖。</p>;
  }

  const submitReject = (proof: AdminProof) => {
    const trimmed = note.trim();
    if (!trimmed) {
      setNoteError(true);
      noteRef.current?.focus();
      return;
    }
    const fullNote = reason === '其他' ? trimmed : `${reason}：${trimmed}`;
    onReview(proof.id, false, fullNote, order);
    setRejectingId(null);
    setNote('');
  };

  return (
    <div className="flex flex-col gap-5">
      {order.proofs.map((proof) => {
        const meta = PROOF_STATUS_META[proof.status];
        const busy = reviewingProofId === proof.id;
        const isRejecting = rejectingId === proof.id;
        return (
          <div
            key={proof.id}
            className="rounded-2xl border p-4"
            style={{ borderColor: 'var(--space-line)', background: 'var(--space-2)' }}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-[12px] leading-none ${meta.className}`}
                aria-label={`付款截圖狀態：${meta.label}`}
              >
                {meta.label}
              </span>
              <span className="font-mono text-[12px] text-txt-3">
                上傳 {fmtDateTime(proof.createdAt)}
              </span>
            </div>

            {/* 截圖大圖（click 開燈箱） */}
            <button
              type="button"
              onClick={() => onOpenLightbox(proof.imagePath)}
              className={`mt-3 block w-full overflow-hidden rounded-xl border text-left ${
                large ? 'max-h-[420px]' : 'max-h-56'
              }`}
              style={{ borderColor: 'var(--glass-border)' }}
              aria-label="放大付款截圖"
            >
              <img
                src={proof.imagePath}
                alt={`訂單 ${order.orderNo} 付款截圖`}
                className="h-full w-full object-contain"
                style={{ background: 'var(--space-0)' }}
                loading="lazy"
              />
            </button>

            {proof.status === 'pending' && (
              <div className="mt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onReview(proof.id, true, undefined, order)}
                    className="btn !px-6 !py-3 text-[14px] disabled:opacity-60"
                    style={{
                      background: 'var(--success)',
                      color: 'var(--space-1)',
                      boxShadow: '0 8px 24px rgba(94, 224, 160, 0.25)',
                    }}
                  >
                    {busy ? <WishingStar size={16} /> : <Check size={16} aria-hidden="true" />}
                    批准
                    <kbd className="rounded-md border border-space-1/40 px-1.5 py-0.5 font-mono text-[11px] leading-none">
                      A
                    </kbd>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setRejectingId(isRejecting ? null : proof.id);
                      setNote('');
                      setNoteError(false);
                    }}
                    className="btn !border !px-6 !py-3 text-[14px] disabled:opacity-60"
                    style={{
                      borderColor: 'var(--pink)',
                      color: 'var(--pink-soft)',
                      background: 'transparent',
                    }}
                  >
                    <X size={16} aria-hidden="true" />
                    拒絕
                    <kbd
                      className="rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none"
                      style={{ borderColor: 'var(--pink)' }}
                    >
                      R
                    </kbd>
                  </button>
                </div>

                {isRejecting && (
                  <div className="mt-4 flex flex-col gap-3">
                    <div>
                      <label
                        htmlFor={`reject-reason-${proof.id}`}
                        className="mb-1.5 block text-[14px] text-txt-2"
                      >
                        拒絕原因
                      </label>
                      <select
                        id={`reject-reason-${proof.id}`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        className="h-12 w-full rounded-xl border border-space-line bg-space-2 px-4 text-[15px] text-txt-1 focus:border-pink"
                      >
                        {REJECT_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor={`reject-note-${proof.id}`}
                        className="mb-1.5 block text-[14px] text-txt-2"
                      >
                        備註（必填，會話返畀會員知）
                      </label>
                      <textarea
                        id={`reject-note-${proof.id}`}
                        ref={noteRef}
                        value={note}
                        onChange={(e) => {
                          setNote(e.target.value);
                          if (e.target.value.trim()) setNoteError(false);
                        }}
                        rows={2}
                        placeholder="例如：入數金額同訂單總額唔同，請重新上傳"
                        className="w-full rounded-xl border border-space-line bg-space-2 px-4 py-3 text-[15px] text-txt-1 placeholder:text-txt-disabled focus:border-pink"
                        aria-invalid={noteError}
                      />
                      {noteError && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-pink-soft">
                          <span
                            className="inline-block h-2 w-2 rotate-45"
                            style={{ background: 'var(--gold)' }}
                            aria-hidden="true"
                          />
                          拒絕一定要填備註
                        </p>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => submitReject(proof)}
                        className="btn btn-primary !px-6 !py-2.5 text-[14px] disabled:opacity-60"
                      >
                        {busy ? <WishingStar size={16} /> : null}
                        確認拒絕
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectingId(null)}
                        className="btn btn-secondary !px-6 !py-2.5 text-[14px]"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {proof.status !== 'pending' && proof.reviewNote && (
              <p className="mt-3 text-[13px] text-txt-3">
                審批備註：<span className="text-txt-2">{proof.reviewNote}</span>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
});

export default ProofSection;

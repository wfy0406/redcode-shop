import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { trpc } from '@/providers/trpc';
import { getToken } from '@/lib/auth';
import WishingStar from './WishingStar';

/**
 * 員工代客上傳付款截圖（2026-07-30 新增）
 * 場景：客人唔識喺網站上傳，WhatsApp 將過數截圖傳畀 Glo／員工 → 喺訂單詳情度代上傳。
 * 流程同客人自己上傳完全一致（server 共用 attachProofCore）：
 *   /api/upload 攞 path → orders.staffAttachProof →
 *   訂單自動轉「付款審核」＋背景同步去 WMS 等回傳。
 * 揀咗圖即傳，唔使再撳確認；成功後訂單列表自動刷新（新 proof 出現、狀態轉審核中，
 * 呢個 component 會因 status 改變而自動收埋）。
 */

type Phase = 'idle' | 'uploading' | 'attaching' | 'done';

export default function ProofUpload({ orderId }: { orderId: number }) {
  const utils = trpc.useUtils();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attachMutation = trpc.orders.staffAttachProof.useMutation();
  const busy = phase === 'uploading' || phase === 'attaching';

  const onPick = async (file: File) => {
    setError(null);
    setPreview(URL.createObjectURL(file));
    try {
      // ① 先上傳圖檔攞 path（/api/upload：任何登入 JWT 都傳得，員工唔使特別權限）
      setPhase('uploading');
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) throw new Error(data.error ?? '上傳失敗，請再試一次');

      // ② 掛上訂單：server 會轉 payment_review + 背景同步 WMS
      setPhase('attaching');
      await attachMutation.mutateAsync({ orderId, imagePath: data.path });
      setPhase('done');

      // ③ 刷新列表：訂單狀態轉審核中 → 呢個上傳區自動收埋，ProofSection 顯示新截圖
      await Promise.all([
        utils.orders.adminList.invalidate(),
        utils.orders.wmsSyncStates.invalidate(),
      ]);
    } catch (e) {
      setPhase('idle');
      setPreview(null);
      setError(e instanceof Error ? e.message : '上傳失敗，請再試一次');
    } finally {
      // 清 input value，等同一張圖都可以再揀多次
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  if (phase === 'done') {
    return (
      <p
        className="mt-4 rounded-xl border px-4 py-3 text-[13px]"
        style={{ borderColor: 'var(--success)', color: 'var(--success)' }}
        role="status"
      >
        已收到截圖 ✓ 訂單已轉「付款審核」，同步緊去 WMS 審批。
      </p>
    );
  }

  return (
    <div
      className="mt-4 rounded-2xl border border-dashed p-4"
      style={{ borderColor: 'var(--gold)', background: 'transparent' }}
    >
      <p className="text-[13px] font-bold" style={{ color: 'var(--gold)' }}>
        代客上傳（員工用）
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-txt-3">
        客人 WhatsApp 傳嚟嘅過數截圖，喺度上傳 → 訂單即刻轉「付款審核」＋送去 WMS 審批。
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        aria-label="揀選付款截圖"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && !busy) void onPick(file);
        }}
      />

      {preview && (
        <div
          className="mt-3 max-h-40 overflow-hidden rounded-xl border"
          style={{ borderColor: 'var(--glass-border)' }}
        >
          <img
            src={preview}
            alt="代客上傳嘅付款截圖預覽"
            className="h-full w-full object-contain"
            style={{ background: 'var(--space-0)' }}
          />
        </div>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="btn mt-3 w-full !border !px-5 !py-2.5 text-[13px] disabled:opacity-60"
        style={{ borderColor: 'var(--gold)', color: 'var(--gold)', background: 'transparent' }}
      >
        {busy ? (
          <WishingStar size={14} />
        ) : (
          <ImagePlus size={16} aria-hidden="true" />
        )}
        {phase === 'uploading' ? '上傳緊…' : phase === 'attaching' ? '附加緊去訂單…' : '揀截圖上傳'}
      </button>

      {error && (
        <p role="alert" className="mt-2 text-[13px] text-pink-soft">
          {error}
        </p>
      )}
    </div>
  );
}

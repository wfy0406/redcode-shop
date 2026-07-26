import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { cn } from '@/lib/utils';
import { getToken } from '@/lib/auth';
import { trpc } from '@/providers/trpc';
import WishingStar from './WishingStar';

/**
 * RedCode 設計系統 §P7 —— 付款截圖上傳 dropzone（會員中心重用版）
 * 虛線 1.5px --purple-text、圓角 16px、中央金色四角星；
 * 揀檔後即時 validate（JPG/PNG/WEBP ≤ 10MB）→ POST /api/upload（Bearer JWT）
 * → trpc.orders.attachPaymentProof → 訂單轉「審核中」。
 */

const MAX_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface PaymentProofDropzoneProps {
  orderId: number;
  /** true = 重新上傳（之前被拒絕） */
  reupload?: boolean;
}

function validateFile(file: File): string | null {
  if (!ALLOWED_TYPES.includes(file.type)) return '只支援 JPG / PNG / WEBP 圖片';
  if (file.size > MAX_SIZE) return '圖片大過 10MB，請壓縮後再試';
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function PaymentProofDropzone({ orderId, reupload = false }: PaymentProofDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const utils = trpc.useUtils();
  const attachProof = trpc.orders.attachPaymentProof.useMutation();

  const hintId = `proof-hint-${orderId}`;
  const errorId = `proof-error-${orderId}`;

  // 清理 preview object URL
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const resetInput = () => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const startUpload = async (selected: File) => {
    setUploading(true);
    setError(null);
    try {
      const token = getToken();
      const form = new FormData();
      form.append('file', selected);
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '上傳失敗，請稍後再試');
      }
      const { path } = (await res.json()) as { path: string };
      await attachProof.mutateAsync({ orderId, imagePath: path });
      await utils.orders.myOrders.invalidate();
      // 成功後訂單會轉 payment_review，dropzone 會隨狀態消失
    } catch (err) {
      setFile(null);
      setPreviewUrl(null);
      resetInput();
      setError(err instanceof Error && err.message ? err.message : '上傳失敗，請稍後再試');
    } finally {
      setUploading(false);
    }
  };

  const acceptFile = (selected: File | undefined | null) => {
    if (!selected || uploading) return;
    const problem = validateFile(selected);
    if (problem) {
      setError(problem);
      setFile(null);
      setPreviewUrl(null);
      resetInput();
      return;
    }
    setError(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
    void startUpload(selected);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files?.[0]);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label={reupload ? '重新上傳付款截圖' : '上傳付款截圖'}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex min-h-[120px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-[1.5px] border-dashed px-4 py-6 md:min-h-[140px]',
          'transition-[border-color,background-color] duration-200',
          dragOver ? 'border-pink bg-space-3' : 'border-purple-text bg-transparent',
          uploading && 'cursor-wait',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />
        {uploading ? (
          <>
            <WishingStar size={24} spinning />
            <span className="text-sm text-txt-2">上傳緊，許願中…</span>
          </>
        ) : file && previewUrl ? (
          <span className="flex w-full items-center gap-3">
            <img
              src={previewUrl}
              alt="付款截圖預覽"
              className="h-16 w-16 rounded-lg border border-space-line object-cover"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[13px] text-txt-1">{file.name}</span>
              <span className="block font-mono text-[12px] text-txt-3">{formatSize(file.size)}</span>
            </span>
            <span className="text-[13px] text-purple-text">重新上傳</span>
          </span>
        ) : (
          <>
            <WishingStar size={28} />
            <span className="text-sm text-txt-1">
              {reupload ? '拖新截圖入嚟，或者撳呢度重新上傳' : '拖截圖入嚟，或者撳呢度上傳'}
            </span>
            <span id={hintId} className="text-[12px] text-txt-3">
              JPG / PNG / WEBP，最大 10MB
            </span>
          </>
        )}
      </div>

      {error && (
        <p id={errorId} role="alert" className="mt-2 flex items-center gap-1.5 text-[13px] text-pink-soft">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
            <path
              d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
              fill="var(--gold)"
            />
          </svg>
          {error}
        </p>
      )}

      <p className="mt-2 text-[13px] text-txt-3">上傳後 Glo Glo 團隊會盡快對數，WhatsApp 通知你。</p>
    </div>
  );
}

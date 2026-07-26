import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent } from 'react';
import { StarGlyph } from './WishingStar';
import { formatFileSize } from './format';

/**
 * RedCode 設計系統 §P7 —— 付款截圖 dropzone
 * 虛線 1.5px dashed --purple-text、圓角 16px、內 140px 高（手機 120px）；
 * 中央金色四角星 + 「拖截圖入嚟，或者撳呢度上傳」；
 * 限 JPG / PNG / WebP ≤ 10MB，前端即時 validate，錯誤訊息 §4.6；
 * 選檔後：預覽縮圖 + DM Mono 檔名大小 + 「重新上傳」。
 */

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024; // 10MB（同 api/boot.ts 上限一致）

interface PaymentDropzoneProps {
  file: File | null;
  previewUrl: string | null;
  disabled?: boolean;
  onSelect: (file: File) => void;
}

function validate(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return '只支援 JPG / PNG / WebP 圖片';
  if (file.size > MAX_BYTES) return '檔案大過 10MB，請壓縮細啲再試';
  return null;
}

export default function PaymentDropzone({
  file,
  previewUrl,
  disabled = false,
  onSelect,
}: PaymentDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptFile = (candidate: File | null | undefined) => {
    if (!candidate) return;
    const problem = validate(candidate);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onSelect(candidate);
  };

  const openPicker = () => {
    if (!disabled) inputRef.current?.click();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    acceptFile(e.dataTransfer.files?.[0]);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
    // 俾人揀返同一個檔案都觸發到 change
    e.target.value = '';
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label="上傳付款截圖"
        aria-describedby="payment-dropzone-hint"
        aria-invalid={!!error}
        aria-disabled={disabled}
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className="cursor-pointer rounded-2xl p-4 transition-colors duration-200"
        style={{
          border: `1.5px dashed ${
            error ? 'var(--pink)' : dragOver ? 'var(--pink-soft)' : 'var(--purple-text)'
          }`,
          background: dragOver ? 'var(--pink-haze)' : 'rgba(255,255,255,.02)',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={onInputChange}
          disabled={disabled}
          tabIndex={-1}
          aria-hidden="true"
        />

        {file && previewUrl ? (
          /* 選檔後：預覽縮圖 + DM Mono 檔名大小 + 重新上傳 */
          <div className="flex items-center gap-4">
            <img
              src={previewUrl}
              alt="付款截圖預覽"
              className="h-20 w-20 shrink-0 rounded-lg border object-cover"
              style={{ borderColor: 'var(--glass-border)' }}
            />
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate font-mono text-sm text-txt-1">{file.name}</p>
              <p className="mt-0.5 font-mono text-[13px] text-txt-3">{formatFileSize(file.size)}</p>
              <p className="mt-1.5 text-[13px] font-medium text-purple-text">撳呢度重新上傳</p>
            </div>
          </div>
        ) : (
          /* 空態：中央金色四角星 + 提示 */
          <div className="flex h-[120px] flex-col items-center justify-center gap-2.5 px-4 text-center md:h-[140px]">
            <StarGlyph size={28} />
            <p className="text-sm text-txt-2">拖截圖入嚟，或者撳呢度上傳</p>
          </div>
        )}
      </div>

      <p id="payment-dropzone-hint" className="mt-2 text-[13px] text-txt-3">
        支援 JPG / PNG / WebP，最大 10MB
      </p>
      {/* §4.6 錯誤：13px --pink-soft + 左邊金色小星 icon */}
      {error && (
        <p role="alert" className="mt-2 flex items-center gap-2 text-[13px] text-pink-soft">
          <StarGlyph size={12} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

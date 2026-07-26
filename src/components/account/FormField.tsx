import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * RedCode 設計系統 §4.6 —— 表單與輸入
 * - Label 放框上，14px --text-2
 * - 輸入框：--space-2 底、1px --space-line、圓角 12px、高 48px、內文 --text-1
 * - focus：邊轉 --pink + 外發光 0 0 0 3px rgba(255,0,84,.15)
 * - 錯誤：邊 --pink + 下方 13px --pink-soft 訊息 + 左邊 --gold 小星 icon
 */

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  /** 錯誤訊息（有就轉錯誤態） */
  error?: string;
  /** 選填標記 */
  optional?: boolean;
  /** label 行右側提示內容 */
  hint?: ReactNode;
  /** inline 模式：label 左邊 + input flex-1，行高 h-14（會員資料逐行編輯用） */
  inline?: boolean;
  /** inline 模式右側動作掣（儲存／取消） */
  actions?: ReactNode;
}

const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField(
  { id, label, error, optional = false, hint, inline = false, actions, className, ...inputProps },
  ref,
) {
  const errorId = `${id}-error`;
  const errorNode = error ? (
    <p id={errorId} role="alert" className="mt-2 flex items-center gap-1.5 text-[13px] text-pink-soft">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
        <path
          d="M12 1.5C13 6.8 17.2 11 22.5 12C17.2 13 13 17.2 12 22.5C11 17.2 6.8 13 1.5 12C6.8 11 11 6.8 12 1.5Z"
          fill="var(--gold)"
        />
      </svg>
      {error}
    </p>
  ) : null;

  // inline 模式：label 左邊、input 中行、動作掣右邊，行高 h-14 同 display 態一致
  if (inline) {
    return (
      <div className={cn('w-full', className)}>
        <div className="flex h-14 items-center gap-3">
          <label htmlFor={id} className="w-20 shrink-0 text-sm text-txt-3">
            {label}
            {optional && <span className="ml-1 text-[12px]">（選填）</span>}
          </label>
          <input
            ref={ref}
            id={id}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              'h-11 min-w-0 flex-1 rounded-xl border bg-space-2 px-4 text-[15px] text-txt-1',
              'placeholder:text-txt-3 transition-[border-color,box-shadow] duration-200',
              'focus:border-pink focus:shadow-[0_0_0_3px_rgba(255,0,84,0.15)] focus:outline-none',
              error ? 'border-pink' : 'border-space-line',
            )}
            {...inputProps}
          />
          {actions}
        </div>
        {errorNode}
      </div>
    );
  }

  return (
    <div className={cn('w-full', className)}>
      <label htmlFor={id} className="mb-2 flex items-baseline justify-between gap-2 text-sm text-txt-2">
        <span>
          {label}
          {optional && <span className="ml-2 text-[13px] text-txt-3">（選填）</span>}
        </span>
        {hint}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          'h-12 w-full rounded-xl border bg-space-2 px-4 text-[15px] text-txt-1',
          'placeholder:text-txt-3 transition-[border-color,box-shadow] duration-200',
          'focus:border-pink focus:shadow-[0_0_0_3px_rgba(255,0,84,0.15)] focus:outline-none',
          error ? 'border-pink' : 'border-space-line',
        )}
        {...inputProps}
      />
      {errorNode}
    </div>
  );
});

export default FormField;

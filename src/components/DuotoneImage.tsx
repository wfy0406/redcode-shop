import type { ImgHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * RedCode 設計系統 §7.3 —— Duotone 相片處理（全站 signature 影像語言）
 * 預設灰階 + 桃紅 multiply 疊層（opacity .55）；hover 或加 .duotone-reveal 時過渡到全彩（1s）
 */

interface DuotoneImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  /** 進入視窗即上色（唔使等 hover） */
  reveal?: boolean;
  /** 關閉 duotone，全彩顯示（人像相用） */
  off?: boolean;
  wrapperClassName?: string;
}

export default function DuotoneImage({
  reveal = false,
  off = false,
  wrapperClassName,
  className,
  alt = '',
  ...imgProps
}: DuotoneImageProps) {
  if (off) {
    return (
      <div className={cn('overflow-hidden', wrapperClassName)}>
        <img alt={alt} className={className} {...imgProps} />
      </div>
    );
  }
  return (
    <div className={cn('duotone', reveal && 'duotone-reveal', wrapperClassName)}>
      <img alt={alt} className={className} {...imgProps} />
    </div>
  );
}

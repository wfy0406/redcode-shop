/**
 * 配搭圖 gallery（/glo-guide 頭版舞台同 /glo-guide/:slug 主舞台共用）。
 *
 * 滑動手勢／鍵盤 ArrowLeft・ArrowRight 重用現有 src/components/ui/carousel.tsx
 * （embla-carousel-react，loop 循環）；上一張／下一張係受控制——active index
 * 由 parent 持有（thumbnail selector、同步單品欄都靠佢），撳制即刻轉；
 * swipe／carousel 內建箭咀鍵經 embla select event 同步返同一個 state，
 * 唔會有第二個會漂移嘅事實來源。
 *
 * 主圖完整原比例顯示：CSS 只用 width:100%＋height:auto＋object-fit:contain，
 * 唔設固定 aspect-ratio／object-position／cover。熱區 ≥44px，制有
 * 粵語無障礙名，多過一張先出控制同「第 X 張，共 Y 張」role=status。
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  type CarouselApi,
} from '@/components/ui/carousel';
import type { GuideImage } from './types';

export interface GuideImageGalleryProps {
  /** 全部公開配搭圖（position 升冪）；穩定 key 用 image.id */
  images: GuideImage[];
  /** 受控現任 index（parent 先 clamp 至合法範圍） */
  active: number;
  onActiveChange: (index: number) => void;
  /** carousel region 嘅無障礙名 */
  ariaLabel: string;
  /** 「第 X 張，共 Y 張」status；詳情頁 caption 已有同款計數時可關 */
  showStatus?: boolean;
  /** 每張 slide 內容（主圖標記／eager・lazy 策略由 parent 話事） */
  renderSlide: (image: GuideImage, index: number) => ReactNode;
}

export default function GuideImageGallery({
  images,
  active,
  onActiveChange,
  ariaLabel,
  showStatus = true,
  renderSlide,
}: GuideImageGalleryProps) {
  const [api, setApi] = useState<CarouselApi>();
  const count = images.length;
  const index = count === 0 ? 0 : Math.min(Math.max(active, 0), count - 1);

  // 受控同步：parent 轉咗 active（nav 制／thumbnail）→ embla 滑去同一張
  useEffect(() => {
    if (!api) return;
    if (api.selectedScrollSnap() !== index) api.scrollTo(index);
  }, [api, index]);

  // swipe／carousel 內建 ArrowLeft・ArrowRight → embla select → 同步返受控 state
  useEffect(() => {
    if (!api) return;
    const sync = () => onActiveChange(api.selectedScrollSnap());
    api.on('select', sync);
    return () => {
      api.off('select', sync);
    };
  }, [api, onActiveChange]);

  // loop 循環：最後一張再下一張返第一張，反之亦然
  const goTo = (next: number) => {
    if (count === 0) return;
    onActiveChange(((next % count) + count) % count);
  };

  return (
    <Carousel
      opts={{ loop: true, align: 'start' }}
      setApi={setApi}
      className="glo-guide-gallery"
      aria-label={ariaLabel}
    >
      <CarouselContent className="-ml-0 items-start">
        {images.map((image, i) => (
          <CarouselItem
            key={image.id}
            className="pl-0"
            aria-hidden={i !== index}
            data-active={i === index ? 'true' : undefined}
            aria-label={`第 ${i + 1} 張，共 ${count} 張`}
          >
            {renderSlide(image, i)}
          </CarouselItem>
        ))}
      </CarouselContent>
      {count > 1 && (
        <>
          <button
            type="button"
            className="glo-guide-gallery-nav glo-guide-gallery-nav--prev"
            aria-label="上一張配搭圖"
            onClick={() => goTo(index - 1)}
          >
            <ChevronLeft size={22} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="glo-guide-gallery-nav glo-guide-gallery-nav--next"
            aria-label="下一張配搭圖"
            onClick={() => goTo(index + 1)}
          >
            <ChevronRight size={22} aria-hidden="true" />
          </button>
          {showStatus && (
            <p className="glo-guide-gallery-status" role="status">
              第 {index + 1} 張，共 {count} 張
            </p>
          )}
        </>
      )}
    </Carousel>
  );
}

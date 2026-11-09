'use client';

/**
 * Reveal —— 原生 IntersectionObserver 進場淡入（零 dependency）。
 * reduced-motion 底下 CSS 已經令 .wd-reveal 即刻可見，呢度照加 wd-in 無副作用。
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export default function Reveal({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      el.classList.add('wd-in');
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          el.classList.add('wd-in');
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={`wd-reveal${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

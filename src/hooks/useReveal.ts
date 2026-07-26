import { useEffect, useRef } from 'react';

/**
 * RedCode 設計系統 §3.4 —— Scroll reveal
 * IntersectionObserver threshold 0.15，入視窗後加 .revealed class，
 * 觸發一次就解除 observer。reduced-motion 由 CSS 直接即時顯示。
 *
 * 用法：const ref = useReveal<HTMLDivElement>(); <div ref={ref} className="reveal">
 * 列表 stagger：第 n 個 item 加 style={{ transitionDelay: `${Math.min(n * 80, 400)}ms` }}
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 觀察 ref 元素本身 + 入面所有 .reveal 子元素（列表 stagger 用）
    const targets = [el, ...Array.from(el.querySelectorAll<HTMLElement>('.reveal'))];

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targets.forEach((t) => t.classList.add('revealed'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );

    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, []);

  return ref;
}

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

    // 商品/praise 等 async 數據會遲到：mount 嗰刻 .reveal 子元素可能未存在，
    // 所以要 MutationObserver 接住之後先出現嘅新卡，唔會永久隱形
    const seen = new Set<Element>();

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const revealNow = () => {
        [el, ...Array.from(el.querySelectorAll<HTMLElement>('.reveal'))].forEach((t) => {
          if (seen.has(t)) return;
          seen.add(t);
          t.classList.add('revealed');
        });
      };
      revealNow();
      const mo = new MutationObserver(revealNow);
      mo.observe(el, { childList: true, subtree: true });
      return () => mo.disconnect();
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

    const scan = () => {
      [el, ...Array.from(el.querySelectorAll<HTMLElement>('.reveal'))].forEach((t) => {
        if (seen.has(t)) return;
        seen.add(t);
        observer.observe(t);
      });
    };
    scan();

    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mo.disconnect();
    };
  }, []);

  return ref;
}

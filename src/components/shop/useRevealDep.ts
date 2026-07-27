import { useCallback, useEffect, useState } from 'react';
import type { DependencyList } from 'react';

/**
 * useReveal 嘅 async-data 版本：同 shared useReveal 一樣用 IntersectionObserver（§3.4，
 * threshold 0.15、觸發一次就 unobserve、reduced-motion 即時顯示），但 deps 改變時
 * 會重新掃描 .reveal 子元素 —— 適合 tRPC 數據返到先 render 嘅列表格網。
 *
 * 2026-07-27 修復：同 useReveal 一齊改 callback ref。舊版 mount effect 如果遇上
 * loading 早退（ref 仲未掛上），observer 永不建立；deps 唔變嘅話內容永久隱形。
 */
export function useRevealDep<T extends HTMLElement>(deps: DependencyList) {
  const [el, setEl] = useState<T | null>(null);

  useEffect(() => {
    if (!el) return;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, ...deps]);

  // callback ref：條件渲染遲掛上嘅格網都接得住
  return useCallback((node: T | null) => setEl(node), []);
}

import { useCallback, useEffect, useState } from 'react';

/**
 * RedCode 設計系統 §3.4 —— Scroll reveal
 * IntersectionObserver threshold 0.15，入視窗後加 .revealed class，
 * 觸發一次就解除 observer。reduced-motion 由 CSS 直接即時顯示。
 *
 * 用法：const ref = useReveal<HTMLDivElement>(); <div ref={ref} className="reveal">
 * 列表 stagger：第 n 個 item 加 style={{ transitionDelay: `${Math.min(n * 80, 400)}ms` }}
 *
 * 2026-07-27 修復：改用 callback ref + state。舊版 useRef + mount effect（deps []），
 * 遇上 async 數據嘅條件渲染（loading 早退，資料返到先 render 內容，例如商品詳情頁），
 * mount 嗰刻 ref.current 仲係 null → observer 永不建立 → .reveal 永遠 opacity:0，
 * 成個資訊區（品名/價錢/尺寸/加入購物車）隱形。callback ref 喺元素真正掛上嗰刻
 * 先觸發 effect，幾遲 mount 都接得住。
 *
 * 2026-07-29 加保險掣（手機首頁中段隱形修復）：IO 喺個別瀏覽器/WebView 可能失靈——
 * 例如元素高過 threshold 0.15 計得晒嘅可見比例上限（超長區塊 max ratio < 15% 永不達標）、
 * 或舊版 WebView 實作問題——觀察咗都永不觸發，成段內容永久隱形。
 * 加 scroll/resize 被動監聽：元素頂進入視窗 92% 內即直接顯示。
 * IO 正常時佢只係早少少嘅冗餘觸發，失靈時就係兜底，保證捱到必顯示。
 */
export function useReveal<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);

  useEffect(() => {
    if (!el) return;

    // 商品/praise 等 async 數據會遲到：掛上嗰刻 .reveal 子元素可能未存在，
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

    // 保險掣：捱動／縮放時主動檢查未顯示嘅元素，近視窗即 reveal。
    // 就算 IO 完全罷工，用戶捱到去嗰段都一定會顯示，唔會再出現「成段黑色空位」。
    const fallbackCheck = () => {
      const vh = window.innerHeight || document.documentElement.clientHeight;
      [el, ...Array.from(el.querySelectorAll<HTMLElement>('.reveal'))].forEach((t) => {
        if (t.classList.contains('revealed')) return;
        const r = t.getBoundingClientRect();
        if (r.top < vh * 0.92 && r.bottom > 0) {
          t.classList.add('revealed');
          observer.unobserve(t);
        }
      });
    };
    window.addEventListener('scroll', fallbackCheck, { passive: true });
    window.addEventListener('resize', fallbackCheck, { passive: true });
    fallbackCheck(); // 掛上即查一次，補返 IO 觸發前嘅空窗

    return () => {
      observer.disconnect();
      mo.disconnect();
      window.removeEventListener('scroll', fallbackCheck);
      window.removeEventListener('resize', fallbackCheck);
    };
  }, [el]);

  // callback ref：元素掛上（包括條件渲染遲掛）同拆走時 React 即時通知
  return useCallback((node: T | null) => setEl(node), []);
}

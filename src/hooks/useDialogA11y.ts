import { useEffect, useRef } from 'react';

/**
 * 前台 dialog／drawer 無障礙共用 hook（年長客群鐵律：唔准困住用戶）
 *
 * 合約：`useDialogA11y(onClose, active?)` ——
 * 1. Esc 關閉（call onClose）
 * 2. focus trap：Tab／Shift+Tab 喺 dialog 入面循環，唔會走落背景
 * 3. 開啟時自動聚焦第一個可操作元素；關閉後還原焦點返去觸發掣
 * 4. 開啟期間鎖背景滾動（body overflow hidden），關閉還原
 *
 * 接入方法：dialog 根元素加 `data-dialog-a11y-root`（冇就用最頂層
 * `[role="dialog"][aria-modal="true"]` 兜底）；條件渲染嘅 dialog 喺組件頂
 * 用 active 開關，唔好喺 early return 之後先 call hook。
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function findDialogRoot(): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>(
    '[data-dialog-a11y-root], [role="dialog"][aria-modal="true"]',
  );
  return roots.length > 0 ? roots[roots.length - 1] : null;
}

function focusablesOf(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useDialogA11y(onClose: () => void, active: boolean = true): void {
  // onClose 用 ref 跟最新：caller 每次 render 新 closure 都唔會令 effect 重跑（唔會搶焦點）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    // 背景滾動鎖（記住原值，巢疊 dialog 各自還原自己嗰份）
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const root = findDialogRoot();
    // 初始焦點：第一個可操作元素；冇就聚焦容器本身（要畀 tabindex）
    if (root) {
      const first = focusablesOf(root)[0];
      if (first) {
        first.focus();
      } else {
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        root.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // 以事件當刻最頂層 dialog 為準（步驟切換後內容會變，即場重計）
      const current = findDialogRoot();
      if (!current) return;
      const items = focusablesOf(current);
      if (items.length === 0) {
        e.preventDefault();
        current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      // 焦點唔喺 dialog 入面（例如俾瀏覽器 chrome 搶走）→ 拉返入嚟
      if (!activeEl || !current.contains(activeEl)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // 還原焦點返去開 dialog 之前嘅元素（可能已卸載，focus 前檢查）
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active]);
}

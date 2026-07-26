import { useCallback, useRef, useState } from 'react';

/** 玻璃 toast 訊息（配合 <ToastStack> 用） */
export type ToastKind = 'success' | 'info' | 'error';

export interface ToastMsg {
  id: number;
  kind: ToastKind;
  text: string;
}

/** toast 狀態 hook：push 後 3.6s 自動消失 */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const idRef = useRef(0);

  const push = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return { toasts, push };
}

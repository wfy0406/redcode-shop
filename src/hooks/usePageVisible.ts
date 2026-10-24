import { useEffect, useState } from 'react';

/**
 * 全局統一「頁面可見」狀態（perf-fix 共用合約，其他動畫/影片組件都用呢個）：
 * 回傳 `!document.hidden`，內部 listen `visibilitychange`。
 *
 * 用途：動畫全部保留，淨係「背景分頁先暫停」——流星停止 spawn、loop 影片 pause，
 * 返前景即刻恢復；唔准借呢個 hook 刪動畫或降速。
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  );

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onChange);
    // 補一次同步（mount 嗰刻已經 hidden 嘅極端情況）
    onChange();
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}

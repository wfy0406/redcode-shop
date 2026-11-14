import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * 自訂 Enter 提交統一擋 IME 確認鍵。
 *
 * 中文／日文等輸入法用 Enter 確認候選字時，keydown 仍可能係 Enter；
 * Safari 舊事件次序下 isComposing 可能已重設，所以同時擋 keyCode 229。
 * 回傳 true 代表呢下係 Enter（已阻止預設提交），唔代表 action 有執行。
 */
export function handleEnterToSubmit(
  event: ReactKeyboardEvent<HTMLElement>,
  action: () => void,
): boolean {
  if (event.key !== 'Enter') return false;
  event.preventDefault();
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return true;
  action();
  return true;
}

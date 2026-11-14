import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { handleEnterToSubmit } from './keyboard';

function keyEvent({
  key = 'Enter',
  isComposing = false,
  keyCode = 13,
}: {
  key?: string;
  isComposing?: boolean;
  keyCode?: number;
} = {}) {
  const preventDefault = vi.fn();
  const event = {
    key,
    nativeEvent: { isComposing, keyCode },
    preventDefault,
  } as unknown as ReactKeyboardEvent<HTMLElement>;
  return { event, preventDefault };
}

describe('handleEnterToSubmit — 中文輸入法安全', () => {
  it('普通 Enter 阻止預設提交並執行一次 action', () => {
    const { event, preventDefault } = keyEvent();
    const action = vi.fn();
    expect(handleEnterToSubmit(event, action)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it('IME composition 中 Enter 只確認候選字，唔執行 action', () => {
    const { event, preventDefault } = keyEvent({ isComposing: true });
    const action = vi.fn();
    expect(handleEnterToSubmit(event, action)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it('Safari keyCode 229 fallback 即使 isComposing=false 都唔提交', () => {
    const { event, preventDefault } = keyEvent({ keyCode: 229 });
    const action = vi.fn();
    expect(handleEnterToSubmit(event, action)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'a', 'ArrowDown'])('%s 唔阻預設行為，亦唔執行 Enter action', (key) => {
    const { event, preventDefault } = keyEvent({ key });
    const action = vi.fn();
    expect(handleEnterToSubmit(event, action)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});

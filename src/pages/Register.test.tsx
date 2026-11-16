// @vitest-environment happy-dom
/**
 * Register 返回路徑保留（iteration-7，Glo Guide → AI TryOn 深層連結）：
 * ─ 密碼註冊成功 → 去 Login 帶過嚟嘅 state.from（唔係硬去 /account）；
 * ─ Google 一掣開戶成功 → 同一目標；
 * ─ 剔咗直播通知（wantLivePush）→ PushPermissionGuide onClose 去同一目標；
 * ─ ?phone= 預填行為不變；冇 from → /account 預設不變。
 * trpc 唔使 mock（Register 冇直接用）；useAuth／GoogleLoginButton／
 * RegionStationPicker／PushPermissionGuide 用 stub，唔掂網絡同真 push API。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AUTH_RETURN_KEY } from '@/lib/authReturn';
import Register from './Register';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  login: vi.fn(async () => undefined),
  loginWithGoogle: vi.fn(async () => undefined),
  register: vi.fn(async () => undefined),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => h }));

vi.mock('@/components/account/GoogleLoginButton', () => ({
  default: (props: { onCredential: (idToken: string) => void; onError: (msg: string) => void }) => (
    <button type="button" data-testid="google-stub" onClick={() => props.onCredential('fake-id-token')}>
      Google
    </button>
  ),
}));

vi.mock('@/components/shop/RegionStationPicker', () => ({
  default: () => null,
}));

vi.mock('@/components/push/PushPermissionGuide', () => ({
  default: (props: { open: boolean; onClose: () => void }) =>
    props.open ? (
      <button type="button" data-testid="push-guide-close" onClick={() => props.onClose()}>
        close
      </button>
    ) : null,
}));

const TRYON_FROM = '/try-on?productId=101&photoIndex=0&guide=autumn-knit';

let seen: { pathname: string; search: string; state: unknown } | null = null;
function Probe() {
  const loc = useLocation();
  seen = { pathname: loc.pathname, search: loc.search, state: loc.state };
  return null;
}

let container: HTMLDivElement;
let root: Root;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderRegister(entry: string | { pathname: string; state?: unknown }) {
  sessionStorage.clear();
  seen = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

async function fillValidForm() {
  await act(async () => {
    setInput(container.querySelector<HTMLInputElement>('#reg-name')!, 'Glo 寶寶');
    setInput(container.querySelector<HTMLInputElement>('#reg-phone')!, '91234567');
    setInput(container.querySelector<HTMLInputElement>('#reg-email')!, 'glo@example.com');
    setInput(container.querySelector<HTMLInputElement>('#reg-password')!, 'password123');
    setInput(container.querySelector<HTMLInputElement>('#reg-confirm')!, 'password123');
  });
}

async function submitRegister() {
  const form = container.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  h.register.mockClear();
  h.loginWithGoogle.mockClear();
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
});

describe('Register 返回路徑保留', () => {
  it('密碼註冊成功 → 去 state.from 深層連結', async () => {
    await renderRegister({ pathname: '/register', state: { from: TRYON_FROM } });
    await fillValidForm();
    await submitRegister();
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
  });

  it('冇 from → /account（預設不變）', async () => {
    await renderRegister({ pathname: '/register' });
    await fillValidForm();
    await submitRegister();
    expect(seen).toMatchObject({ pathname: '/account' });
  });

  it('state 丟咗 → sessionStorage 兜底返得去', async () => {
    await renderRegister({ pathname: '/register' });
    sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: TRYON_FROM, ts: Date.now() }));
    await fillValidForm();
    await submitRegister();
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('Google 一掣開戶成功 → 同一個 from 目標', async () => {
    await renderRegister({ pathname: '/register', state: { from: TRYON_FROM } });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="google-stub"]')!.click();
    });
    expect(h.loginWithGoogle).toHaveBeenCalledWith('fake-id-token');
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
  });

  it('剔咗直播通知 → PushPermissionGuide onClose 去同一目標', async () => {
    await renderRegister({ pathname: '/register', state: { from: TRYON_FROM } });
    await fillValidForm();
    await act(async () => {
      container.querySelector<HTMLInputElement>('#reg-live-push')!.click();
    });
    await submitRegister();
    // 註冊成功後停喺講解彈窗，未導航
    const closeBtn = container.querySelector<HTMLButtonElement>('[data-testid="push-guide-close"]');
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn!.click();
    });
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
  });

  it('?phone= 預填行為不變：8 位數字帶入', async () => {
    await renderRegister('/register?phone=91234567');
    expect(container.querySelector<HTMLInputElement>('#reg-phone')!.value).toBe('91234567');
  });

  it('?phone= 唔係 8 位數字 → 留空', async () => {
    await renderRegister('/register?phone=abc');
    expect(container.querySelector<HTMLInputElement>('#reg-phone')!.value).toBe('');
  });
});

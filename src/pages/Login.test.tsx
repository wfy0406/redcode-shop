// @vitest-environment happy-dom
/**
 * Login 返回路徑保留（iteration-7，Glo Guide → AI TryOn 深層連結）：
 * ─ 密碼登入成功 → replace 去 state.from 嘅安全站內路徑（唔係硬去 /account）；
 * ─ rc.pendingClaim 優先級不變（有記號 → /orders）；
 * ─ state.from 丟咗（模擬 Google 全頁跳轉）→ sessionStorage 兜底照樣返得去；
 * ─ 兜底過期 → /account；storage 拋錯（私隱模式）→ state.from 主線唔受影響；
 * ─ 「立即註冊」Link 將 from 帶去 /register。
 * trpc／useAuth／GoogleLoginButton 全 mock，唔掂網絡；唔改任何 global setup。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AUTH_RETURN_KEY, AUTH_RETURN_TTL_MS } from '@/lib/authReturn';
import Login from './Login';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  login: vi.fn(async () => undefined),
  loginWithGoogle: vi.fn(async () => undefined),
  register: vi.fn(async () => undefined),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => h }));

vi.mock('@/providers/trpc', () => ({
  trpc: {
    auth: {
      requestPasswordReset: { useMutation: () => ({ mutate: () => undefined, isPending: false }) },
      resetPasswordWithCode: { useMutation: () => ({ mutate: () => undefined, isPending: false }) },
      googleConfig: { useQuery: () => ({ data: undefined }) },
    },
  },
}));

// Google 掣改做一粒普通掣：撳落去即交 credential，唔使 GSI script
vi.mock('@/components/account/GoogleLoginButton', () => ({
  default: (props: { onCredential: (idToken: string) => void; onError: (msg: string) => void }) => (
    <button type="button" data-testid="google-stub" onClick={() => props.onCredential('fake-id-token')}>
      Google
    </button>
  ),
}));

const TRYON_FROM = '/try-on?productId=101&photoIndex=0&guide=autumn-knit';

/** 路由探針：行到邊條路就記低 pathname+search+state */
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

async function renderLogin(state: unknown) {
  sessionStorage.clear();
  seen = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

async function submitPasswordLogin() {
  await act(async () => {
    setInput(container.querySelector<HTMLInputElement>('#login-phone')!, '91234567');
    setInput(container.querySelector<HTMLInputElement>('#login-password')!, 'password123');
  });
  const form = container.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  h.login.mockClear();
  h.loginWithGoogle.mockClear();
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
});

describe('Login 返回路徑保留', () => {
  it('密碼登入成功 → 去 state.from 深層連結（query 齊全）', async () => {
    await renderLogin({ from: TRYON_FROM });
    await submitPasswordLogin();
    expect(h.login).toHaveBeenCalledWith('91234567', 'password123');
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
  });

  it('state.from 物件形式 { pathname, search } 一樣相容', async () => {
    await renderLogin({ from: { pathname: '/try-on', search: '?productId=101' } });
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/try-on', search: '?productId=101' });
  });

  it('rc.pendingClaim 優先：有記號 → /orders，唔理 state.from', async () => {
    await renderLogin({ from: TRYON_FROM });
    sessionStorage.setItem('rc.pendingClaim', JSON.stringify({ orderNo: 'A1', phone: '91234567' }));
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/orders', search: '' });
  });

  it('rc.pendingClaim 去 /orders 都會清走舊 authReturn 兜底（下次登入唔誤跳 TryOn）', async () => {
    await renderLogin(null);
    // 模擬之前 TryOn 落嘅舊記號仲未過期
    sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: TRYON_FROM, ts: Date.now() }));
    sessionStorage.setItem('rc.pendingClaim', JSON.stringify({ orderNo: 'A1', phone: '91234567' }));
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/orders' });
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('state 丟咗（全頁跳轉）→ sessionStorage 兜底返得去，兼一次性 consume', async () => {
    await renderLogin(null);
    sessionStorage.setItem(AUTH_RETURN_KEY, JSON.stringify({ path: TRYON_FROM, ts: Date.now() }));
    await submitPasswordLogin();
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('兜底過期（> 15 分鐘）→ 預設 /account，記號清走', async () => {
    await renderLogin(null);
    sessionStorage.setItem(
      AUTH_RETURN_KEY,
      JSON.stringify({ path: TRYON_FROM, ts: Date.now() - AUTH_RETURN_TTL_MS - 1 }),
    );
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/account' });
    expect(sessionStorage.getItem(AUTH_RETURN_KEY)).toBeNull();
  });

  it('冇 state 冇兜底 → /account（預設不變）', async () => {
    await renderLogin(null);
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/account' });
  });

  it('外站 from 被淨化拒絕 → /account', async () => {
    await renderLogin({ from: 'https://evil.com/phish' });
    await submitPasswordLogin();
    expect(seen).toMatchObject({ pathname: '/account' });
  });

  it('sessionStorage 拋錯（私隱模式）→ state.from 主線照常去', async () => {
    await renderLogin({ from: TRYON_FROM });
    const realSet = sessionStorage.setItem.bind(sessionStorage);
    const realGet = sessionStorage.getItem.bind(sessionStorage);
    sessionStorage.setItem = () => {
      throw new Error('denied');
    };
    sessionStorage.getItem = (k: string) => {
      if (k === AUTH_RETURN_KEY) throw new Error('denied');
      return realGet(k);
    };
    await submitPasswordLogin();
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
    sessionStorage.setItem = realSet;
    sessionStorage.getItem = realGet;
  });

  it('Google 登入成功 → 同一個 state.from 目標', async () => {
    await renderLogin({ from: TRYON_FROM });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="google-stub"]')!.click();
    });
    expect(h.loginWithGoogle).toHaveBeenCalledWith('fake-id-token');
    expect(seen).toMatchObject({
      pathname: '/try-on',
      search: '?productId=101&photoIndex=0&guide=autumn-knit',
    });
  });

  it('「立即註冊」Link 將 from 帶去 /register', async () => {
    await renderLogin({ from: TRYON_FROM });
    const link = container.querySelector<HTMLAnchorElement>('a[href="/register"]')!;
    expect(link).toBeTruthy();
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(seen).toMatchObject({ pathname: '/register' });
    expect((seen!.state as { from?: string }).from).toBe(TRYON_FROM);
  });

  it('冇 from 時註冊 Link 唔帶 state', async () => {
    await renderLogin(null);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/register"]')!;
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(seen).toMatchObject({ pathname: '/register', state: null });
  });
});

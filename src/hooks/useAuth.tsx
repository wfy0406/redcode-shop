import { createContext, useContext, useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";

export type User = {
  id: number;
  name: string;
  phone: string;
  address: string | null;
  age: number | null;
  birthMonth: number | null;
  role: "member" | "staff" | "supervisor" | "admin";
  email: string | null;
  googleLinked: boolean;
  googleEmail: string | null;
  googleName: string | null;
  marketingOptIn: boolean;
  marketingOptInAt: string | null;
  // 推廣同意「已表態」時間（2026-08-06 Glo 要求，三態制）：null＋未同意＋舊會員＝未選，登入彈一次窗逼揀
  marketingPromptedAt: string | null;
  needsMarketingConsent: boolean;
};

type AuthCtx = {
  user: User | null;
  token: string | null;
  isMember: boolean;
  isStaff: boolean;
  isSupervisor: boolean;
  isAdmin: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

const TOKEN_KEY = "rc_token";
const USER_KEY = "rc_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  );
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    try {
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback((newToken: string, newUser: User) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        logout();
        return;
      }
      const me = (await res.json()) as User;
      localStorage.setItem(USER_KEY, JSON.stringify(me));
      setUser(me);
    } catch {
      // 網絡問題就唔 logout，等下次再試
    }
  }, [token, logout]);

  // 開 app 時如果手上有 token 就 refresh 一次（拎最新 role／資料）
  useEffect(() => {
    if (token) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: AuthCtx = {
    user,
    token,
    isMember: !!user,
    // 三級員工制（2026-08-06 Glo 要求）：staff 員工／supervisor 主管／admin 管理員都可以入後台
    isStaff: user?.role === "staff" || user?.role === "supervisor" || user?.role === "admin",
    isSupervisor: user?.role === "supervisor" || user?.role === "admin",
    isAdmin: user?.role === "admin",
    login,
    logout,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

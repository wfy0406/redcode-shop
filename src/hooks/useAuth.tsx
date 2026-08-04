import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { trpc } from "@/providers/trpc";
import { getToken, setToken, clearToken } from "@/lib/auth";

type AuthUser = {
  id: number;
  name: string;
  phone: string;
  role: "member" | "staff" | "admin";
  email?: string | null;
  address?: string | null;
  age?: number | null;
  birthMonth?: number | null;
  // 已連結 Google 帳號（2026-08-04）：會員中心顯示連結狀態用
  googleLinked?: boolean;
  // Google 開戶嘅帳號：email 鎖死跟 Google 電郵，唔俾改（2026-08-04 Glo 要求）
  emailLocked?: boolean;
};

type RegisterInput = {
  name: string;
  phone: string;
  password: string;
  // Email（2026-08-04 起必填，Glo 要求）
  email: string;
  address?: string;
  age?: number;
  birthMonth?: number;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  isStaff: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [hasToken, setHasToken] = useState<boolean>(() => !!getToken());
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    enabled: hasToken,
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = trpc.auth.login.useMutation();
  const registerMutation = trpc.auth.register.useMutation();
  const googleLoginMutation = trpc.auth.googleLogin.useMutation();

  const login = useCallback(
    async (phone: string, password: string) => {
      const res = await loginMutation.mutateAsync({ phone, password });
      setToken(res.token);
      setHasToken(true);
      await utils.auth.me.invalidate();
    },
    [loginMutation, utils],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const res = await registerMutation.mutateAsync(input);
      setToken(res.token);
      setHasToken(true);
      await utils.auth.me.invalidate();
    },
    [registerMutation, utils],
  );

  const loginWithGoogle = useCallback(
    async (idToken: string) => {
      const res = await googleLoginMutation.mutateAsync({ idToken });
      setToken(res.token);
      setHasToken(true);
      await utils.auth.me.invalidate();
    },
    [googleLoginMutation, utils],
  );

  const logout = useCallback(() => {
    clearToken();
    setHasToken(false);
    utils.auth.me.reset();
    utils.cart.list.reset();
  }, [utils]);

  const value = useMemo<AuthContextValue>(() => {
    const user = (hasToken ? (meQuery.data ?? null) : null) as AuthUser | null;
    return {
      user,
      isLoading: hasToken && meQuery.isLoading,
      isStaff: !!user && (user.role === "staff" || user.role === "admin"),
      login,
      register,
      loginWithGoogle,
      logout,
    };
  }, [hasToken, meQuery.data, meQuery.isLoading, login, register, loginWithGoogle, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必須喺 <AuthProvider> 入面用");
  return ctx;
}

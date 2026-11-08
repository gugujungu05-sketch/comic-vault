import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { social } from './api';
import type { User } from '../types';

interface SessionValue {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  codeLogin: { emailEnabled: boolean; devMode: boolean; channel?: string; recoveryEnabled?: boolean };
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<SessionValue>({
  user: null,
  loading: true,
  needsSetup: false,
  codeLogin: { emailEnabled: false, devMode: true, recoveryEnabled: false },
  refresh: async () => {},
  setUser: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [codeLogin, setCodeLogin] = useState({ emailEnabled: false, devMode: true });

  // 必须保持引用稳定：App 的 reconnect / 探测 useEffect 依赖它。
  // 早期这里是普通函数，每次渲染都会变，导致「探测成功 → refresh → 重渲染 →
  // refresh 变 → 重连逻辑重建 → 再探测」的死循环，表现为请求风暴。
  const refresh = useCallback(async () => {
    try {
      const s = await social.status();
      setUser(s.user);
      setNeedsSetup(s.needsSetup);
      setCodeLogin(s.codeLogin);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, loading, needsSetup, codeLogin, refresh, setUser }),
    [user, loading, needsSetup, codeLogin, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  return useContext(Ctx);
}

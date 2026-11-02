import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { social } from './api';
import type { User } from '../types';

interface SessionValue {
  user: User | null;
  loading: boolean;
  needsSetup: boolean;
  codeLogin: { emailEnabled: boolean; devMode: boolean };
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<SessionValue>({
  user: null,
  loading: true,
  needsSetup: false,
  codeLogin: { emailEnabled: false, devMode: true },
  refresh: async () => {},
  setUser: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [codeLogin, setCodeLogin] = useState({ emailEnabled: false, devMode: true });

  async function refresh() {
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
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <Ctx.Provider value={{ user, loading, needsSetup, codeLogin, refresh, setUser }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  return useContext(Ctx);
}

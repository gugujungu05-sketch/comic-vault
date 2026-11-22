import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

type ToastKind = 'ok' | 'err' | 'info';
interface Toast {
  id: string;
  kind: ToastKind;
  text: string;
}

type ToastFn = (text: string, kind?: ToastKind) => void;

const ToastCtx = createContext<ToastFn>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((prev) => [...prev.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'err' ? 'close' : t.kind === 'ok' ? 'check' : 'eye'} size={16} />
            <span style={{ flex: 1 }}>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** 统一的错误提示，自动读取 Error.message */
export function useErrorToast() {
  const push = useToast();
  return useCallback(
    (err: unknown, fallback = '操作失败') => {
      const message = err instanceof Error ? err.message : String(err);
      push(message || fallback, 'err');
    },
    [push],
  );
}

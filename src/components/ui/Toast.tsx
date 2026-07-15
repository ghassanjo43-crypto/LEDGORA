import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';
import { generateId } from '@/lib/utils';
import { Icon } from './icons';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
}

interface ToastContextValue {
  notify: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const variantStyles: Record<ToastVariant, string> = {
  success: 'border-emerald-200 bg-white text-emerald-800 dark:border-emerald-500/30 dark:bg-slate-900 dark:text-emerald-300',
  error: 'border-red-200 bg-white text-red-800 dark:border-red-500/30 dark:bg-slate-900 dark:text-red-300',
  info: 'border-slate-200 bg-white text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
  warning: 'border-amber-200 bg-white text-amber-800 dark:border-amber-500/30 dark:bg-slate-900 dark:text-amber-300',
};

const variantIcon: Record<ToastVariant, ReactNode> = {
  success: <Icon.Check className="h-4 w-4" />,
  error: <Icon.Alert className="h-4 w-4" />,
  info: <Icon.Warning className="h-4 w-4" />,
  warning: <Icon.Warning className="h-4 w-4" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = generateId('toast');
    setToasts((prev) => [...prev, { id, message, variant }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg',
              'animate-[toastIn_0.18s_ease-out]',
              variantStyles[t.variant],
            )}
          >
            <span className="shrink-0">{variantIcon[t.variant]}</span>
            <span className="flex-1">{t.message}</span>
          </div>
        ))}
      </div>
      <style>{`@keyframes toastIn { from { transform: translateY(8px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }`}</style>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

// Minimal toast system — Argus-internal, no external deps.

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info' | 'warn';
interface Toast { id: number; kind: ToastKind; text: string }

interface Ctx {
  show: (text: string, kind?: ToastKind) => void;
}
const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const show = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current;
    setToasts((cur) => [...cur, { id, kind, text }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2
                     : t.kind === 'error'   ? XCircle
                     : t.kind === 'warn'    ? AlertCircle
                     : Info;
          const tone = t.kind === 'success' ? 'border-emerald-500/50 bg-emerald-950/90 text-emerald-100'
                     : t.kind === 'error'   ? 'border-red-500/50 bg-red-950/90 text-red-100'
                     : t.kind === 'warn'    ? 'border-amber-500/50 bg-amber-950/90 text-amber-100'
                     : 'border-sky-500/50 bg-sky-950/90 text-sky-100';
          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex items-start gap-2 min-w-[280px] max-w-md rounded-md border px-3 py-2 shadow-2xl animate-slide-in-right backdrop-blur',
                tone
              )}
            >
              <Icon className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 text-sm">{t.text}</div>
              <button
                onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))}
                className="opacity-50 hover:opacity-100"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Fallback that doesn't crash if used outside provider
    return { show: (t) => console.log('[toast]', t) };
  }
  return ctx;
}

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastCtx {
  show: (type: Toast['type'], message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((type: Toast['type'], message: string) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  const ctx: ToastCtx = {
    show,
    success: (m) => show('success', m),
    error: (m) => show('error', m),
    info: (m) => show('info', m),
  };

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <div
        className="fixed right-4 bottom-4 z-[200] flex flex-col-reverse gap-2 sm:right-5 sm:bottom-5"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className="flex max-w-[380px] min-w-[260px] items-center gap-2.5 rounded-lg border border-line-strong bg-popover px-3.5 py-2.5 text-[12.5px] text-fg shadow-(--agora-shadow) animate-in fade-in-0 slide-in-from-right-4 [&_svg]:size-[15px] [&_svg]:shrink-0"
          >
            {t.type === 'success' && (
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="text-good"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5 8l2.2 2.2L11 5.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            {t.type === 'error' && (
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="text-bad"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M6 6l4 4M10 6l-4 4" strokeLinecap="round" />
              </svg>
            )}
            {t.type === 'info' && (
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="text-brand"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7v4M8 5.5v.5" strokeLinecap="round" />
              </svg>
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

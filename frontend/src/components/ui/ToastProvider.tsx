import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ToastApi, type ToastVariant } from './toast-context';
import styles from './Toast.module.css';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

const DISMISS_MS = 4000;
const MAX_VISIBLE = 4;

/**
 * Renders transient confirmations in a live region. Success/info use role=status (polite);
 * errors would use role=alert, but forms keep showing errors inline, so toasts are mostly success.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, variant: ToastVariant = 'info') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, variant }].slice(-MAX_VISIBLE));
      window.setTimeout(() => dismiss(id), DISMISS_MS);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({ show, success: (message) => show(message, 'success') }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.variant === 'error' ? 'alert' : 'status'}
            className={`${styles.toast} ${styles[t.variant]}`}
          >
            <span>{t.message}</span>
            <button type="button" className={styles.close} onClick={() => dismiss(t.id)}>
              <span aria-hidden="true">×</span>
              <span className="visually-hidden">Dismiss notification</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

import { createContext, useContext } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

export interface ToastApi {
  /** Shows a short, auto-dismissing message. Keep it to one sentence. */
  show: (message: string, variant?: ToastVariant) => void;
  success: (message: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

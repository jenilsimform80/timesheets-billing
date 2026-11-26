import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../src/components/ui/ToastProvider';
import { useToast } from '../src/components/ui/toast-context';

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast.success('Saved it.')}>go</button>;
}

afterEach(() => vi.useRealTimers());

describe('ToastProvider', () => {
  it('shows a success message, can be dismissed', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByRole('status')).toHaveTextContent('Saved it.');
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Saved it.')).not.toBeInTheDocument();
  });

  it('dismisses itself after a few seconds', () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    vi.useFakeTimers();
    act(() => {
      screen.getByRole('button', { name: 'go' }).click();
    });
    expect(screen.getByText('Saved it.')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByText('Saved it.')).not.toBeInTheDocument();
  });

  it('refuses to be used outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoveryBanner } from '../RecoveryBanner';

describe('RecoveryBanner', () => {
  it('shows the German restore prompt', () => {
    render(<RecoveryBanner onRestore={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('Ungespeicherte Änderungen wiederherstellen?')).toBeInTheDocument();
  });

  it('calls onRestore when the restore button is clicked', () => {
    const onRestore = vi.fn();
    render(<RecoveryBanner onRestore={onRestore} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when the discard button is clicked', () => {
    const onDismiss = vi.fn();
    render(<RecoveryBanner onRestore={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

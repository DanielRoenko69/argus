import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useChatStore } from '../../store/chat.js';
import { ParamPanel } from '../ParamPanel.js';

describe('ParamPanel', () => {
  beforeEach(() => { useChatStore.setState({ params: {} }); });

  it('toggles the popover open and closed', () => {
    render(<ParamPanel />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /tuning/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes the popover on Escape', () => {
    render(<ParamPanel />);
    fireEvent.click(screen.getByRole('button', { name: /tuning/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moving the temperature slider sets the store param', () => {
    render(<ParamPanel />);
    fireEvent.click(screen.getByRole('button', { name: /tuning/i }));
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '1.5' } });
    expect(useChatStore.getState().params.temperature).toBe(1.5);
  });

  it('typing max tokens sets the store; clearing it unsets', () => {
    render(<ParamPanel />);
    fireEvent.click(screen.getByRole('button', { name: /tuning/i }));
    const input = screen.getByLabelText('Max tokens');
    fireEvent.change(input, { target: { value: '12' } });
    expect(useChatStore.getState().params.max_tokens).toBe(12);
    fireEvent.change(input, { target: { value: '' } });
    expect(useChatStore.getState().params.max_tokens).toBeUndefined();
  });

  it('Reset all clears every param', () => {
    useChatStore.setState({ params: { temperature: 1.2, top_p: 0.5, max_tokens: 100 } });
    render(<ParamPanel />);
    fireEvent.click(screen.getByRole('button', { name: /tuning/i }));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    expect(useChatStore.getState().params).toEqual({});
  });
});

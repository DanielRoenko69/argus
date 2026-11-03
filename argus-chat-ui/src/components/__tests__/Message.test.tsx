import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message } from '../Message.js';

vi.mock('../../render/Markdown.js', () => ({
  Markdown: ({ content }: { content: string }) => <span>{content}</span>,
}));

describe('Message actions', () => {
  it('copies an assistant message and shows confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Message msg={{ role: 'assistant', content: 'Useful answer' }} isLastAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Useful answer'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('renders a retry action for failed responses', () => {
    const retry = vi.fn();
    render(<Message msg={{ role: 'assistant', content: '', error: 'Network unavailable' }} onRetry={retry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

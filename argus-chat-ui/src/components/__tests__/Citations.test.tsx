import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Citations } from '../Citations.js';

describe('Citations', () => {
  const items = [
    { source: 'https://wiki/runbook', snippet: 'pods OOMKilled', score: 0.88, index: 'Ops-KB' },
    { source: '/docs/kafka.md', snippet: 'consumer lag', score: 0.42, index: 'Ops-KB' },
  ];
  it('renders a chip per source with the score', () => {
    render(<Citations items={items} />);
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('0.88')).toBeInTheDocument();
    expect(screen.getByText('kafka.md')).toBeInTheDocument();
  });
  it('expands the snippet on click; an http source gets a noopener link', () => {
    render(<Citations items={items} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('pods OOMKilled')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open/i });
    expect(link).toHaveAttribute('href', 'https://wiki/runbook');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

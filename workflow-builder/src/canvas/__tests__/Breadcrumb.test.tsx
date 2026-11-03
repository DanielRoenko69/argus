import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Breadcrumb } from '../Breadcrumb';

describe('Breadcrumb', () => {
  it('renders the Argus anchor pointing at the Console home', () => {
    render(<Breadcrumb />);
    const argus = screen.getByRole('link', { name: 'Argus' });
    expect(argus).toHaveAttribute('href', '/home');
  });

  it('renders the Workflows anchor pointing at the native Console catalog', () => {
    render(<Breadcrumb />);
    const workflows = screen.getByRole('link', { name: 'Workflows' });
    expect(workflows).toHaveAttribute('href', '/build/workflows');
  });

  // Regression: the builder runs inside the /build/workflows/studio shell iframe.
  // Breadcrumb links MUST target _top so a shell page replaces the window
  // instead of loading inside the iframe (which stacked a second sidebar).
  it('targets _top on both anchors so navigation breaks out of the studio iframe', () => {
    render(<Breadcrumb />);
    expect(screen.getByRole('link', { name: 'Argus' })).toHaveAttribute('target', '_top');
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('target', '_top');
  });

  it('renders exactly the two breadcrumb anchors', () => {
    render(<Breadcrumb />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});

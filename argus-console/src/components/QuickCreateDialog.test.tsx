import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { QuickCreateDialog } from './QuickCreateDialog';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}{location.search}</span>;
}

function renderDialog(canAdmin: boolean) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="*" element={<><QuickCreateDialog canAdmin={canAdmin} onClose={onClose} /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

describe('QuickCreateDialog', () => {
  it('keeps restricted actions visible and disables them for non-admin users', () => {
    renderDialog(false);

    expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create provider' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create model' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Create agent preset (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create credential profile (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create skill (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create workflow (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create knowledge source (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create bundle (Admin access required)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create MCP connection (Admin access required)' })).toBeDisabled();
  });

  it.each([
    ['Create agent', '/build/agents/manage?create=agent'],
    ['Create agent preset', '/build/agents/manage?create=preset'],
    ['Create provider', '/settings/models?create=provider'],
    ['Create model', '/settings/models?create=model'],
    ['Create credential profile', '/settings/models?create=credential'],
    ['Create skill', '/build/skills?create=skill'],
    ['Create workflow', '/build/workflows/studio'],
    ['Create knowledge source', '/build/knowledge?create=knowledge'],
    ['Create bundle', '/mcp-fabric?create=bundle'],
    ['Create MCP connection', '/mcp-fabric?create=mcp'],
  ])('navigates an administrator from %s to its existing create flow', async (label, href) => {
    const onClose = renderDialog(true);

    await act(async () => {
      screen.getByRole('button', { name: label }).click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(href));
  });
});

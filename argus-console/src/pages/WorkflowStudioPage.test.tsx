import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStudioPage } from './WorkflowStudioPage';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderStudio(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/build/workflows/studio" element={<WorkflowStudioPage />} />
        <Route path="/build/workflows/studio/:workflowId" element={<WorkflowStudioPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorkflowStudioPage', () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    vi.restoreAllMocks();
  });

  it('opens an existing workflow in the dedicated builder runtime', () => {
    renderStudio('/build/workflows/studio/9');
    expect(screen.getByTitle('Argus visual workflow studio')).toHaveAttribute('src', '/workflows/builder/9');
  });

  it('forwards a validated trace id into the embedded replay runtime', () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    renderStudio(`/build/workflows/studio/149?replay=${traceId}`);
    expect(screen.getByTitle('Argus visual workflow studio'))
      .toHaveAttribute('src', `/workflows/builder/149?replay=${traceId}`);
  });

  it('drops an invalid replay query instead of forwarding arbitrary input', () => {
    renderStudio('/build/workflows/studio/149?replay=../../admin');
    expect(screen.getByTitle('Argus visual workflow studio'))
      .toHaveAttribute('src', '/workflows/builder/149');
  });

  it('forwards a validated execution id to the embedded run inspector', () => {
    renderStudio('/build/workflows/studio/149?execution=8');
    expect(screen.getByTitle('Argus visual workflow studio'))
      .toHaveAttribute('src', '/workflows/builder/149?execution=8');
  });

  it('drops an invalid execution id instead of forwarding arbitrary input', () => {
    renderStudio('/build/workflows/studio/149?execution=../../admin');
    expect(screen.getByTitle('Argus visual workflow studio'))
      .toHaveAttribute('src', '/workflows/builder/149');
  });

  it('opens the builder landing state for a new workflow', () => {
    renderStudio('/build/workflows/studio');
    expect(screen.getByTitle('Argus visual workflow studio')).toHaveAttribute('src', '/workflows/builder');
  });

  it('does not forward an invalid workflow id to the builder', () => {
    renderStudio('/build/workflows/studio/not-a-number');
    expect(screen.getByTitle('Argus visual workflow studio')).toHaveAttribute('src', '/workflows/builder');
  });

  it('sends the current Console theme on load and whenever it changes', async () => {
    document.documentElement.dataset.theme = 'light';
    renderStudio('/build/workflows/studio/9');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');
    const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');

    fireEvent.load(frame);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'argus:studio:theme', theme: 'light' },
      window.location.origin,
    );

    document.documentElement.dataset.theme = 'dark';
    await waitFor(() => expect(postMessage).toHaveBeenCalledWith(
      { type: 'argus:studio:theme', theme: 'dark' },
      window.location.origin,
    ));
  });

  it('mirrors safe child navigation into the canonical Console URL', async () => {
    renderStudio('/build/workflows/studio');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:navigate', workflowId: 12 },
    })));

    expect(await screen.findByTestId('location')).toHaveTextContent('/build/workflows/studio/12');
    expect(frame).toHaveAttribute('src', '/workflows/builder/12');
  });

  it('leaves the iframe for an allow-listed Console destination', async () => {
    renderStudio('/build/workflows/studio/186');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');
    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:open-console', path: '/mcp-fabric?catalog=github&returnTo=%2Fbuild%2Fworkflows%2Fstudio%2F186' },
    })));
    expect(await screen.findByTestId('location')).toHaveTextContent('/mcp-fabric?catalog=github&returnTo=%2Fbuild%2Fworkflows%2Fstudio%2F186');
  });

  it('rejects an unsafe Console handoff path', () => {
    renderStudio('/build/workflows/studio/186');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');
    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:open-console', path: '//attacker.example/mcp-fabric' },
    })));
    expect(screen.getByTestId('location')).toHaveTextContent('/build/workflows/studio/186');
  });

  it('mirrors a validated child replay handoff into the Console URL and iframe', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    renderStudio('/build/workflows/studio/149');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:replay', workflowId: 149, traceId },
    })));

    expect(await screen.findByTestId('location')).toHaveTextContent(`/build/workflows/studio/149?replay=${traceId}`);
    expect(frame).toHaveAttribute('src', `/workflows/builder/149?replay=${traceId}`);
  });

  it('rejects an invalid child replay trace', () => {
    renderStudio('/build/workflows/studio/149');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');
    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:replay', workflowId: 149, traceId: '../../admin' },
    })));
    expect(screen.getByTestId('location')).toHaveTextContent('/build/workflows/studio/149');
    expect(frame).toHaveAttribute('src', '/workflows/builder/149');
  });

  it('ignores cross-origin and invalid workflow navigation messages', () => {
    renderStudio('/build/workflows/studio/9');
    const frame = screen.getByTitle<HTMLIFrameElement>('Argus visual workflow studio');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://attacker.example',
      source: frame.contentWindow,
      data: { type: 'argus:builder:navigate', workflowId: 12 },
    })));
    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: 'argus:builder:navigate', workflowId: '../admin' },
    })));

    expect(screen.getByTestId('location')).toHaveTextContent('/build/workflows/studio/9');
    expect(frame).toHaveAttribute('src', '/workflows/builder/9');
  });
});

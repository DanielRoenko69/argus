import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleStudioReturnPath, isEmbeddedStudio, navigateToConsolePath, navigateToWorkflowReplay, useStudioBridge } from '@/lib/studioBridge';

const originalParent = window.parent;
const parentPostMessage = vi.fn();
const parentWindow = { postMessage: parentPostMessage } as unknown as Window;

function Probe({ workflowId }: { workflowId: number | null }) {
  useStudioBridge(workflowId);
  return null;
}

describe('workflow studio bridge', () => {
  beforeEach(() => {
    parentPostMessage.mockReset();
    Object.defineProperty(window, 'parent', { configurable: true, value: parentWindow });
    document.documentElement.classList.remove('light');
    localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, 'parent', { configurable: true, value: originalParent });
    document.documentElement.classList.remove('light');
  });

  it('announces readiness and mirrors workflow navigation to the Console shell', () => {
    const view = render(<Probe workflowId={9} />);

    expect(isEmbeddedStudio()).toBe(true);
    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'argus:builder:ready', workflowId: 9 },
      window.location.origin,
    );
    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'argus:builder:navigate', workflowId: 9 },
      window.location.origin,
    );

    view.rerender(<Probe workflowId={12} />);
    expect(parentPostMessage).toHaveBeenCalledWith(
      { type: 'argus:builder:navigate', workflowId: 12 },
      window.location.origin,
    );
  });

  it('accepts a same-origin theme command from its exact parent only', () => {
    render(<Probe workflowId={null} />);

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: parentWindow,
      data: { type: 'argus:studio:theme', theme: 'light' },
    })));
    expect(document.documentElement).toHaveClass('light');
    expect(localStorage.getItem('argus-theme')).toBe('light');

    act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://attacker.example',
      source: parentWindow,
      data: { type: 'argus:studio:theme', theme: 'dark' },
    })));
    expect(document.documentElement).toHaveClass('light');
  });

  it('hands safe Console routes to the parent instead of navigating the embedded frame', () => {
    navigateToConsolePath('/mcp-fabric?catalog=github&returnTo=%2Fbuild%2Fworkflows%2Fstudio%2F186');
    expect(parentPostMessage).toHaveBeenCalledWith({
      type: 'argus:builder:open-console',
      path: '/mcp-fabric?catalog=github&returnTo=%2Fbuild%2Fworkflows%2Fstudio%2F186',
    }, window.location.origin);
  });

  it('maps the internal iframe route back to its canonical Console route', () => {
    expect(consoleStudioReturnPath('/workflows/builder/186', '?execution=24'))
      .toBe('/build/workflows/studio/186?execution=24');
    expect(consoleStudioReturnPath('/workflows/builder', ''))
      .toBe('/build/workflows/studio');
  });

  it('rejects external and unrelated Console destinations', () => {
    navigateToConsolePath('https://attacker.example/mcp-fabric');
    navigateToConsolePath('/observe/audit');
    expect(parentPostMessage).not.toHaveBeenCalled();
  });

  it('hands a validated Pack trace to the embedding Console shell', () => {
    navigateToWorkflowReplay(149, '927d3c7a-4b82-4693-bf67-9e96159990c1');
    expect(parentPostMessage).toHaveBeenCalledWith({
      type: 'argus:builder:replay',
      workflowId: 149,
      traceId: '927d3c7a-4b82-4693-bf67-9e96159990c1',
    }, window.location.origin);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useUnsavedGuard } from '../unsavedGuard';
import { useBuilderStore } from '../builderStore';

function Harness() {
  useUnsavedGuard();
  return null;
}

afterEach(() => {
  useBuilderStore.getState().reset();
});

// jsdom 25 sets defaultPrevented=true for ANY beforeunload dispatch and coerces
// returnValue to boolean. We spy on evt.preventDefault to count explicit calls
// from our handler, which is the only reliable observable in this environment.
function dispatchBeforeUnload(): { preventDefaultCalls: number } {
  const evt = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  evt.returnValue = '';
  const spy = vi.spyOn(evt, 'preventDefault');
  window.dispatchEvent(evt);
  return { preventDefaultCalls: spy.mock.calls.length };
}

describe('useUnsavedGuard', () => {
  it('calls preventDefault when the store is dirty', () => {
    useBuilderStore.setState({ dirty: true });
    render(<Harness />);
    const { preventDefaultCalls } = dispatchBeforeUnload();
    expect(preventDefaultCalls).toBeGreaterThan(0);
  });

  it('does not call preventDefault when the store is clean', () => {
    useBuilderStore.setState({ dirty: false });
    render(<Harness />);
    const { preventDefaultCalls } = dispatchBeforeUnload();
    expect(preventDefaultCalls).toBe(0);
  });

  it('removes the listener on unmount — no longer blocks unload', () => {
    useBuilderStore.setState({ dirty: true });
    const { unmount } = render(<Harness />);
    unmount();
    const { preventDefaultCalls } = dispatchBeforeUnload();
    expect(preventDefaultCalls).toBe(0);
  });
});

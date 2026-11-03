// Unsaved-changes guard (U2). Registers a window `beforeunload` handler while
// the builder store is dirty, prompting the browser's native "leave site?"
// dialog. Reads `dirty` live via useBuilderStore.getState() so the handler
// reflects current state without re-registering on every keystroke.

import { useEffect } from 'react';
import { useBuilderStore } from './builderStore';

export function useUnsavedGuard(): void {
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!useBuilderStore.getState().dirty) return;
      e.preventDefault();
      // Legacy Chrome/Firefox contract: a truthy returnValue triggers the prompt.
      e.returnValue = true;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}

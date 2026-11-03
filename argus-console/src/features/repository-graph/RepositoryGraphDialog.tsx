import { useEffect, useRef } from 'react';
import type { NativeCodeIndexSnapshot } from '../../types';
import { RepositoryGraphViewer } from './RepositoryGraphViewer';
import type { RepositoryGraphLoader, RepositoryGraphOverviewLoader } from './types';

export interface RepositoryGraphDialogProps {
  snapshot: NativeCodeIndexSnapshot;
  loadGraph?: RepositoryGraphLoader;
  loadOverview?: RepositoryGraphOverviewLoader;
  onClose: () => void;
}

export function RepositoryGraphDialog({ snapshot, loadGraph, loadOverview, onClose }: RepositoryGraphDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onClose]);

  return <div
    className="repository-graph-dialog-backdrop"
    onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}
  >
    <div
      ref={dialogRef}
      className="repository-graph-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={`Graphify snapshot ${snapshot.id} for ${snapshot.repositoryKey}`}
      tabIndex={-1}
    >
      <RepositoryGraphViewer
        snapshotId={String(snapshot.id)}
        initialView="architecture"
        loadGraph={loadGraph}
        loadOverview={loadOverview}
        onClose={onClose}
      />
    </div>
  </div>;
}

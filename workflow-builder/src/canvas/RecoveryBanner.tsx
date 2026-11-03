// Crash-recovery prompt shown when a newer local autosave snapshot exists
// than the server copy of the workflow. See stores/autosave.ts:checkRecovery.

interface RecoveryBannerProps {
  onRestore: () => void;
  onDismiss: () => void;
}

export function RecoveryBanner({ onRestore, onDismiss }: RecoveryBannerProps) {
  return (
    <div
      role="alert"
      className="absolute top-2 left-1/2 z-30 -translate-x-1/2 flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-small text-foreground shadow-md backdrop-blur"
    >
      <span>Ungespeicherte Änderungen wiederherstellen?</span>
      <button
        type="button"
        onClick={onRestore}
        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Wiederherstellen
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded-md px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        Verwerfen
      </button>
    </div>
  );
}

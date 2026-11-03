// Breadcrumb cluster for the workflow-builder TopBar.
// Plain <a href> anchors with target="_top": the builder runs inside the
// /build/workflows/studio shell iframe, so navigating "up" to a shell page must
// replace the WHOLE window — without _top the shell page would load inside
// the iframe, stacking a second sidebar (doubled nav). When the builder is
// served standalone (no iframe), _top === the window, so this is a no-op.

import { ChevronRight } from 'lucide-react';

export function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-small text-muted-foreground">
      <a href="/home" target="_top" className="hover:text-foreground transition">Argus</a>
      <ChevronRight className="w-3 h-3 opacity-50" />
      <a href="/build/workflows" target="_top" className="hover:text-foreground transition">Workflows</a>
      <ChevronRight className="w-3 h-3 opacity-50" />
    </nav>
  );
}

// Fullscreen toggle — hides Sidebar+Properties for presentation/stakeholder demos.

import { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/ui/button';

export function useCanvasMode(): { fullscreen: boolean; toggle: () => void } {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    document.body.classList.toggle('argus-canvas-fullscreen', fullscreen);
    return () => document.body.classList.remove('argus-canvas-fullscreen');
  }, [fullscreen]);
  return { fullscreen, toggle: () => setFullscreen((v) => !v) };
}

export function CanvasModeButton({ fullscreen, onToggle }: { fullscreen: boolean; onToggle: () => void }) {
  return (
    <Button variant="ghost" size="icon" title={fullscreen ? 'Vollbild beenden' : 'Vollbild-Canvas'} onClick={onToggle}>
      {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
    </Button>
  );
}

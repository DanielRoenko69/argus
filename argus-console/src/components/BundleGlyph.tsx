import { Activity, Boxes, Code2, Eye, ShieldCheck } from 'lucide-react';

export function BundleGlyph({ icon, size = 16 }: { icon?: string | null; size?: number }) {
  if (icon === 'activity') return <Activity aria-hidden="true" size={size} />;
  if (icon === 'code') return <Code2 aria-hidden="true" size={size} />;
  if (icon === 'observability' || icon === 'eye') return <Eye aria-hidden="true" size={size} />;
  if (icon === 'shield') return <ShieldCheck aria-hidden="true" size={size} />;
  if (icon && !/^[a-z][a-z0-9_-]*$/i.test(icon)) return <span aria-hidden="true">{icon}</span>;
  return <Boxes aria-hidden="true" size={size} />;
}

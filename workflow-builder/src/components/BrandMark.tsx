import { useState } from 'react';
import { Plug } from 'lucide-react';
import { getIcon } from '@/lib/iconRegistry';

interface BrandMarkProps {
  brand?: string | null;
  label: string;
  fallbackIcon?: string;
  className?: string;
}

export function BrandMark({ brand, label, fallbackIcon = 'Plug', className = '' }: BrandMarkProps) {
  const [failed, setFailed] = useState(false);
  const Icon = getIcon(fallbackIcon, Plug);
  return (
    <span className={`builder-brand-mark ${className}`.trim()} aria-label={label} role="img">
      {brand && !failed
        ? <img src={`/console-assets/brand/${brand}.svg`} alt="" onError={() => setFailed(true)} />
        : <Icon aria-hidden="true" />}
    </span>
  );
}

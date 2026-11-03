import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '../store/chat.js';

function ParamRow({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number;
  value: number | undefined; onChange: (v: number | undefined) => void;
}) {
  const isSet = value !== undefined;
  return (
    <div className="param-row">
      <label className="param-label">{label}</label>
      <input
        type="range" min={min} max={max} step={step}
        value={isSet ? value : (min + max) / 2}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="param-val">{isSet ? value : 'Auto'}</span>
      {isSet && (
        <button type="button" className="param-clear" aria-label={`${label} auto`} onClick={() => onChange(undefined)}>×</button>
      )}
    </div>
  );
}

export function ParamPanel() {
  const params = useChatStore((s) => s.params);
  const setParam = useChatStore((s) => s.setParam);
  const resetParams = useChatStore((s) => s.resetParams);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const anySet = params.temperature !== undefined || params.max_tokens !== undefined || params.top_p !== undefined;

  return (
    <div className="param-panel" ref={ref}>
      <button
        type="button" className="param-toggle" aria-label="Tuning" aria-expanded={open}
        title="Model parameters" onClick={() => setOpen((o) => !o)}
      >
        ⚙ Tuning{anySet ? ' •' : ''}
      </button>
      {open && (
        <div className="param-popover" role="dialog" aria-label="Model parameters">
          <ParamRow label="Temperature" min={0} max={2} step={0.1} value={params.temperature} onChange={(v) => setParam('temperature', v)} />
          <ParamRow label="Top-p" min={0} max={1} step={0.05} value={params.top_p} onChange={(v) => setParam('top_p', v)} />
          <div className="param-row">
            <label className="param-label">Max tokens</label>
            <input
              type="number" min={1} max={32000} placeholder="Auto" className="param-num"
              aria-label="Max tokens" value={params.max_tokens ?? ''}
              onChange={(e) => setParam('max_tokens', e.target.value === '' ? undefined : Number(e.target.value))}
            />
            {params.max_tokens !== undefined && (
              <button type="button" className="param-clear" aria-label="Max tokens auto" onClick={() => setParam('max_tokens', undefined)}>×</button>
            )}
          </div>
          <button type="button" className="param-reset" onClick={resetParams} disabled={!anySet}>Reset all</button>
        </div>
      )}
    </div>
  );
}

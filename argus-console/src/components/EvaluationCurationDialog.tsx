import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Native modal keeps focus/escape behavior consistent with comparison authoring. */
export function EvaluationCurationDialog({ title,busy,onClose,children }:{ title:string; busy:boolean; onClose:()=>void; children:ReactNode }) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous=document.activeElement as HTMLElement|null,el=ref.current!;
    if (el.showModal) el.showModal(); else el.setAttribute('open','');
    return () => { el.close?.(); previous?.focus(); };
  },[]);
  return <dialog ref={ref} className="evaluation-dialog" aria-label={title} onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <header className="editor-header"><div><span className="eyebrow">EVALUATION · HUMAN REVIEW</span><h2>{title}</h2></div>
      <button type="button" className="editor-close" aria-label="Close review" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="evaluation-dialog-body">{children}</div>
  </dialog>;
}

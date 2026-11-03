// Modal: pick a template → POST /from-template → navigate to /:id.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTemplates, useCloneTemplate, type TemplateRow } from '@/api/builder';
import { Button } from '@/ui/button';
import { AlertTriangle, CheckCircle2, ExternalLink, Sparkles, X, Loader2 } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function TemplatesDialog({ open, onClose }: Props) {
  const { data, isLoading } = useTemplates();
  const clone = useCloneTemplate();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<TemplateRow | null>(null);

  if (!open) return null;

  async function onCreate() {
    if (!selected) return;
    try {
      const r = await clone.mutateAsync({ template_id: selected.id });
      onClose();
      navigate(`/${r.id}`);
    } catch { /* error surfaced via clone.error */ }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="w-[600px] max-h-[80vh] bg-card border border-border rounded-lg shadow-2xl flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-accent" />
            <h2 className="text-small font-medium">Neuer Workflow aus Template</h2>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground text-small">Templates werden geladen…</div>
          ) : (
            <ul className="space-y-2">
              {(data?.templates ?? []).map((tpl) => (
                <li key={tpl.id} className="space-y-1.5">
                  <button
                    onClick={() => setSelected(tpl)}
                    className={`w-full text-left px-3 py-2 rounded-md border transition-colors ${
                      selected?.id === tpl.id
                        ? 'border-primary bg-primary/10'
                        : 'border-border hover:border-primary/50 hover:bg-secondary/50'
                    }`}
                  >
                    <div className="font-medium text-small">{tpl.name.replace(/^tpl_/, '').replace(/_/g, ' ')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{tpl.description}</div>
                    <div className="text-xs text-muted-foreground mt-1 font-mono">{tpl.steps.length} Steps</div>
                    {(tpl.integration_readiness?.requirements.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {tpl.integration_readiness!.requirements.map(requirement => (
                          <span
                            key={requirement.stepId}
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${
                              requirement.ready
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                            }`}
                          >
                            {requirement.ready
                              ? <CheckCircle2 className="w-3 h-3" />
                              : <AlertTriangle className="w-3 h-3" />}
                            {requirement.integrationLabel} · {requirement.access}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                  {selected?.id === tpl.id && tpl.integration_readiness && !tpl.integration_readiness.ready && (
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                      <div className="font-medium">Vor dem Erstellen verbinden:</div>
                      <div className="flex flex-wrap gap-2 mt-1.5">
                        {tpl.integration_readiness.requirements.filter(requirement => !requirement.ready).map(requirement => (
                          <a
                            key={requirement.stepId}
                            href={requirement.configureHref}
                            className="inline-flex items-center gap-1 underline underline-offset-2"
                          >
                            {requirement.integrationLabel} konfigurieren <ExternalLink className="w-3 h-3" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </li>
              ))}
              {(data?.templates ?? []).length === 0 && (
                <li className="text-center py-8 text-muted-foreground text-small">Keine Templates gefunden</li>
              )}
            </ul>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          {clone.isError && <span className="text-xs text-destructive mr-auto">Fehler: {String(clone.error)}</span>}
          <Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button>
          <Button
            variant="default"
            size="sm"
            disabled={!selected || clone.isPending || selected.integration_readiness?.ready === false}
            onClick={onCreate}
          >
            {clone.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Workflow erstellen
          </Button>
        </footer>
      </div>
    </div>
  );
}

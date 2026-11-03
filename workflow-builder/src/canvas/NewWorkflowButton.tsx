// "+ Neuer Workflow" affordance for the builder.
// Trigger (toolbar button or EmptyState CTA) → modal (name + description) →
// POST /api/admin/workflows {name, description, enabled:true} → navigate to /:id.
//
// AUTH: POST /api/admin/workflows is requireAdmin (src/index.ts:1998). Non-admins
// will get a 403 surfaced via create.error. If Devs must create workflows, the
// requireAdmin gate must be revisited as a SEPARATE decision (flagged, not here).

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, Loader2 } from 'lucide-react';
import { Button } from '@/ui/button';
import { useCreateWorkflow } from '@/api/workflows';
import { slugifyWorkflowName } from '@/lib/workflowName';

interface Props {
  /** 'toolbar' = compact ghost button (TopBar); 'cta' = prominent primary button (EmptyState). */
  variant?: 'toolbar' | 'cta';
}

export function NewWorkflowButton({ variant = 'toolbar' }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateWorkflow();
  const navigate = useNavigate();

  function reset() {
    setName('');
    setDescription('');
  }

  // The DB constrains name to ^[a-z0-9_]+$ (wf_name_format); slugify the
  // free-text name so "Coding Workflow" -> "coding_workflow".
  const slug = slugifyWorkflowName(name);

  async function onCreate() {
    if (!slug || create.isPending) return;
    try {
      const wf = await create.mutateAsync({ name: slug, description: description.trim() });
      setOpen(false);
      reset();
      // basename is "/workflows/builder" (main.tsx) → navigate is basename-relative.
      // navigate('/99') resolves to /workflows/builder/99 — NOT double-prefixed.
      navigate(`/${wf.id}`);
    } catch {
      /* error surfaced via create.error */
    }
  }

  const trigger =
    variant === 'cta' ? (
      <Button variant="default" size="sm" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" /> Neuer Workflow
      </Button>
    ) : (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="Neuen Workflow erstellen">
        <Plus className="w-3.5 h-3.5" /> Neuer Workflow
      </Button>
    );

  return (
    <>
      {trigger}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[460px] bg-card border border-border rounded-lg shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Plus className="w-4 h-4 text-accent" />
                <h2 className="text-small font-medium">Neuer Workflow</h2>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary"
              >
                <X className="w-4 h-4" />
              </button>
            </header>

            <div className="p-4 space-y-3">
              <div className="space-y-1">
                <label htmlFor="nw-name" className="block text-xs font-medium text-foreground">
                  Name <span className="text-red-400">*</span>
                </label>
                <input
                  id="nw-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  placeholder="z. B. K8s Pod Restart Runbook"
                  className="w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {name.trim() && (
                  <p className="text-xs text-muted-foreground">
                    {slug
                      ? <>Wird angelegt als: <code className="text-accent">{slug}</code></>
                      : 'Bitte Buchstaben oder Ziffern verwenden.'}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label htmlFor="nw-desc" className="block text-xs font-medium text-foreground">
                  Beschreibung
                </label>
                <textarea
                  id="nw-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="optional"
                  className="w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {create.isError && (
                <div className="text-xs text-destructive p-2 rounded bg-red-500/10 border border-red-500/30">
                  {String(create.error)}
                </div>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Abbrechen
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={!slug || create.isPending}
                onClick={onCreate}
              >
                {create.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Erstellen
              </Button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

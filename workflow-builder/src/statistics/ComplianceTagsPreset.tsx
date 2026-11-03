// Quick-toggle for Argus compliance presets — NIS2, ISO27001, DORA, PII.
// They're just regular tags but with a UI affordance.

import { Shield, ShieldCheck } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { useSetTags } from '@/api/stats';
import { useFlow } from '@/api/workflows';
import { cn } from '@/lib/utils';

const PRESETS: Array<{ key: string; label: string; desc: string; color: string }> = [
  { key: 'compliance:nis2',     label: 'NIS2',      desc: 'EU NIS2-Direktive', color: 'border-amber-500/40 text-amber-300 bg-amber-500/10' },
  { key: 'compliance:iso27001', label: 'ISO27001',  desc: 'ISO/IEC 27001 Information Security', color: 'border-blue-500/40 text-blue-300 bg-blue-500/10' },
  { key: 'compliance:dora',     label: 'DORA',      desc: 'EU Digital Operational Resilience Act', color: 'border-violet-500/40 text-violet-300 bg-violet-500/10' },
  { key: 'compliance:soc2',     label: 'SOC2',      desc: 'SOC 2 Type II', color: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' },
  { key: 'data:pii',            label: 'PII',       desc: 'Verarbeitet personenbezogene Daten', color: 'border-pink-500/40 text-pink-300 bg-pink-500/10' },
  { key: 'data:eu-only',        label: 'EU-only',   desc: 'Daten dürfen nur in EU verarbeitet werden', color: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10' },
];

interface Props { workflowId: number | null }

export function ComplianceTagsPreset({ workflowId }: Props) {
  const { data: flow } = useFlow(workflowId);
  const setTags = useSetTags(workflowId);
  const tags = ((flow as unknown as { tags?: string[] })?.tags) ?? [];

  function toggle(key: string) {
    const next = tags.includes(key) ? tags.filter((t) => t !== key) : [...tags, key];
    setTags.mutate(next);
  }

  if (!workflowId) return null;
  const active = PRESETS.filter((p) => tags.includes(p.key)).length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs border transition-colors',
            active > 0
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-border bg-card/30 text-muted-foreground hover:text-foreground',
          )}
          title="Compliance-Tags verwalten"
        >
          {active > 0 ? <ShieldCheck className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
          <span>Compliance</span>
          <span className="rounded-full bg-background/60 px-1.5 text-[9px] tabular-nums">{active}/{PRESETS.length}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-[150] w-[310px] rounded-xl border border-border bg-background p-3 shadow-2xl"
        >
          <div className="mb-3">
            <strong className="block text-xs">Workflow compliance</strong>
            <span className="text-[10px] text-muted-foreground">Kennzeichnungen bleiben am Workflow und fließen in Evidence und Suche ein.</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => {
              const selected = tags.includes(p.key);
              return (
                <button
                  type="button"
                  key={p.key}
                  onClick={() => toggle(p.key)}
                  title={p.desc}
                  aria-pressed={selected}
                  className={cn(
                    'grid gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                    selected ? p.color : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                  )}
                >
                  <span className="text-[11px] font-semibold">{p.label}</span>
                  <span className="text-[9px] opacity-75">{p.desc}</span>
                </button>
              );
            })}
          </div>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

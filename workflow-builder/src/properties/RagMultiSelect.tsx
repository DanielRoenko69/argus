// Item 3: per-agent RAG subset selector. Reads the selected agent node's
// `agent_id` from the builder store, finds that agent in the palette, and
// renders a checkbox per bound RAG index. Selection persists as a number[]
// under step.args.rag_index_ids. Empty array = "use the agent's default
// (all bound) indexes" — the executor treats empty/absent identically.

import { useBuilderStore } from '@/stores/builderStore';
import { usePalette } from '@/api/palette';
import { resolvePaletteAgent } from '@/lib/agentBinding';

export function RagMultiSelect({ nodeId }: { nodeId: string }): React.ReactNode {
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === nodeId));
  const updateNodeData = useBuilderStore((s) => s.updateNodeData);
  const { data: palette } = usePalette();

  const data = (node?.data ?? {}) as { agent_id?: number; agent_role?: string; args?: Record<string, unknown> };
  const agent = resolvePaletteAgent(palette?.agents ?? [], data);
  const indexes = agent?.rag_indexes ?? [];
  const selected = Array.isArray((data.args as { rag_index_ids?: unknown })?.rag_index_ids)
    ? ((data.args as { rag_index_ids: number[] }).rag_index_ids)
    : [];

  if (!agent || indexes.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Dieser Agent hat keine gebundenen RAG-Indizes.
      </p>
    );
  }

  const toggle = (id: number, on: boolean) => {
    const next = on
      ? Array.from(new Set([...selected, id]))
      : selected.filter((x) => x !== id);
    updateNodeData(nodeId, { args: { ...(data.args ?? {}), rag_index_ids: next } });
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        Leer = alle gebundenen Indizes des Agents.
      </p>
      {indexes.map((r) => (
        <label key={r.id} className="flex items-center gap-2 text-small cursor-pointer">
          <input
            type="checkbox"
            className="w-4 h-4 accent-primary"
            checked={selected.includes(r.id)}
            onChange={(e) => toggle(r.id, e.target.checked)}
          />
          <span>{r.label}</span>
        </label>
      ))}
    </div>
  );
}

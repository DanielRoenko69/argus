// Additional Phase-4 node types — Wait, Note, Variables, Table, Workflow.

import { type NodeProps, Handle, Position } from 'reactflow';
import { BaseNode } from './BaseNode';
import { registerNode } from './registry';
import { cn } from '@/lib/utils';
import { StickyNote } from 'lucide-react';

// ── Wait ─────────────────────────────────────────────────────────
function WaitNode(props: NodeProps) {
  const sec = (props.data as { seconds?: number })?.seconds ?? 0;
  return (
    <BaseNode icon="Hourglass" label="Wait" category="logic" selected={props.selected} nodeId={props.id}>
      <div>Pause: <code className="text-foreground">{sec}s</code></div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.wait',
    label: 'Wait',
    category: 'logic',
    icon: 'Hourglass',
    description: 'Pausiert den Workflow für N Sekunden oder bis externes Resume.',
    defaultData: () => ({ label: 'Wait', seconds: 5, args: {} }),
    fields: [
      { name: 'seconds', label: 'Sekunden', type: 'number', min: 0, max: 86400, default: 5 },
    ],
  },
  WaitNode
);

// ── Note ─────────────────────────────────────────────────────────
// Sticky note — no handles, just text.
function NoteNode(props: NodeProps) {
  const text = (props.data as { text?: string })?.text ?? 'Notiz…';
  const label = (props.data as { label?: string })?.label?.trim() || 'Notiz';
  const selected = props.selected;
  return (
    <article className={cn('builder-note-node', selected && 'is-selected')} aria-label={`Notiz: ${label}`}>
      <header>
        <StickyNote className="w-3.5 h-3.5" />
        <span>NOTIZ</span>
        <strong>{label}</strong>
      </header>
      <p>{text}</p>
    </article>
  );
}
registerNode(
  {
    type: 'logic.note',
    label: 'Note',
    category: 'logic',
    icon: 'StickyNote',
    description: 'Sticky-Note für Kommentare — wird beim Execute übersprungen.',
    defaultData: () => ({ label: 'Note', text: 'Hier ein Hinweis…', args: {} }),
    fields: [
      { name: 'text', label: 'Notiz-Text', type: 'textarea', rows: 5 },
    ],
  },
  NoteNode
);

// ── Variables ────────────────────────────────────────────────────
function VariablesNode(props: NodeProps) {
  const data = props.data as { variables?: unknown; args?: Record<string, unknown> };
  const vars = data.variables ?? data.args?.['variables'] ?? {};
  const count = collectionSize(vars, 'object');
  return (
    <BaseNode icon="Variable" label="Variables" category="logic" selected={props.selected} nodeId={props.id}>
      <div>{count} Variable{count === 1 ? '' : 'n'} setzen</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.variables',
    label: 'Variables',
    category: 'logic',
    icon: 'Variable',
    description: 'Setzt Workflow-Variablen (JSON-Objekt) für nachfolgende Steps.',
    defaultData: () => ({ label: 'Variables', variables: {}, args: {} }),
    fields: [
      {
        name: 'variables',
        label: 'JSON Objekt',
        type: 'textarea',
        rows: 6,
        placeholder: '{ "name": "value" }',
      },
    ],
  },
  VariablesNode
);

// ── Table ────────────────────────────────────────────────────────
function TableNode(props: NodeProps) {
  const data = props.data as { rows?: unknown; args?: Record<string, unknown> };
  const rows = data.rows ?? data.args?.['rows'] ?? [];
  const count = collectionSize(rows, 'array');
  return (
    <BaseNode icon="Table2" label="Table" category="logic" selected={props.selected} nodeId={props.id}>
      <div>{count} Zeile{count === 1 ? '' : 'n'}</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.table',
    label: 'Table',
    category: 'logic',
    icon: 'Table2',
    description: 'Validiert und übergibt strukturierte JSON-Zeilen an nachfolgende Steps.',
    defaultData: () => ({ label: 'Table', rows: [], args: {} }),
    fields: [
      {
        name: 'rows',
        label: 'Daten (JSON-Array)',
        type: 'textarea',
        rows: 6,
        placeholder: '[ { "col": "value" } ]',
      },
    ],
  },
  TableNode
);

function collectionSize(value: unknown, expected: 'object' | 'array'): number {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return 0; }
  }
  if (expected === 'array') return Array.isArray(parsed) ? parsed.length : 0;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? Object.keys(parsed).length
    : 0;
}

// ── For Each ──────────────────────────────────────────────────────
function ForEachNode(props: NodeProps) {
  const data = props.data as {
    mode?: string;
    concurrency?: number;
    args?: Record<string, unknown>;
  };
  const mode = String(data.mode ?? data.args?.['mode'] ?? 'transform');
  const concurrency = Number(data.concurrency ?? data.args?.['concurrency'] ?? 4);
  return (
    <BaseNode icon="Repeat2" label="For Each" category="logic" selected={props.selected} nodeId={props.id}>
      <div>{mode === 'subworkflow' ? `Sub-Workflow · max. ${concurrency} parallel` : 'Transform · geordnete Ergebnisse'}</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.for_each',
    label: 'For Each',
    category: 'logic',
    icon: 'Repeat2',
    description: 'Verarbeitet ein JSON-Array kontrolliert pro Element – als Transform oder Sub-Workflow.',
    defaultData: () => ({
      label: 'For Each',
      mode: 'transform',
      items: '{{ steps.previous.result }}',
      function_code: 'return { index, item };',
      target_workflow_id: null,
      child_inputs: '{}',
      concurrency: 4,
      retries: 0,
      on_item_error: 'stop',
      args: {},
    }),
    fields: [
      {
        name: 'mode',
        label: 'Modus',
        type: 'select-static',
        options: [
          { value: 'transform', label: 'Kontrollierter Transform' },
          { value: 'subworkflow', label: 'Sub-Workflow pro Element' },
        ],
        default: 'transform',
      },
      {
        name: 'items',
        label: 'Elemente (JSON-Array oder Template)',
        type: 'textarea',
        rows: 4,
        placeholder: '{{ steps.table.result }}',
      },
      {
        name: 'function_code',
        label: 'JavaScript (nur Transform)',
        type: 'textarea',
        rows: 7,
        placeholder: 'return { index, item };',
      },
      { name: 'target_workflow_id', label: 'Sub-Workflow (nur Sub-Workflow-Modus)', type: 'select-workflows' },
      {
        name: 'child_inputs',
        label: 'Statische Child-Inputs (JSON-Objekt)',
        type: 'textarea',
        rows: 4,
        placeholder: '{ "source": "visual-builder" }',
      },
      { name: 'concurrency', label: 'Max. Parallelität (Sub-Workflow)', type: 'number', min: 1, max: 16, default: 4 },
      { name: 'retries', label: 'Retries pro Element (nur idempotente Abläufe)', type: 'number', min: 0, max: 3, default: 0 },
      {
        name: 'on_item_error',
        label: 'Bei Elementfehler',
        type: 'select-static',
        options: [
          { value: 'stop', label: 'Workflow stoppen' },
          { value: 'continue', label: 'Fehler erfassen und fortfahren' },
        ],
        default: 'stop',
      },
    ],
  },
  ForEachNode
);

// ── Sub-Workflow ─────────────────────────────────────────────────
function WorkflowNode(props: NodeProps) {
  const targetId = (props.data as { target_workflow_id?: number })?.target_workflow_id;
  return (
    <BaseNode icon="Layers" label="Sub-Workflow" category="argus" selected={props.selected} nodeId={props.id}>
      <div className="flex items-center gap-1">
        <Handle type="target" position={Position.Left} id="x" className="hidden" />
        target: <code className="text-foreground">#{targetId ?? '—'}</code>
      </div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.workflow',
    label: 'Workflow',
    category: 'argus',
    icon: 'Layers',
    description: 'Ruft einen anderen Argus-Workflow synchron auf.',
    defaultData: () => ({ label: 'Sub-Workflow', target_workflow_id: null, args: {} }),
    fields: [
      { name: 'target_workflow_id', label: 'Sub-Workflow', type: 'select-workflows' },
    ],
  },
  WorkflowNode
);

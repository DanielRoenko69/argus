// Logic nodes — Condition, Parallel, Router, Function, Response.
// Inspired by Sim's block catalog (Apache 2.0).

import { type NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';
import { registerNode } from './registry';

function ConditionNode(props: NodeProps) {
  const cond = (props.data as { condition?: string })?.condition ?? '';
  return (
    <BaseNode icon="GitBranch" label="Condition" category="logic" selected={props.selected} nodeId={props.id}>
      <div className="font-mono text-foreground text-xs truncate" title={cond}>
        {cond || '(no expression)'}
      </div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.condition',
    label: 'Condition',
    category: 'logic',
    icon: 'GitBranch',
    description: 'Wertet eine sichere Bedingung aus und aktiviert genau einen von zwei verbundenen Pfaden.',
    defaultData: () => ({
      label: 'Condition',
      condition: 'input.approved === true',
      true_target: '',
      false_target: '',
      args: {},
    }),
    fields: [
      {
        name: 'condition',
        label: 'Bedingung',
        type: 'textarea',
        rows: 3,
        placeholder: 'input.approved === true',
      },
      { name: 'true_target', label: 'Ziel bei true', type: 'text', placeholder: 'approved_path' },
      { name: 'false_target', label: 'Ziel bei false', type: 'text', placeholder: 'rejected_path' },
    ],
  },
  ConditionNode
);

function ParallelNode(props: NodeProps) {
  return (
    <BaseNode icon="Split" label="Parallel" category="logic" selected={props.selected} nodeId={props.id}>
      <div>Verzweigt in parallele Branches.</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.parallel',
    label: 'Parallel',
    category: 'logic',
    icon: 'Split',
    description: 'Verzweigt den Flow in parallele Branches (alle starten gleichzeitig).',
    defaultData: () => ({ label: 'Parallel', args: {} }),
    fields: [],
  },
  ParallelNode
);

function RouterNode(props: NodeProps) {
  return (
    <BaseNode icon="Route" label="Router" category="logic" selected={props.selected} nodeId={props.id}>
      <div>Entscheidet welcher Branch ausgeführt wird.</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.router',
    label: 'Router',
    category: 'logic',
    icon: 'Route',
    description: 'Switch-Statement: route auf Branch A / B / C basierend auf Wert.',
    defaultData: () => ({
      label: 'Router',
      route_on: '{{ input.route }}',
      routes: '{\n  "approve": "approved_path",\n  "reject": "rejected_path"\n}',
      default_route: '',
      args: {},
    }),
    fields: [
      { name: 'route_on', label: 'Route auf', type: 'text', placeholder: '{{ input.route }}' },
      {
        name: 'routes',
        label: 'Routen als JSON',
        type: 'textarea',
        rows: 5,
        placeholder: '{ "approve": "approved_path", "reject": "rejected_path" }',
      },
      { name: 'default_route', label: 'Optionales Standardziel', type: 'text', placeholder: 'fallback_path' },
    ],
  },
  RouterNode
);

function FunctionNode(props: NodeProps) {
  const code = (props.data as { function_code?: string })?.function_code ?? '';
  return (
    <BaseNode icon="Code2" label="Function" category="logic" selected={props.selected} nodeId={props.id}>
      <div className="font-mono text-xs truncate" title={code}>
        {code ? `${code.slice(0, 32)}…` : '(empty)'}
      </div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.function',
    label: 'Function',
    category: 'logic',
    icon: 'Code2',
    description: 'Kontrollierte synchrone Datentransformation mit input und vorherigen Steps.',
    defaultData: () => ({
      label: 'Function',
      function_code: 'return { value: input.x * 2 };',
      args: {},
    }),
    fields: [
      {
        name: 'function_code',
        label: 'JavaScript',
        type: 'textarea',
        rows: 8,
        placeholder: 'return { value: input.x * 2 };',
      },
    ],
  },
  FunctionNode
);

function ResponseNode(props: NodeProps) {
  return (
    <BaseNode icon="Send" label="Response" category="logic" selected={props.selected} nodeId={props.id} hasOutput={false}>
      <div>Endknoten — gibt Wert an Trigger zurück.</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'logic.response',
    label: 'Response',
    category: 'logic',
    icon: 'Send',
    description: 'Terminal node — der Rückgabewert geht an den Trigger (Webhook/API).',
    defaultData: () => ({ label: 'Response', args: {} }),
    fields: [
      { name: 'value', label: 'Return value', type: 'textarea', rows: 3, placeholder: '{{ steps.previous.result }}' },
    ],
  },
  ResponseNode
);

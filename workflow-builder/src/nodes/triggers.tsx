// Trigger nodes — Manual, Schedule, Webhook.
// Have no input handle (they START the workflow).

import { type NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';
import { registerNode } from './registry';

function ManualTrigger(props: NodeProps) {
  return (
    <BaseNode icon="MousePointerClick" label="Manual Trigger" category="triggers" selected={props.selected} nodeId={props.id} hasInput={false}>
      <div>Wird per Klick gestartet.</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'trigger.manual',
    label: 'Manual',
    category: 'triggers',
    icon: 'MousePointerClick',
    description: 'Startet den Workflow per Knopfdruck oder API-Call.',
    defaultData: () => ({ label: 'Manual Trigger', args: {} }),
    fields: [],
  },
  ManualTrigger
);

function ScheduleTrigger(props: NodeProps) {
  const cron = (props.data as { cron_expr?: string })?.cron_expr ?? '0 * * * *';
  return (
    <BaseNode icon="Clock" label="Schedule Trigger" category="triggers" selected={props.selected} nodeId={props.id} hasInput={false}>
      <div>Cron: <code className="font-mono text-foreground">{cron}</code></div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'trigger.schedule',
    label: 'Schedule',
    category: 'triggers',
    icon: 'Clock',
    description: 'Startet den Workflow per Cron-Schedule.',
    defaultData: () => ({ label: 'Schedule', cron_expr: '0 * * * *', schedule_static_inputs: '{}', args: {} }),
    fields: [
      { name: 'cron_expr', label: 'Cron Expression', type: 'text', placeholder: '0 * * * *', default: '0 * * * *' },
      {
        name: 'schedule_static_inputs',
        label: 'Static non-secret inputs (JSON)',
        type: 'textarea',
        rows: 6,
        placeholder: '{"repository_owner":"org","repository_name":"repo","issue_number":1}',
        default: '{}',
      },
    ],
  },
  ScheduleTrigger
);

function WebhookTrigger(props: NodeProps) {
  const data = props.data as { webhook_path?: string; webhook_provider?: string; webhook_allowed_events?: string };
  const path = data.webhook_path ?? '/webhook/' + props.id.slice(0, 8);
  const endpoint = `/webhooks/wf/${path.replace(/^\/+/, '')}`;
  const provider = data.webhook_provider && data.webhook_provider !== 'auto' ? data.webhook_provider : 'auto-detect';
  return (
    <BaseNode icon="Webhook" label="Webhook Trigger" category="triggers" selected={props.selected} nodeId={props.id} hasInput={false}>
      <div className="font-mono text-foreground text-xs truncate" title={endpoint}>POST {endpoint}</div>
      <div className="mt-1 text-[10px] text-muted-foreground truncate" title={data.webhook_allowed_events ?? ''}>
        {provider}{data.webhook_allowed_events ? ` · ${data.webhook_allowed_events}` : ''}
      </div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'trigger.webhook',
    label: 'Webhook',
    category: 'triggers',
    icon: 'Webhook',
    description: 'Startet den Workflow per HTTP-POST auf einer URL.',
    defaultData: () => ({
      label: 'Webhook', webhook_path: '', webhook_secret_env: '', webhook_provider: 'auto',
      webhook_allowed_events: '', webhook_static_inputs: '{}', webhook_test_payload: '', args: {},
    }),
    fields: [
      { name: 'webhook_path', label: 'Webhook Path', type: 'text', placeholder: '/webhook/my-flow' },
      {
        name: 'webhook_provider', label: 'Payload provider', type: 'select-static', default: 'auto',
        options: [
          { value: 'auto', label: 'Auto-detect from headers' },
          { value: 'github', label: 'GitHub' },
          { value: 'gitea', label: 'Gitea' },
          { value: 'gitlab', label: 'GitLab' },
          { value: 'generic', label: 'Generic JSON' },
        ],
      },
      { name: 'webhook_allowed_events', label: 'Allowed events (comma-separated)', type: 'text', placeholder: 'issues, ping' },
      { name: 'webhook_static_inputs', label: 'Static non-secret inputs (JSON)', type: 'textarea', rows: 4, placeholder: '{"notification_channel":"C012345"}', default: '{}' },
      // Per-workflow HMAC secret (audit #1): names an env-var holding THIS
      // workflow's webhook secret. Leer → globales ARGUS_WEBHOOK_SECRET.
      { name: 'webhook_secret_env', label: 'Secret Env-Var (optional)', type: 'text', placeholder: 'ARGUS_WEBHOOK_SECRET' },
    ],
  },
  WebhookTrigger
);

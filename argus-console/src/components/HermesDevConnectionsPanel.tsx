import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Link2, RefreshCw, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import {
  createHermesDevConnection,
  getHermesDevConnections,
  revokeHermesDevConnection,
  rotateHermesDevConnection,
  testHermesDevConnection,
} from '../api';
import type { HermesDevConnectionSecret } from '../types';
import { timeAgo } from './Ui';

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

export function HermesDevConnectionsPanel() {
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: ['hermes-dev-connections'], queryFn: getHermesDevConnections });
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('My Hermes');
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const [secret, setSecret] = useState<HermesDevConnectionSecret | null>(null);
  const [copied, setCopied] = useState('');

  const bundles = useMemo(() => [...(connections.data?.bundles ?? [])]
    .sort((left, right) => {
      const preferred = (name: string) => /argus-dev|coding|github|code-intelligence/.test(name) ? 0 : 1;
      return preferred(left.name) - preferred(right.name) || left.label.localeCompare(right.label);
    }), [connections.data?.bundles]);

  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['hermes-dev-connections'] });
  const create = useMutation({
    mutationFn: () => createHermesDevConnection({ label: label.trim(), bundleIds }),
    onSuccess: async result => {
      setSecret(result);
      setFormOpen(false);
      await refresh();
    },
  });
  const test = useMutation({ mutationFn: testHermesDevConnection, onSuccess: refresh });
  const rotate = useMutation({
    mutationFn: rotateHermesDevConnection,
    onSuccess: async result => { setSecret(result); await refresh(); },
  });
  const revoke = useMutation({ mutationFn: revokeHermesDevConnection, onSuccess: refresh });
  const mutationError = create.error ?? test.error ?? rotate.error ?? revoke.error;
  const catalogError = connections.error;

  const toggleBundle = (id: number) => setBundleIds(current => current.includes(id)
    ? current.filter(candidate => candidate !== id)
    : [...current, id]);
  const copy = async (name: string, value: string) => {
    await copyText(value);
    setCopied(name);
    window.setTimeout(() => setCopied(current => current === name ? '' : current), 1_500);
  };

  return (
    <section className="panel hermes-dev-connectors" id="hermes-connector" aria-label="Hermes Dev connections">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">HERMES CONNECTOR</span>
          <h2>Use your personal Hermes with Argus Dev</h2>
          <p>Connect an existing Hermes through an SSO-delegated, Bundle-scoped MCP credential. Argus keeps workflow, approvals, logs and traces authoritative.</p>
        </div>
        <button className="button button-primary" type="button" onClick={() => setFormOpen(value => !value)}>
          {formOpen ? <X size={14} /> : <Link2 size={14} />}{formOpen ? 'Close' : 'Connect Hermes'}
        </button>
      </div>

      {formOpen && (
        <div className="hermes-connector-form">
          {catalogError && <div className="editor-error" role="alert">Could not load your Argus identity and available Bundles: {catalogError.message}</div>}
          <label>Connection name<input aria-label="Hermes connection name" value={label} maxLength={128} onChange={event => setLabel(event.target.value)} /></label>
          {connections.data?.identity && <div className="hermes-connector-identity"><ShieldCheck size={16} /><span><b>{connections.data.identity.displayName}</b><small>{connections.data.identity.authentication === 'sso' ? 'SSO identity' : 'Argus session'} · {connections.data.identity.role.replaceAll('_', ' ')}</small></span><em>automatic</em></div>}
          <fieldset>
            <legend>Allowed MCP Bundles</legend>
            <p>Only Bundles currently available to your identity are shown. Hermes receives the selected subset when it starts the canonical Argus Dev workflow.</p>
            <div className="hermes-connector-bundles">
              {bundles.map(bundle => (
                <label key={bundle.id} className={bundleIds.includes(bundle.id) ? 'is-selected' : ''}>
                  <input type="checkbox" checked={bundleIds.includes(bundle.id)} onChange={() => toggleBundle(bundle.id)} />
                  <span><b>{bundle.label}</b><small>{bundle.toolCount} tools · {bundle.name}</small></span>
                </label>
              ))}
              {!connections.isLoading && !catalogError && !bundles.length && <small>No enabled Bundles found for your current identity.</small>}
            </div>
          </fieldset>
          <div className="hermes-connector-boundary"><ShieldCheck size={16} /><span><b>Live authorization boundary</b><small>Current SSO status and Bundle rights are rechecked on every MCP request · no SSO token is copied to Hermes</small></span></div>
          <button className="button button-primary" type="button" disabled={!label.trim() || bundleIds.length === 0 || create.isPending} onClick={() => create.mutate()}>
            <KeyRound size={14} />{create.isPending ? 'Creating…' : 'Create connection'}
          </button>
        </div>
      )}

      {mutationError && <div className="editor-error" role="alert">{mutationError.message}</div>}

      <div className="hermes-connector-list">
        {(connections.data?.connections ?? []).map(connection => (
          <article key={connection.id} className={connection.revokedAt ? 'is-revoked' : ''}>
            <span className="hermes-connector-icon"><Link2 size={17} /></span>
            <div className="hermes-connector-main">
              <div><h3>{connection.label}</h3><span className={`status-badge ${connection.clientSeen ? 'status-healthy' : 'status-warning'}`}>{connection.revokedAt ? 'REVOKED' : connection.clientSeen ? 'CONNECTED' : 'AWAITING CLIENT'}</span></div>
              <p>{connection.displayName} · {connection.bundleIds.length} Bundle{connection.bundleIds.length === 1 ? '' : 's'} · <code>{connection.keyPrefix}…{connection.keySuffix}</code></p>
              <small>{connection.lastUsedAt ? `Hermes last connected ${timeAgo(connection.lastUsedAt)}` : 'The generated key has not reached Argus yet.'}{connection.lastTestState ? ` · Preflight ${connection.lastTestState}` : ''}</small>
              {connection.lastTestDetail && <small>{connection.lastTestDetail}</small>}
            </div>
            {!connection.revokedAt && <div className="hermes-connector-actions">
              <button type="button" disabled={test.isPending} onClick={() => test.mutate(connection.id)}><RefreshCw size={13} />Test</button>
              <button type="button" disabled={rotate.isPending} onClick={() => rotate.mutate(connection.id)}><RotateCw size={13} />Rotate</button>
              <button className="is-danger" type="button" disabled={revoke.isPending} onClick={() => { if (window.confirm(`Revoke ${connection.label}? The current key stops working immediately.`)) revoke.mutate(connection.id); }}><Trash2 size={13} />Revoke</button>
            </div>}
          </article>
        ))}
        {!connections.isLoading && !catalogError && !(connections.data?.connections.length) && <div className="hermes-connector-empty"><Link2 size={22} /><b>No personal Hermes connected</b><span>Create one scoped connection; the secret is shown only once.</span></div>}
      </div>

      {secret && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Hermes connection secret">
          <div className="hermes-connector-secret">
            <span className="api-key-secret-icon"><KeyRound size={20} /></span>
            <h2>Save this Hermes key now</h2>
            <p>It is displayed once. A rotation invalidates the previous key immediately.</p>
            <div className="api-key-secret-value"><code>{secret.apiKey}</code><button type="button" onClick={() => copy('key', secret.apiKey)}>{copied === 'key' ? <Check size={13} /> : <Copy size={13} />}Copy key</button></div>
            <div className="hermes-connector-env"><code>ARGUS_HERMES_DEV_MCP_URL={secret.environment.ARGUS_HERMES_DEV_MCP_URL}{'\n'}ARGUS_HERMES_DEV_MCP_KEY={secret.apiKey}</code><button type="button" onClick={() => copy('env', `ARGUS_HERMES_DEV_MCP_URL=${secret.environment.ARGUS_HERMES_DEV_MCP_URL}\nARGUS_HERMES_DEV_MCP_KEY=${secret.apiKey}`)}>{copied === 'env' ? <Check size={13} /> : <Copy size={13} />}Copy env</button></div>
            <div className="hermes-connector-config"><header><b>Hermes config.yaml</b><button type="button" onClick={() => copy('yaml', secret.configYaml)}>{copied === 'yaml' ? <Check size={13} /> : <Copy size={13} />}Copy YAML</button></header><pre>{secret.configYaml}</pre></div>
            <p className="hermes-connector-hint">If Hermes runs in the same Compose network, use <code>http://mcp-server:3000/mcp/hermes-dev</code>. Remote deployments must use HTTPS.</p>
            <button className="button button-primary" type="button" onClick={() => setSecret(null)}>I saved the key</button>
          </div>
        </div>
      )}
    </section>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  Network,
  RefreshCw,
  Square,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import {
  getAttachedHermesRun,
  getSolutionPackRuntimeAdapterCapabilities,
  getSolutionPackRuntimeAdapterStatus,
  getSolutionPacks,
  refreshSolutionPacks,
  startAttachedHermesRun,
  stopAttachedHermesRun,
} from '../api';
import type {
  HealthState,
  SolutionPackRuntimeAdapterConnectionState,
  SolutionPackRuntimeAdapterDeclaration,
} from '../types';
import { EmptyState, ErrorState, HealthBadge, LoadingState, PageHeader, timeAgo } from '../components/Ui';

function packHealth(state: string): HealthState {
  if (state === 'ready') return 'healthy';
  if (state === 'not_checked') return 'not_configured';
  if (state === 'unreachable') return 'offline';
  return 'degraded';
}

function adapterHealth(state: SolutionPackRuntimeAdapterConnectionState | undefined): HealthState {
  if (state === 'ready') return 'healthy';
  if (state === 'unavailable') return 'offline';
  if (!state) return 'not_configured';
  return 'degraded';
}

function adapterStateLabel(state: SolutionPackRuntimeAdapterConnectionState | undefined): string {
  if (!state) return 'not checked';
  return state.replaceAll('_', ' ');
}

function adapterEndpoint(packEndpoint: string, adapter: SolutionPackRuntimeAdapterDeclaration): string {
  try {
    return new URL(adapter.endpoint, `${packEndpoint}/`).toString();
  } catch {
    return adapter.endpoint;
  }
}

function modeDetail(state: SolutionPackRuntimeAdapterConnectionState | undefined): string {
  if (state === 'ready') return 'Available';
  if (state === 'degraded') return 'Degraded';
  if (state === 'unavailable') return 'Unavailable';
  return 'Not checked';
}

function HermesUsagePaths({ runtimeConnected }: { runtimeConnected: boolean }) {
  return (
    <section className="panel hermes-usage-paths" aria-label="Hermes integration paths">
      <div className="panel-heading"><div><span className="eyebrow">TWO INTEGRATION DIRECTIONS</span><h2>Choose how Hermes participates</h2><p>The personal connector and the runtime Pack solve different directions. Configuration is kept in one canonical place for each path.</p></div></div>
      <div>
        <article className="is-primary">
          <span><Bot size={19} /></span>
          <div><small>HERMES → ARGUS DEV</small><h3>Use your existing Hermes</h3><p>Hermes discovers and starts governed Argus Dev workflows through a narrowly scoped MCP credential delegated by your current SSO identity.</p><a href="/solutions/argus.dev#hermes-connector">Connect in Argus Dev <ArrowRight size={13} /></a></div>
        </article>
        <article>
          <span><Network size={19} /></span>
          <div><small>ARGUS → HERMES RUNTIME</small><h3>Run an Argus agent on Hermes</h3><p>Argus invokes an attached or managed Hermes runtime through the independently maintained argus.hermes Pack.</p><em className={runtimeConnected ? 'is-ready' : 'is-pending'}>{runtimeConnected ? 'Runtime Pack connected' : 'Runtime Pack not connected'}</em></div>
        </article>
      </div>
      <footer><ShieldCheck size={14} /><span>Both paths retain Argus approvals, Bundle policy, audit logs, metrics and root traces. The SSO token stays inside Argus.</span></footer>
    </section>
  );
}

export function HermesSolutionPackPage({ packId = 'argus.hermes' }: { packId?: string }) {
  const queryClient = useQueryClient();
  const [smokeInput, setSmokeInput] = useState('Report your runtime identity and current capabilities. Do not call tools or modify external state.');
  const [externalTrustConfirmed, setExternalTrustConfirmed] = useState(false);
  const [attachedRunId, setAttachedRunId] = useState<string | null>(null);
  const packs = useQuery({ queryKey: ['solution-packs'], queryFn: getSolutionPacks, staleTime: 15_000 });
  const refresh = useMutation({
    mutationFn: refreshSolutionPacks,
    onSuccess: async data => {
      queryClient.setQueryData(['solution-packs'], data);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['solution-pack-runtime-adapter-status', packId] }),
        queryClient.invalidateQueries({ queryKey: ['solution-pack-runtime-adapter-capabilities', packId] }),
      ]);
    },
  });
  const pack = packs.data?.packs.find(item => item.configuredId === packId);
  const manifest = pack?.manifest;
  const runtimeAdapters = manifest?.spec.components.runtimeAdapters ?? [];
  const adapter = runtimeAdapters
    .find(candidate => candidate.runtime === 'hermes')
    ?? runtimeAdapters[0];
  const adapterStatus = useQuery({
    queryKey: ['solution-pack-runtime-adapter-status', packId, adapter?.id, pack?.revision],
    queryFn: () => getSolutionPackRuntimeAdapterStatus(packId, adapter!.id),
    enabled: Boolean(adapter && pack?.state === 'ready'),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const adapterCapabilities = useQuery({
    queryKey: ['solution-pack-runtime-adapter-capabilities', packId, adapter?.id, pack?.revision],
    queryFn: () => getSolutionPackRuntimeAdapterCapabilities(packId, adapter!.id),
    enabled: Boolean(adapter && pack?.state === 'ready'),
    staleTime: 30_000,
  });
  const attachedRun = useQuery({
    queryKey: ['solution-pack-attached-run', packId, adapter?.id, attachedRunId],
    queryFn: () => getAttachedHermesRun(packId, adapter!.id, attachedRunId!),
    enabled: Boolean(adapter && attachedRunId),
    refetchInterval: query => {
      const state = query.state.data?.run.state;
      return state && ['cancelled', 'completed', 'failed'].includes(state) ? false : 1_000;
    },
  });
  const startAttached = useMutation({
    mutationFn: () => startAttachedHermesRun(packId, adapter!.id, smokeInput),
    onSuccess: data => {
      setAttachedRunId(data.run.id);
      queryClient.setQueryData(['solution-pack-attached-run', packId, adapter?.id, data.run.id], data);
    },
  });
  const stopAttached = useMutation({
    mutationFn: () => stopAttachedHermesRun(packId, adapter!.id, attachedRunId!),
    onSuccess: data => queryClient.setQueryData(['solution-pack-attached-run', packId, adapter?.id, data.run.id], data),
  });

  if (packs.isLoading) return <LoadingState label="Discovering Argus Hermes…" />;
  if (packs.error) return <ErrorState error={packs.error} />;

  if (!pack) {
    return (
      <>
        <PageHeader
          eyebrow="SOLUTIONS"
          title="Argus Hermes"
          description="A governed runtime bridge for an attached Hermes service and later managed isolated runners."
        />
        <HermesUsagePaths runtimeConnected={false} />
        <section className="panel solution-empty">
          <EmptyState
            title="Argus Hermes is not connected"
            description="Configure argus.hermes through ARGUS_SOLUTION_PACK_ENDPOINTS, then refresh discovery."
          />
          <button className="button button-primary" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <RefreshCw className={refresh.isPending ? 'spin' : ''} size={15} />Refresh packs
          </button>
        </section>
      </>
    );
  }

  const title = manifest?.metadata.displayName ?? 'Argus Hermes';
  const status = adapterStatus.data?.status;
  const confirmedCapabilities = adapterCapabilities.data?.capabilities.capabilities ?? adapter?.capabilities ?? [];
  const declaredModes = adapter?.modes ?? [];
  const statusModes = new Map(status?.modes.map(mode => [mode.mode, mode]));
  const attachedReady = statusModes.get('attached')?.state === 'ready'
    && confirmedCapabilities.includes('runs');
  const currentAttachedRun = attachedRun.data ?? startAttached.data;
  const totalComponents = manifest
    ? manifest.spec.components.agents.length
      + runtimeAdapters.length
      + manifest.spec.components.skills.length
      + manifest.spec.components.bundles.length
      + manifest.spec.components.workflows.length
      + manifest.spec.components.knowledgeSources.length
      + manifest.spec.components.dashboards.length
      + manifest.spec.components.policies.length
    : 0;

  return (
    <>
      <PageHeader
        eyebrow="SOLUTIONS · ARGUS CORE"
        title={title}
        description={manifest?.metadata.description ?? 'Hermes runtime bridge connected to the governed Argus Core control plane.'}
        actions={(
          <>
            <button className="button button-secondary" type="button" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={refresh.isPending ? 'spin' : ''} size={15} />Refresh
            </button>
            <a className="button button-secondary" href="/build/agents/manage"><Bot size={15} />Agent Studio</a>
          </>
        )}
      />

      <HermesUsagePaths runtimeConnected={pack.state === 'ready'} />

      <section className="solution-hero hermes-solution-hero">
        <div className="solution-identity">
          <span className="solution-mark"><Bot size={26} /></span>
          <div><small>RUNTIME SOLUTION PACK</small><h2>{title}</h2><p>{pack.endpoint}</p></div>
          <HealthBadge state={packHealth(pack.state)} />
        </div>
        <div className="solution-facts">
          <span><b>{manifest?.metadata.version ?? '—'}</b><small>pack version</small></span>
          <span><b>{runtimeAdapters.length}</b><small>runtime adapters</small></span>
          <span><b>{adapter?.runtime ?? '—'}</b><small>execution runtime</small></span>
          <span><b>{adapterStateLabel(status?.state)}</b><small>adapter connection</small></span>
          <span><b>{pack.readiness?.latencyMs ?? '—'}{pack.readiness ? ' ms' : ''}</b><small>pack readiness</small></span>
        </div>
      </section>

      {pack.error && <div className="editor-error" role="alert">{pack.error}</div>}

      <section className="panel hermes-boundary-panel" aria-labelledby="hermes-boundary-title">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">GOVERNED RUNTIME BOUNDARY</span>
            <h2 id="hermes-boundary-title">Hermes runs behind Argus Core</h2>
            <p>Argus owns agent identity, MCP Fabric bundles, approvals and trace evidence. This screen only inspects the Pack declaration and its connection state.</p>
          </div>
          <span className="hermes-read-only"><ShieldCheck size={13} />Read-only status</span>
        </div>
        <div className="hermes-boundary-grid">
          <article><Network size={17} /><span><small>PACK BRIDGE</small><b>{pack.health?.ok ? 'Reachable' : 'Unavailable'}</b><em>{pack.health?.ok ? `${pack.health.latencyMs} ms health probe` : 'No healthy pack response'}</em></span></article>
          <article><CheckCircle2 size={17} /><span><small>PACK READINESS</small><b>{pack.readiness?.ok ? 'Ready' : 'Not ready'}</b><em>{pack.readiness?.ok ? `${pack.readiness.latencyMs} ms readiness probe` : 'Runtime declaration is not currently ready'}</em></span></article>
          <article><CircleDot size={17} /><span><small>MANIFEST CONTRACT</small><b>{manifest?.apiVersion ?? 'Missing'}</b><em>{totalComponents} declared component{totalComponents === 1 ? '' : 's'}</em></span></article>
        </div>
      </section>

      {adapter && (
        <section className="panel hermes-smoke-panel" aria-labelledby="hermes-smoke-title">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">ATTACHED RUNTIME SMOKE TEST</span>
              <h2 id="hermes-smoke-title">Run the configured external Hermes service</h2>
              <p>This executes on the attached Hermes service. Its native tools and credentials remain outside Argus MCP policy enforcement.</p>
            </div>
            <span className="hermes-read-only"><ShieldCheck size={13} />External / attested</span>
          </div>
          <label className="field-label" htmlFor="hermes-smoke-input">Smoke-test instruction</label>
          <textarea
            id="hermes-smoke-input"
            className="input hermes-smoke-input"
            value={smokeInput}
            maxLength={65_536}
            onChange={event => setSmokeInput(event.target.value)}
          />
          <label className="hermes-smoke-confirmation">
            <input type="checkbox" checked={externalTrustConfirmed} onChange={event => setExternalTrustConfirmed(event.target.checked)} />
            I understand that attached Hermes tools are externally governed and do not receive an Argus Core MCP lease.
          </label>
          <div className="hermes-smoke-actions">
            <button
              className="button button-primary"
              type="button"
              disabled={!attachedReady || !externalTrustConfirmed || !smokeInput.trim() || startAttached.isPending}
              onClick={() => startAttached.mutate()}
            >
              <Bot size={15} />{startAttached.isPending ? 'Starting...' : 'Start attached smoke test'}
            </button>
            {currentAttachedRun && !['cancelled', 'completed', 'failed'].includes(currentAttachedRun.run.state) && (
              <button className="button button-secondary" type="button" disabled={stopAttached.isPending} onClick={() => stopAttached.mutate()}>
                <Square size={14} />Stop run
              </button>
            )}
          </div>
          {!attachedReady && <p className="hermes-query-note is-error"><Unplug size={13} />Attached execution is unavailable. Configure a compatible Hermes service and API key, then refresh.</p>}
          {(startAttached.error || attachedRun.error || stopAttached.error) && (
            <div className="hermes-status-error" role="alert"><Unplug size={16} /><span><b>Attached run failed</b>{(startAttached.error ?? attachedRun.error ?? stopAttached.error)?.message}</span></div>
          )}
          {currentAttachedRun && (
            <div className="hermes-smoke-result" aria-live="polite">
              <div><small>RUN ID</small><code>{currentAttachedRun.run.id}</code></div>
              <div><small>STATE</small><b>{currentAttachedRun.run.state.replaceAll('_', ' ')}</b></div>
              <div><small>TRUST</small><b>{currentAttachedRun.trust.replaceAll('_', ' ')}</b></div>
              {currentAttachedRun.run.usage && <div><small>TOKENS</small><b>{currentAttachedRun.run.usage.totalTokens}</b></div>}
              {currentAttachedRun.run.output && <pre>{currentAttachedRun.run.output}</pre>}
            </div>
          )}
        </section>
      )}

      {!adapter ? (
        <section className="panel solution-empty">
          <EmptyState
            title="No Hermes runtime adapter declared"
            description="The discovered Pack is healthy, but its manifest does not declare a Hermes execution adapter. Update the Pack contract and refresh discovery."
          />
        </section>
      ) : (
        <div className="hermes-runtime-layout">
          <section className="panel hermes-adapter-panel" aria-labelledby="hermes-adapter-title">
            <div className="panel-heading">
              <div><span className="eyebrow">DECLARED RUNTIME ADAPTER</span><h2 id="hermes-adapter-title">{adapter.id}</h2><p>The Pack publishes this bridge contract; it is distinct from an MCP Fabric bundle.</p></div>
              <HealthBadge state={adapterHealth(status?.state)} />
            </div>
            <dl className="hermes-adapter-facts">
              <div><dt>Runtime</dt><dd><code>{adapter.runtime}</code></dd></div>
              <div><dt>Protocol</dt><dd><code>{adapter.protocol}</code></dd></div>
              <div><dt>Bridge endpoint</dt><dd><code title={adapterEndpoint(pack.endpoint, adapter)}>{adapterEndpoint(pack.endpoint, adapter)}</code></dd></div>
              <div><dt>Last check</dt><dd>{status?.checkedAt ? timeAgo(status.checkedAt) : 'Not checked'}</dd></div>
            </dl>

            <div className="hermes-capability-section">
              <div><span>Modes</span><small>Execution modes declared by the Pack</small></div>
              <div className="hermes-chip-list">
                {declaredModes.map(mode => <code key={mode}>{mode}</code>)}
              </div>
            </div>
            <div className="hermes-capability-section">
              <div><span>{adapterCapabilities.data ? 'Verified capabilities' : 'Declared capabilities'}</span><small>{adapterCapabilities.data ? 'Confirmed by the Pack bridge' : 'Awaiting Pack capability handshake'}</small></div>
              <div className="hermes-chip-list">
                {confirmedCapabilities.length ? confirmedCapabilities.map(capability => <code key={capability}>{capability}</code>) : <span className="hermes-muted">No capabilities declared</span>}
              </div>
            </div>
            {adapterCapabilities.isLoading && <p className="hermes-query-note"><Clock3 className="spin" size={13} />Checking Pack capability contract…</p>}
            {adapterCapabilities.error && <p className="hermes-query-note is-error"><Unplug size={13} />Capability handshake unavailable: {adapterCapabilities.error.message}</p>}
          </section>

          <aside className="panel hermes-connection-panel" aria-labelledby="hermes-connection-title">
            <div className="panel-heading"><div><span className="eyebrow">CONNECTION READINESS</span><h2 id="hermes-connection-title">Attached and managed modes</h2></div></div>
            {adapterStatus.isLoading ? <LoadingState label="Checking Hermes runtime bridge…" /> : status ? (
              <>
                <div className="hermes-connection-summary">
                  <HealthBadge state={adapterHealth(status.state)} />
                  <div><b>{adapterStateLabel(status.state)}</b><small>Adapter-wide connection state</small></div>
                </div>
                <div className="hermes-mode-list">
                  {declaredModes.map(mode => {
                    const modeStatus = statusModes.get(mode);
                    return (
                      <article key={mode} className={`state-${modeStatus?.state ?? 'not_checked'}`}>
                        <span><CircleDot size={14} /></span>
                        <div><b>{mode}</b><small>{modeDetail(modeStatus?.state)}</small>{modeStatus?.detail && <p>{modeStatus.detail}</p>}</div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : adapterStatus.error ? (
              <div className="hermes-status-error" role="alert"><Unplug size={16} /><span><b>Adapter status unavailable</b>{adapterStatus.error.message}</span></div>
            ) : (
              <div className="hermes-status-error"><Clock3 size={16} /><span><b>Awaiting runtime check</b>The Pack must be ready before Argus can inspect the Hermes bridge.</span></div>
            )}
            <div className="hermes-connection-links">
              <a href="/build/agents/manage"><Bot size={13} />Assign a runtime in Agent Studio</a>
              <a href="/runs"><ExternalLink size={13} />Inspect governed runs</a>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

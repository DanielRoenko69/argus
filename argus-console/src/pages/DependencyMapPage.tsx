import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BellRing,
  Box,
  Boxes,
  Cable,
  CheckCircle2,
  Network,
  Radio,
  ServerCog,
  TriangleAlert,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { getNativeDependencyMap, getNativeServiceTopology, getOverview } from '../api';
import { isPlatformAdminRole } from '../access';
import { ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { ObserveWorkspaceTabs } from '../features/observe/ObserveWorkspaceTabs';
import type {
  NativeDependencyMapResponse,
  NativeDependencyNodeKind,
  NativeServiceTopologyNodeKind,
  NativeServiceTopologyResponse,
} from '../types';

const ranges = [1, 6, 24, 168] as const;
type EvidenceFilter = 'all' | 'configured' | 'observed';
type MapView = 'runtime' | 'services';

function rangeLabel(hours: number): string {
  return hours === 1 ? '1h' : hours === 168 ? '7d' : `${hours}h`;
}

function shortLabel(value: string): string {
  return value.length > 25 ? `${value.slice(0, 23)}…` : value;
}

const runtimeLayerOrder: NativeDependencyNodeKind[] = ['workflow', 'agent', 'model', 'knowledge', 'tool'];
const runtimeLayerLabels: Record<NativeDependencyNodeKind, string> = {
  workflow: 'WORKFLOWS', agent: 'AGENTS', model: 'MODELS', knowledge: 'KNOWLEDGE', tool: 'TOOLS',
};
const serviceLayerOrder: NativeServiceTopologyNodeKind[] = ['cluster', 'namespace', 'workload', 'service', 'dependency', 'alert'];
const serviceLayerLabels: Record<NativeServiceTopologyNodeKind, string> = {
  cluster: 'CLUSTERS', namespace: 'NAMESPACES', workload: 'WORKLOADS', service: 'SERVICES', dependency: 'DEPENDENCIES', alert: 'ALERTS',
};

function layoutLayers<TKind extends string, TNode extends { id: string; kind: TKind }>(
  nodes: TNode[],
  order: TKind[],
) {
  const groups = new Map(order.map(kind => [kind, nodes.filter(node => node.kind === kind)]));
  const maxRows = Math.max(1, ...order.map(kind => groups.get(kind)?.length ?? 0));
  const width = Math.max(1260, 20 + (order.length - 1) * 248 + 230);
  const height = Math.max(300, maxRows * 76 + 58);
  const positions = new Map<string, { x: number; y: number }>();
  order.forEach((kind, layerIndex) => {
    const group = groups.get(kind) ?? [];
    const contentHeight = group.length * 76;
    const offset = Math.max(46, 46 + (maxRows * 76 - contentHeight) / 2);
    group.forEach((node, index) => positions.set(node.id, { x: 20 + layerIndex * 248, y: offset + index * 76 }));
  });
  return { positions, width, height };
}

function ViewSwitch({ view, onChange }: { view: MapView; onChange: (view: MapView) => void }) {
  return <div className="dependency-view-switch" role="group" aria-label="Topology view">
    <button type="button" className={view === 'runtime' ? 'is-active' : ''} onClick={() => onChange('runtime')}>Agent runtime</button>
    <button type="button" className={view === 'services' ? 'is-active' : ''} onClick={() => onChange('services')}>Services &amp; infrastructure</button>
  </div>;
}

function ServiceTopologyView({
  data,
  selectedId,
  setSelectedId,
  switchView,
}: {
  data: NativeServiceTopologyResponse;
  selectedId: string | null;
  setSelectedId: (value: string | null) => void;
  switchView: (view: MapView) => void;
}) {
  const layout = layoutLayers(data.nodes, serviceLayerOrder);
  const selected = data.nodes.find(node => node.id === selectedId) ?? null;
  const connectedEdges = selected ? data.edges.filter(edge => edge.source === selected.id || edge.target === selected.id) : [];
  const nodeById = new Map(data.nodes.map(node => [node.id, node]));
  return <>
    <PageHeader
      eyebrow="OBSERVE · AIOPS TOPOLOGY"
      title="Dependency map"
      description="Map governed Kubernetes inventory to service identities, signal coverage and native alert state."
      actions={<ViewSwitch view="services" onChange={switchView} />}
    />
    <ObserveWorkspaceTabs active="health" section="dependencies" isAdmin />
    <section className="metric-grid dependency-metrics">
      <article className="metric-card"><span className="metric-icon violet"><Network size={17} /></span><div><span>Services</span><strong>{data.summary.services}</strong><small>{data.summary.traceServices} traced · {data.summary.logServices} logged</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><Boxes size={17} /></span><div><span>Runtime dependencies</span><strong>{data.summary.runtimeDependencies}</strong><small>{data.summary.clusters} clusters · {data.summary.namespaces} namespaces</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Cable size={17} /></span><div><span>Observed calls</span><strong>{data.summary.calls}</strong><small>{data.summary.failures} failed spans</small></div></article>
      <article className="metric-card"><span className={`metric-icon ${data.summary.firingAlerts ? 'red' : 'teal'}`}><BellRing size={17} /></span><div><span>Firing alerts</span><strong>{data.summary.firingAlerts}</strong><small>{data.summary.alerts} configured policies</small></div></article>
    </section>

    <div className="dependency-workspace">
      <section className="panel dependency-map-panel">
        <div className="panel-heading"><div><span className="eyebrow">SERVICE GRAPH</span><h2>Infrastructure and signal coverage</h2></div><small>Updated {timeAgo(data.generatedAt)}</small></div>
        <div className="dependency-toolbar">
          <div className="service-topology-boundary"><CheckCircle2 size={13} />Current governed evidence only</div>
          <div className="dependency-legend"><span><i className="edge-configured" />Configured alert</span><span><i className="edge-observed" />Discovered relation</span><span><i className="node-problem" />Firing</span></div>
        </div>
        <div className="dependency-canvas">
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Argus service and infrastructure topology graph">
            <defs><marker id="service-topology-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>
            {serviceLayerOrder.map((kind, index) => <text className="dependency-layer-label" x={24 + index * 248} y={22} key={kind}>{serviceLayerLabels[kind]}</text>)}
            <g className="dependency-edges">{data.edges.map(edge => {
              const from = layout.positions.get(edge.source);
              const to = layout.positions.get(edge.target);
              if (!from || !to) return null;
              const startX = from.x + 210;
              const startY = from.y + 25;
              const endX = to.x;
              const endY = to.y + 25;
              const bend = Math.max(35, (endX - startX) / 2);
              return <path className={`dependency-edge evidence-${edge.evidence} ${edge.current ? '' : 'is-stale'} ${edge.failures ? 'has-failures' : ''}`} d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`} markerEnd="url(#service-topology-arrow)" key={edge.id}><title>{edge.relation} · {edge.evidence}{edge.calls ? ` · ${edge.calls} calls` : ''}{edge.failures ? ` · ${edge.failures} failed` : ''}</title></path>;
            })}</g>
            <g className="dependency-nodes">{data.nodes.map(node => {
              const position = layout.positions.get(node.id);
              if (!position) return null;
              return <g className={`dependency-node kind-${node.kind} state-${node.state} ${node.current ? '' : 'is-stale'} ${selected?.id === node.id ? 'is-selected' : ''}`} role="button" tabIndex={0} aria-label={`${node.kind} ${node.name}`} transform={`translate(${position.x} ${position.y})`} key={node.id} onClick={() => setSelectedId(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id); }}>
                <rect width="210" height="50" rx="8" />
                <circle cx="15" cy="15" r="4" />
                <text className="dependency-node-kind" x="27" y="18">{node.kind}</text>
                <text className="dependency-node-name" x="12" y="37">{shortLabel(node.name)}</text>
                {(node.events > 0 || node.calls > 0) && <text className="dependency-node-calls" x="198" y="18" textAnchor="end">{node.events || node.calls}</text>}
                <title>{node.name} · {node.detail} · {node.signals.join(', ') || 'no signals'}</title>
              </g>;
            })}</g>
          </svg>
        </div>
      </section>

      <aside className="panel dependency-inspector">
        <div className="panel-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{selected ? 'Topology detail' : 'Map guide'}</h2></div>{selected && <button className="icon-button" type="button" aria-label="Close inspector" onClick={() => setSelectedId(null)}>×</button>}</div>
        {selected ? <>
          <div className={`dependency-selected state-${selected.state}`}><span><ServerCog size={18} /></span><div><small>{selected.kind}</small><h3>{selected.name}</h3><p>{selected.detail}</p></div></div>
          <dl className="dependency-selected-stats"><div><dt>State</dt><dd>{selected.state.replace('_', ' ')}</dd></div><div><dt>Environment</dt><dd>{selected.environment ?? '—'}</dd></div><div><dt>Evidence</dt><dd>{selected.evidenceCount}</dd></div><div><dt>Open events</dt><dd>{selected.events}</dd></div><div><dt>Calls</dt><dd>{selected.calls}</dd></div><div><dt>Failures</dt><dd>{selected.failures}</dd></div></dl>
          <div className="service-topology-signals" aria-label="Signal coverage">{selected.signals.length ? selected.signals.map(signal => <span key={signal}>{signal}</span>) : <small>No correlated signals yet</small>}</div>
          <div className="dependency-connection-list">{connectedEdges.length > 0 ? connectedEdges.map(edge => {
            const outbound = edge.source === selected.id;
            const other = nodeById.get(outbound ? edge.target : edge.source);
            return <div key={edge.id}><span className={`evidence-dot evidence-${edge.evidence}`}><Radio size={12} /></span><div><b>{outbound ? edge.relation.replace('_', ' ') : `from ${other?.kind ?? 'component'}`}</b><small>{other?.name ?? 'Unknown'} · {edge.evidence}{edge.calls ? ` · ${edge.calls} calls` : ''}{edge.failures ? ` · ${edge.failures} failed` : ''}{edge.p95DurationMs != null ? ` · p95 ${edge.p95DurationMs} ms` : ''}</small></div></div>;
          }) : <div className="observe-mini-empty">No visible dependencies.</div>}</div>
        </> : <div className="dependency-guide">
          <Network size={26} /><h3>Select a service component</h3><p>Inspect its exact environment, signal coverage and evidence-backed relations.</p>
          <ul><li><CheckCircle2 size={12} />Kubernetes edges come from the certified read-only MCP boundary.</li><li><Radio size={12} />Trace and log badges show provider-owned signal presence.</li><li><TriangleAlert size={12} />Alert state is inherited only from configured native policies.</li></ul>
        </div>}
      </aside>
    </div>
  </>;
}

export function DependencyMapPage() {
  const [hours, setHours] = useState<(typeof ranges)[number]>(24);
  const [evidence, setEvidence] = useState<EvidenceFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const view: MapView = searchParams.get('view') === 'services' ? 'services' : 'runtime';
  const setView = (next: MapView) => {
    setSelectedId(null);
    setSearchParams(current => {
      const updated = new URLSearchParams(current);
      if (next === 'services') updated.set('view', 'services');
      else updated.delete('view');
      return updated;
    });
  };
  const overview = useQuery({ queryKey: ['overview'], queryFn: getOverview });
  const dependencies = useQuery({
    queryKey: ['native-dependencies', hours],
    queryFn: () => getNativeDependencyMap(hours),
    refetchInterval: 30_000,
    enabled: view === 'runtime',
  });
  const topology = useQuery({
    queryKey: ['native-service-topology'],
    queryFn: getNativeServiceTopology,
    refetchInterval: 30_000,
    enabled: view === 'services',
  });
  const layout = useMemo(() => dependencies.data
    ? layoutLayers(dependencies.data.nodes, runtimeLayerOrder)
    : null, [dependencies.data]);

  if (overview.isLoading || (view === 'runtime' ? dependencies.isLoading : topology.isLoading)) return <LoadingState label="Building evidence-backed topology…" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  const isAdmin = isPlatformAdminRole(overview.data?.user.role);
  if (!isAdmin) return <div className="state-panel state-error" role="alert"><TriangleAlert size={22} /><div><b>Platform administrator access required</b><span>The dependency map exposes cross-platform runtime topology.</span></div></div>;
  if (view === 'services') {
    if (topology.error) return <ErrorState error={topology.error} />;
    return topology.data ? <ServiceTopologyView data={topology.data} selectedId={selectedId} setSelectedId={setSelectedId} switchView={setView} /> : null;
  }
  if (dependencies.error) return <ErrorState error={dependencies.error} />;
  if (!dependencies.data || !layout) return null;
  const data: NativeDependencyMapResponse = dependencies.data;
  const visibleEdges = data.edges.filter(edge => evidence === 'all' || edge.evidence === evidence || edge.evidence === 'both');
  const selected = data.nodes.find(node => node.id === selectedId) ?? null;
  const connectedEdges = selected ? data.edges.filter(edge => edge.source === selected.id || edge.target === selected.id) : [];
  const nodeById = new Map(data.nodes.map(node => [node.id, node]));

  return <>
    <PageHeader eyebrow="OBSERVE · TOPOLOGY" title="Dependency map" description="See what Argus is configured to use and what agents and workflows actually called at runtime." actions={<div className="dependency-header-actions"><ViewSwitch view="runtime" onChange={setView} /><div className="observe-range" aria-label="Dependency map time range">{ranges.map(value => <button type="button" className={hours === value ? 'is-active' : ''} key={value} onClick={() => setHours(value)}>{rangeLabel(value)}</button>)}</div></div>} />
    <ObserveWorkspaceTabs active="health" section="dependencies" isAdmin={isAdmin} />
    <section className="metric-grid dependency-metrics">
      <article className="metric-card"><span className="metric-icon violet"><Network size={17} /></span><div><span>Components</span><strong>{data.summary.nodes}</strong><small>across five layers</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><Cable size={17} /></span><div><span>Dependencies</span><strong>{data.summary.edges}</strong><small>deduplicated edges</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Box size={17} /></span><div><span>Configured</span><strong>{data.summary.configuredEdges}</strong><small>architecture evidence</small></div></article>
      <article className="metric-card"><span className={`metric-icon ${data.summary.unhealthyNodes ? 'red' : 'teal'}`}><Activity size={17} /></span><div><span>Needs attention</span><strong>{data.summary.unhealthyNodes}</strong><small>degraded components</small></div></article>
    </section>

    <div className="dependency-workspace">
      <section className="panel dependency-map-panel">
        <div className="panel-heading"><div><span className="eyebrow">RUNTIME GRAPH</span><h2>Architecture and observed calls</h2></div><small>Updated {timeAgo(data.generatedAt)}</small></div>
        <div className="dependency-toolbar">
          <div role="group" aria-label="Dependency evidence">{(['all', 'configured', 'observed'] as const).map(value => <button type="button" className={evidence === value ? 'is-active' : ''} key={value} onClick={() => setEvidence(value)}>{value}</button>)}</div>
          <div className="dependency-legend"><span><i className="edge-configured" />Configured</span><span><i className="edge-observed" />Observed</span><span><i className="node-problem" />Degraded</span></div>
        </div>
        <div className="dependency-canvas">
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="Argus runtime dependency graph">
            <defs><marker id="dependency-arrow" markerHeight="7" markerWidth="7" orient="auto" refX="6" refY="3.5"><path d="M0,0 L7,3.5 L0,7 z" /></marker></defs>
            {runtimeLayerOrder.map((kind, index) => <text className="dependency-layer-label" x={24 + index * 248} y={22} key={kind}>{runtimeLayerLabels[kind]}</text>)}
            <g className="dependency-edges">{visibleEdges.map(edge => {
              const from = layout.positions.get(edge.source);
              const to = layout.positions.get(edge.target);
              if (!from || !to) return null;
              const startX = from.x + 210;
              const startY = from.y + 25;
              const endX = to.x;
              const endY = to.y + 25;
              const bend = Math.max(35, (endX - startX) / 2);
              return <path className={`dependency-edge evidence-${edge.evidence} ${edge.failures ? 'has-failures' : ''}`} d={`M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`} markerEnd="url(#dependency-arrow)" key={edge.id}><title>{edge.relation} · {edge.evidence}{edge.calls ? ` · ${edge.calls} calls` : ''}</title></path>;
            })}</g>
            <g className="dependency-nodes">{data.nodes.map(node => {
              const position = layout.positions.get(node.id);
              if (!position) return null;
              return <g className={`dependency-node kind-${node.kind} state-${node.state} ${selected?.id === node.id ? 'is-selected' : ''}`} role="button" tabIndex={0} aria-label={`${node.kind} ${node.name}`} transform={`translate(${position.x} ${position.y})`} key={node.id} onClick={() => setSelectedId(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') setSelectedId(node.id); }}>
                <rect width="210" height="50" rx="8" />
                <circle cx="15" cy="15" r="4" />
                <text className="dependency-node-kind" x="27" y="18">{node.kind}</text>
                <text className="dependency-node-name" x="12" y="37">{shortLabel(node.name)}</text>
                {node.calls > 0 && <text className="dependency-node-calls" x="198" y="18" textAnchor="end">{node.calls}</text>}
                <title>{node.name} · {node.detail} · {node.state}</title>
              </g>;
            })}</g>
          </svg>
        </div>
      </section>

      <aside className="panel dependency-inspector">
        <div className="panel-heading"><div><span className="eyebrow">INSPECTOR</span><h2>{selected ? 'Component detail' : 'Map guide'}</h2></div>{selected && <button className="icon-button" type="button" aria-label="Close inspector" onClick={() => setSelectedId(null)}>×</button>}</div>
        {selected ? <>
          <div className={`dependency-selected state-${selected.state}`}><span><ServerCog size={18} /></span><div><small>{selected.kind}</small><h3>{selected.name}</h3><p>{selected.detail}</p></div></div>
          <dl className="dependency-selected-stats"><div><dt>Health</dt><dd>{selected.state.replace('_', ' ')}</dd></div><div><dt>Observed calls</dt><dd>{selected.calls}</dd></div><div><dt>Failures</dt><dd>{selected.failures}</dd></div><div><dt>Dependencies</dt><dd>{connectedEdges.length}</dd></div></dl>
          <div className="dependency-connection-list">{connectedEdges.length > 0 ? connectedEdges.map(edge => {
            const outbound = edge.source === selected.id;
            const other = nodeById.get(outbound ? edge.target : edge.source);
            return <div key={edge.id}><span className={`evidence-dot evidence-${edge.evidence}`}><Radio size={12} /></span><div><b>{outbound ? edge.relation : `used by ${other?.kind ?? 'component'}`}</b><small>{other?.name ?? 'Unknown'} · {edge.evidence}{edge.calls ? ` · ${edge.calls} calls` : ''}</small></div></div>;
          }) : <div className="observe-mini-empty">No visible dependencies.</div>}</div>
        </> : <div className="dependency-guide">
          <Network size={26} /><h3>Select a component</h3><p>Inspect its health, incoming dependencies and observed call volume.</p>
          <ul><li><CheckCircle2 size={12} />Solid edges come from stored Argus configuration.</li><li><Radio size={12} />Dashed edges are backed by native runtime spans.</li><li><TriangleAlert size={12} />Red nodes inherit degraded or critical health.</li></ul>
        </div>}
      </aside>
    </div>
  </>;
}

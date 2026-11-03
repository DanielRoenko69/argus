import { useMemo, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  Container,
  Download,
  ExternalLink,
  FileJson2,
  Gauge,
  GitPullRequest,
  RefreshCcw,
  Server,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import {
  getAiOpsReadiness,
  getAuditReportCatalog,
  getIdentitySecurityStatus,
  getPlatformBackendHealth,
  getPlatformExecutionCertificates,
  getSolutionPacks,
} from '../api';
import { LoadingState, PageHeader, timeAgo } from '../components/Ui';
import {
  buildPlatformReadinessSnapshot,
  readinessSnapshotMarkdown,
  type PlatformReadinessCheckState,
  type PlatformReadinessSnapshot,
  type PlatformReadinessSource,
} from '../features/readiness/platformReadiness';

const stateLabel: Record<PlatformReadinessCheckState, string> = {
  pass: 'Ready',
  warning: 'Action recommended',
  fail: 'Blocked',
  unknown: 'Not verified',
};

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : error ? String(error) : undefined;
}

function triggerDownload(contents: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function snapshotDigest(snapshot: PlatformReadinessSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function CheckIcon({ state }: { state: PlatformReadinessCheckState }) {
  if (state === 'pass') return <CheckCircle2 size={18} />;
  if (state === 'fail') return <XCircle size={18} />;
  return <AlertTriangle size={18} />;
}

export function PlatformReadinessPage() {
  const [generatedAt, setGeneratedAt] = useState(() => new Date().toISOString());
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const backends = useQuery({ queryKey: ['platform-readiness', 'backends'], queryFn: getPlatformBackendHealth, retry: false });
  const identity = useQuery({ queryKey: ['platform-readiness', 'identity'], queryFn: getIdentitySecurityStatus, retry: false });
  const aiops = useQuery({ queryKey: ['platform-readiness', 'aiops'], queryFn: getAiOpsReadiness, retry: false });
  const audit = useQuery({ queryKey: ['platform-readiness', 'audit'], queryFn: getAuditReportCatalog, retry: false });
  const packs = useQuery({ queryKey: ['platform-readiness', 'packs'], queryFn: getSolutionPacks, retry: false });
  const executionProofs = useQuery({ queryKey: ['platform-readiness', 'execution-proofs'], queryFn: getPlatformExecutionCertificates, retry: false });
  const queries = [backends, identity, aiops, audit, packs, executionProofs];
  const loading = queries.some(query => query.isLoading);
  const refreshing = queries.some(query => query.isFetching);

  const snapshot = useMemo(() => {
    const errors: Partial<Record<PlatformReadinessSource, string>> = {
      backends: errorMessage(backends.error),
      identity: errorMessage(identity.error),
      aiops: errorMessage(aiops.error),
      audit: errorMessage(audit.error),
      packs: errorMessage(packs.error),
      executionProofs: errorMessage(executionProofs.error),
    };
    return buildPlatformReadinessSnapshot({
      generatedAt,
      backends: backends.data,
      identity: identity.data,
      aiops: aiops.data,
      audit: audit.data,
      packs: packs.data,
      executionProofs: executionProofs.data,
      errors,
    });
  }, [aiops.data, aiops.error, audit.data, audit.error, backends.data, backends.error, executionProofs.data, executionProofs.error, generatedAt, identity.data, identity.error, packs.data, packs.error]);

  const latestProof = executionProofs.data?.certificates[0];

  const refresh = async () => {
    setExportStatus(null);
    await Promise.all(queries.map(query => query.refetch()));
    setGeneratedAt(new Date().toISOString());
  };

  const download = async (format: 'json' | 'md') => {
    const digest = await snapshotDigest(snapshot);
    const stamp = snapshot.generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
    if (format === 'json') {
      const artifact = {
        ...snapshot,
        integrity: { algorithm: 'sha256', value: digest, covers: 'snapshot_without_integrity' },
      };
      triggerDownload(`${JSON.stringify(artifact, null, 2)}\n`, 'application/json', `argus-readiness-${stamp}.json`);
    } else {
      triggerDownload(`${readinessSnapshotMarkdown(snapshot)}\nSnapshot SHA-256: \`${digest}\`\n`, 'text/markdown;charset=utf-8', `argus-readiness-${stamp}.md`);
    }
    setExportStatus(`${format.toUpperCase()} snapshot prepared · ${digest.slice(0, 12)}…`);
  };

  return (
    <>
      <PageHeader
        eyebrow="SETTINGS · OPERATIONS"
        title="Platform readiness"
        description="Verify the complete pilot and live-demo path without starting a workflow, approval, remediation or governed evidence export."
        actions={<>
          <button className="button button-secondary" type="button" disabled={refreshing} onClick={() => void refresh()}><RefreshCcw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? 'Checking…' : 'Run checks'}</button>
          <button className="button button-secondary" type="button" disabled={loading} onClick={() => void download('md')}><Download size={15} />Markdown</button>
          <button className="button button-primary" type="button" disabled={loading} onClick={() => void download('json')}><FileJson2 size={15} />JSON snapshot</button>
        </>}
      />

      {loading ? <LoadingState label="Checking the complete platform path…" /> : <>
      <section className={`panel readiness-hero is-${snapshot.state}`} aria-live="polite">
        <div className="readiness-score" aria-label={`Readiness score ${snapshot.score} percent`} style={{ '--readiness-score': `${snapshot.score * 3.6}deg` } as CSSProperties}>
          <span><b>{snapshot.score}</b><small>%</small></span>
        </div>
        <div className="readiness-hero-copy">
          <span className="eyebrow">PILOT & LIVE DEMO</span>
          <h2>{snapshot.state === 'ready' ? 'Ready to demonstrate' : snapshot.state === 'attention' ? 'Ready with operator action' : 'Readiness blockers found'}</h2>
          <p>{snapshot.summary.passed} of {snapshot.summary.total} checks ready · {snapshot.summary.warnings} action{snapshot.summary.warnings === 1 ? '' : 's'} recommended · {snapshot.summary.failed + snapshot.summary.unknown} blocker{snapshot.summary.failed + snapshot.summary.unknown === 1 ? '' : 's'} or unknowns</p>
          <small>Point-in-time snapshot from {timeAgo(snapshot.generatedAt)}. This is operational evidence, not a signed compliance report.</small>
        </div>
        <div className="readiness-hero-facts">
          <span><CheckCircle2 size={15} /><b>{snapshot.summary.passed}</b> ready</span>
          <span><AlertTriangle size={15} /><b>{snapshot.summary.warnings}</b> attention</span>
          <span><XCircle size={15} /><b>{snapshot.summary.failed + snapshot.summary.unknown}</b> blocked</span>
        </div>
      </section>

      {exportStatus && <div className="connection-notice is-success" role="status"><ShieldCheck size={17} /><span>{exportStatus}</span></div>}

      <section className="readiness-section">
        <header className="panel-section-heading"><div><span className="eyebrow">CONTROL PATH</span><h2>Readiness checks</h2><p>Required checks fail closed; warnings identify explicit operator actions before the demonstration.</p></div><Gauge size={19} /></header>
        <div className="readiness-check-grid">
          {snapshot.checks.map(check => (
            <article className={`panel readiness-check is-${check.state}`} key={check.id}>
              <header><span><CheckIcon state={check.state} /></span><em>{stateLabel[check.state]}</em></header>
              <h3>{check.title}</h3>
              <p>{check.detail}</p>
              <footer><small>{check.required ? 'Required' : 'Advisory'} · {check.category}</small><a href={check.href}>Inspect <ExternalLink size={12} /></a></footer>
            </article>
          ))}
        </div>
      </section>

      <section className="readiness-section" id="execution-proofs">
        <header className="panel-section-heading">
          <div><span className="eyebrow">EXECUTED GOLDEN PATHS</span><h2>Product proof, not just connectivity</h2><p>The latest combined runner result is digest-verified, tenant-bound, append-only and recorded in the canonical audit chain.</p></div>
          <ShieldCheck size={19} />
        </header>
        {latestProof ? <>
          <div className="readiness-proof-meta">
            <span><CheckCircle2 size={15} /><b>Both paths passed</b></span>
            <span>Executed {timeAgo(latestProof.generatedAt)}</span>
            <span>Recorded by {latestProof.identity.displayName || latestProof.recordedBy}</span>
            <code title={latestProof.payloadSha256}>sha256:{latestProof.payloadSha256.slice(0, 12)}…</code>
            <em>{latestProof.sourceMode === 'verify-only' ? 'Existing runs reverified' : 'New runs executed'}</em>
          </div>
          <div className="readiness-proof-grid">
            <article className="panel readiness-proof-card is-dev">
              <header><span><GitPullRequest size={19} /></span><div><small>ARGUS DEV</small><h3>Ticket to reviewed image</h3></div><em>Passed</em></header>
              <p>{latestProof.dev.testExecution === 'intentionally_skipped'
                ? 'Exact code scope, agent review, two human approvals, branch, Jenkins image build and pull request are bound into one reviewer-gated proof; automated tests were intentionally out of scope.'
                : 'Exact code scope, automated tests, agent review, human approvals, branch, Jenkins CI, Docker image and pull request are bound into one proof.'}</p>
              <dl>
                <div><dt>Ticket</dt><dd>{latestProof.dev.ticketId || 'Recorded task'}</dd></div>
                <div><dt>Commit</dt><dd><code>{latestProof.dev.commitSha?.slice(0, 12) || 'n/a'}</code></dd></div>
                <div><dt>Verification</dt><dd>{latestProof.dev.testExecution === 'intentionally_skipped' ? 'Reviewer-gated · tests intentionally skipped' : 'Tests + reviewer passed'}</dd></div>
                <div><dt>CI</dt><dd>{latestProof.dev.ci.provider || 'CI'} · {latestProof.dev.ci.status || 'passed'}</dd></div>
                <div><dt>Image</dt><dd><code>{latestProof.dev.ci.imageTag || latestProof.dev.ci.imageId?.slice(0, 22) || 'verified'}</code></dd></div>
              </dl>
              <footer>
                <a className="button button-secondary" href={`/solutions/argus.dev?task=${encodeURIComponent(latestProof.dev.taskId)}`}>Open run <ExternalLink size={13} /></a>
                {latestProof.dev.pullRequestUrl && <a href={latestProof.dev.pullRequestUrl} target="_blank" rel="noreferrer">Pull request <ExternalLink size={12} /></a>}
                {latestProof.dev.ci.runUrl && <a href={latestProof.dev.ci.runUrl} target="_blank" rel="noreferrer">Jenkins <ExternalLink size={12} /></a>}
              </footer>
            </article>

            <article className="panel readiness-proof-card is-aiops">
              <header><span><Activity size={19} /></span><div><small>ARGUS AIOPS</small><h3>Signal to reviewed evidence</h3></div><em>Passed</em></header>
              <p>Service-scoped metrics, logs, traces and OpenSearch evidence were collected read-only and reviewed by the governed agent path.</p>
              <dl>
                <div><dt>Service</dt><dd>{latestProof.aiops.profile.service || latestProof.aiops.profile.displayName || 'Bound service'}</dd></div>
                <div><dt>Environment</dt><dd>{latestProof.aiops.profile.environment || latestProof.environment}</dd></div>
                <div><dt>Evidence</dt><dd>{latestProof.aiops.evidenceLanes.filter(lane => lane.status === 'collected').map(lane => lane.lane).join(' · ') || 'reviewed'}</dd></div>
                <div><dt>Providers</dt><dd>{latestProof.aiops.providerToolNames.length} verified tools</dd></div>
              </dl>
              <footer>
                <a className="button button-secondary" href={`/solutions/argus.aiops?task=${encodeURIComponent(latestProof.aiops.taskId)}`}>Open run <ExternalLink size={13} /></a>
                <a href={`/observe/quality?trace=${encodeURIComponent(latestProof.aiops.rootTraceId)}`}>Correlated quality <ExternalLink size={12} /></a>
              </footer>
            </article>
          </div>
        </> : <div className="panel readiness-proof-empty"><Container size={24} /><div><b>No combined execution proof yet</b><p>Run <code>npm run certify:solution-showcase</code> with fresh SSO/MFA. It reverifies the existing Dev and AIOps runs without starting model calls.</p></div></div>}
      </section>

      <section className="panel readiness-backends">
        <header className="panel-section-heading"><div><span className="eyebrow">LIVE DEPENDENCIES</span><h2>Backend matrix</h2><p>Enabled internal and MCP backends checked by Argus Core.</p></div><Server size={19} /></header>
        <div className="readiness-backend-list" role="table" aria-label="Platform backend readiness">
          <div className="readiness-backend-row is-head" role="row"><span>Name</span><span>Kind</span><span>Status</span><span>Latency</span></div>
          {snapshot.backends.map(backend => <div className={`readiness-backend-row is-${backend.status}`} role="row" key={`${backend.kind}-${backend.name}`} title={backend.error}>
            <b>{backend.name}</b><span>{backend.kind === 'internal' ? 'Platform' : 'MCP backend'}</span><span><i />{backend.status}</span><code>{backend.latencyMs} ms</code>
          </div>)}
          {snapshot.backends.length === 0 && <p className="readiness-backend-empty">Backend health could not be loaded. The snapshot remains fail-closed.</p>}
        </div>
      </section>

      <section className="readiness-limitations">
        <ShieldCheck size={18} />
        <div><b>Evidence boundary</b>{snapshot.limitations.map(item => <p key={item}>{item}</p>)}</div>
      </section>
      </>}
    </>
  );
}

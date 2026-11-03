import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BadgeCheck, Ban, CheckCircle2, Clock3, Download, FileClock, GitCommitHorizontal, LockKeyhole, RefreshCcw, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { archiveAuditRetentionPlan, auditRetentionVerifierUrl, createAuditRetentionPlan, decideAuditRetentionPlan, getAuditRetentionPlans, runAuditRetentionRestoreDrill, sealAuditRetentionChainSegment } from '../api';
import { EmptyState, ErrorState, LoadingState, timeAgo } from './Ui';

const label = (value: string) => value.replaceAll('_', ' ');

export function AuditRetentionPanel() {
  const client = useQueryClient();
  const [environment, setEnvironment] = useState('production');
  const [batchLimit, setBatchLimit] = useState(500);
  const [justification, setJustification] = useState('Independently reviewed against retention policy, legal holds and archive requirements.');
  const catalog = useQuery({ queryKey: ['audit-retention-plans', environment], queryFn: () => getAuditRetentionPlans(environment), retry: false });
  const refresh = () => client.invalidateQueries({ queryKey: ['audit-retention-plans', environment] });
  const create = useMutation({ mutationFn: () => createAuditRetentionPlan(environment, batchLimit), onSuccess: refresh });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => decideAuditRetentionPlan(id, environment, decision, justification),
    onSuccess: refresh,
  });
  const archivePlan = useMutation({
    mutationFn: (id: string) => archiveAuditRetentionPlan(id, environment, justification),
    onSuccess: refresh,
  });
  const restoreDrill = useMutation({
    mutationFn: (archiveId: string) => runAuditRetentionRestoreDrill(archiveId, environment, justification),
    onSuccess: refresh,
  });
  const sealSegment = useMutation({
    mutationFn: (archiveId: string) => sealAuditRetentionChainSegment(archiveId, environment, justification),
    onSuccess: refresh,
  });
  if (catalog.isLoading) return <LoadingState label="Loading retention safety state…" />;
  if (catalog.error || !catalog.data) return <ErrorState error={catalog.error ?? new Error('Retention lifecycle unavailable')} />;
  const { readiness, plans } = catalog.data;
  const operationSecurity = catalog.data.operationSecurity ?? {
    requiresFreshMfa: true, satisfied: false, maxAgeSeconds: 600,
    stepUpUrl: '/auth/oidc/step-up?returnTo=%2Fobserve%2Faudit%3Ftab%3Dretention',
  };
  const withFreshMfa = (action: () => void) => {
    if (operationSecurity.requiresFreshMfa && !operationSecurity.satisfied) {
      window.location.assign(operationSecurity.stepUpUrl);
      return;
    }
    action();
  };
  return <>
    <section className="panel retention-readiness">
      <div><span className="eyebrow">ARCHIVE-FIRST RETENTION</span><h2>Physical purge is fail-closed</h2><p>Argus evaluates only a contiguous, signed audit-chain prefix. Active Legal Holds, indefinite retention and unexpired events stop the plan immediately.</p></div>
      <div className="retention-gates">
        <span className={readiness.signerConfigured ? 'is-ready' : 'is-warning'}><BadgeCheck size={15} /><b>{readiness.signerConfigured ? 'Signed checkpoint' : 'Signer missing'}</b></span>
        <span className="is-ready"><ShieldAlert size={15} /><b>Four-eyes required</b></span>
        <span className={readiness.externalArchiveConfigured ? 'is-ready' : 'is-warning'}><Archive size={15} /><b>{readiness.externalArchiveConfigured ? `${readiness.externalArchiveProvider} ready` : 'External archive missing'}</b></span>
        <span className="is-blocked"><Ban size={15} /><b>Deletion disabled</b></span>
      </div>
    </section>
    <section className="panel retention-controls">
      <div><label><span>Environment</span><input value={environment} onChange={event => setEnvironment(event.target.value)} /></label><label><span>Maximum prefix events</span><input type="number" min={1} max={5000} value={batchLimit} onChange={event => setBatchLimit(Number(event.target.value))} /></label></div>
      <div className="retention-control-actions"><a className="button button-secondary" href={auditRetentionVerifierUrl} download="argus-audit-retention-verifier.mjs"><Download size={15} />Offline verifier</a><button className="button button-primary" type="button" disabled={!readiness.signerConfigured || create.isPending} onClick={() => withFreshMfa(() => create.mutate())}><FileClock size={15} />{create.isPending ? 'Evaluating…' : operationSecurity.satisfied ? 'Create signed dry-run' : 'Confirm MFA to plan'}</button></div>
    </section>
    <div className="retention-verifier-note"><ShieldCheck size={15} /><span><b>Independent verifier contract</b> Runs on Node.js 20+ without Argus, dependencies or network access. Verify the WORM package, receipt and provider public key on an isolated auditor workstation.</span></div>
    {(create.error || decide.error || archivePlan.error || restoreDrill.error || sealSegment.error) && <div className="state-panel state-error"><TriangleAlert size={17} /><span>{String((create.error ?? decide.error ?? archivePlan.error ?? restoreDrill.error ?? sealSegment.error) as Error)}</span></div>}
    <section className="panel retention-plan-panel">
      <header className="panel-section-heading"><div><span className="eyebrow">IMMUTABLE PLANS</span><h2>Retention lifecycle</h2></div><small>{plans.length} recorded</small></header>
      {plans.length === 0 ? <EmptyState title="No retention plans yet" description="Create a signed dry-run. It records eligibility and blockers without deleting or modifying evidence." /> : <div className="retention-plan-list">{plans.map(plan => <article key={plan.planId}>
        <header><div><span className={`audit-chip retention-${plan.status}`}>{label(plan.status)}</span><b>{plan.eligiblePrefixCount} eligible prefix event{plan.eligiblePrefixCount === 1 ? '' : 's'}</b><small>{timeAgo(plan.createdAt)} · requester {plan.requestedById}</small></div><code title={plan.manifestSha256}>{plan.manifestSha256.slice(0, 12)}…</code></header>
        <div className="retention-plan-facts"><span><b>{plan.firstSequence == null ? '—' : `#${plan.firstSequence}–#${plan.lastSequence}`}</b>chain range</span><span><b>{label(plan.blocker.code)}</b>{plan.blocker.sequence ? `at #${plan.blocker.sequence}` : 'boundary'}</span><span><b>#{plan.throughSequence}</b>signed checkpoint</span><span><b>No</b>purge permission</span></div>
        {plan.status === 'planned' && plan.eligiblePrefixCount > 0 && <footer><label><span>Independent review justification</span><input value={justification} onChange={event => setJustification(event.target.value)} /></label><div><button className="button button-secondary" type="button" disabled={decide.isPending} onClick={() => withFreshMfa(() => decide.mutate({ id: plan.planId, decision: 'rejected' }))}>Reject</button><button className="button button-primary" type="button" disabled={decide.isPending} onClick={() => withFreshMfa(() => decide.mutate({ id: plan.planId, decision: 'approved' }))}><CheckCircle2 size={14} />Approve for archive</button></div></footer>}
        {plan.status === 'approved' && <div className="retention-next-action"><p className="retention-next"><Clock3 size={14} />Approved for archival only. The source chain is revalidated before upload.</p>{readiness.externalArchiveConfigured ? <button className="button button-primary" type="button" disabled={archivePlan.isPending} onClick={() => withFreshMfa(() => archivePlan.mutate(plan.planId))}><LockKeyhole size={14} />{archivePlan.isPending && archivePlan.variables === plan.planId ? 'Archiving & verifying…' : 'Archive to WORM & verify'}</button> : <small>Configure a signed WORM provider to continue. Purge remains disabled.</small>}</div>}
        {plan.status === 'archive_verified' && plan.archive && <div className="retention-archive-stack"><div className="retention-archive-proof"><LockKeyhole size={16} /><div><b>External WORM archive verified</b><small>{plan.archive.provider} · {plan.archive.eventCount} events · retained until {new Date(plan.archive.retentionUntil).toLocaleDateString()}</small><code title={plan.archive.packageSha256}>{plan.archive.packageSha256.slice(0, 16)}…</code></div><span>Purge disabled</span></div><div className="retention-restore-action">{(plan.archive.restoreDrills ?? [])[0] ? <div className="retention-restore-proof"><ShieldCheck size={16} /><div><b>Full restore verified</b><small>{timeAgo(plan.archive.restoreDrills[0]!.verifiedAt)} · {plan.archive.restoreDrills[0]!.eventCount} events · {plan.archive.restoreDrills[0]!.durationMs} ms</small></div></div> : <p><RefreshCcw size={14} />No independent download verification recorded yet.</p>}{readiness.restoreDrillConfigured ? <button className="button button-secondary" type="button" disabled={restoreDrill.isPending} onClick={() => withFreshMfa(() => restoreDrill.mutate(plan.archive!.archiveId))}><RefreshCcw size={14} />{restoreDrill.isPending && restoreDrill.variables === plan.archive.archiveId ? 'Downloading & verifying…' : 'Run restore verification'}</button> : <small>Provider retrieval contract is not configured.</small>}</div>{plan.archive.segment ? <div className="retention-segment-proof"><GitCommitHorizontal size={17} /><div><b>Canonical chain segment #{plan.archive.segment.segmentOrdinal} sealed</b><small>#{plan.archive.segment.firstSequence}–#{plan.archive.segment.lastSequence} · next #{plan.archive.segment.continuationSequence} anchors to the sealed terminal hash</small><code title={plan.archive.segment.segmentDigest}>{plan.archive.segment.segmentDigest.slice(0, 16)}…</code></div><span>No purge grant</span></div> : (plan.archive.restoreDrills ?? [])[0] ? <div className="retention-segment-action"><div><b>Seal the verified chain boundary</b><small>Creates an immutable continuation anchor. It does not delete evidence or authorize purge.</small></div><button className="button button-secondary" type="button" disabled={sealSegment.isPending} onClick={() => withFreshMfa(() => sealSegment.mutate(plan.archive!.archiveId))}><GitCommitHorizontal size={14} />{sealSegment.isPending && sealSegment.variables === plan.archive.archiveId ? 'Sealing boundary…' : 'Seal chain segment'}</button></div> : null}</div>}
      </article>)}</div>}
    </section>
  </>;
}

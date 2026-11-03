import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import {
  saveAccessPolicyTechnicalIdentity,
  saveAccessPolicyUser,
} from '../api';
import { buildRemediationCandidates } from '../policyRemediation';
import type {
  AccessPolicyPostureFinding,
  AccessPolicyPostureSeverity,
  AccessPolicyPostureTarget,
  AccessPolicyResponse,
} from '../types';

type FindingFilter = 'all' | AccessPolicyPostureSeverity;

const severityLabels: Record<AccessPolicyPostureSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const statusCopy: Record<AccessPolicyResponse['posture']['status'], { label: string; description: string }> = {
  strong: {
    label: 'Strong posture',
    description: 'Explicit policy boundaries cover the active access surface.',
  },
  watch: {
    label: 'Review recommended',
    description: 'The foundation is healthy, with a few controls worth tightening.',
  },
  at_risk: {
    label: 'At risk',
    description: 'Several access paths need a stronger explicit boundary.',
  },
  critical: {
    label: 'Critical exposure',
    description: 'At least one access path currently has unrestricted capabilities.',
  },
};

function canRemediate(finding: AccessPolicyPostureFinding): boolean {
  return finding.id.startsWith('unrestricted-user:')
    || finding.id.startsWith('unrestricted-agent:')
    || finding.id.startsWith('unrestricted-api-key:');
}

export function PolicyPostureDashboard({
  data,
  onNavigate,
}: {
  data: AccessPolicyResponse;
  onNavigate: (target: AccessPolicyPostureTarget) => void;
}) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<FindingFilter>('all');
  const [remediationFindingId, setRemediationFindingId] = useState<string | null>(null);
  const [selectedCompositeId, setSelectedCompositeId] = useState<number | null>(null);
  const [lastRemediation, setLastRemediation] = useState<string | null>(null);
  const { posture } = data;
  const status = statusCopy[posture.status];
  const remediationCandidates = useMemo(() => buildRemediationCandidates(data), [data]);
  const remediationFinding = posture.findings.find(finding => finding.id === remediationFindingId) ?? null;
  const selectedImpact = remediationCandidates.find(candidate => candidate.composite.id === selectedCompositeId) ?? null;
  const visibleFindings = useMemo(
    () => posture.findings.filter(finding => filter === 'all' || finding.severity === filter),
    [filter, posture.findings],
  );
  const categoryCounts = useMemo(
    () => posture.findings.reduce(
      (counts, finding) => ({ ...counts, [finding.category]: counts[finding.category] + 1 }),
      { exposure: 0, coverage: 0, hygiene: 0 },
    ),
    [posture.findings],
  );
  const remediation = useMutation({
    mutationFn: async ({ finding, compositeId }: {
      finding: AccessPolicyPostureFinding;
      compositeId: number;
    }) => {
      const target = finding.target;
      if (!target) throw new Error('The affected principal no longer exists.');

      if (target.tab === 'users') {
        const user = data.users.find(item => item.id === Number(target.id));
        if (!user) throw new Error('The affected user no longer exists.');
        await saveAccessPolicyUser({
          userId: user.id,
          compositeIds: [compositeId],
          agentIds: user.agentIds,
          rules: user.rules.map(rule => ({
            toolPattern: rule.toolPattern,
            effect: rule.effect,
            reason: rule.reason,
            expiresAt: rule.expiresAt,
          })),
        });
        return { label: user.label };
      }

      if (target.tab === 'technical') {
        const identity = data.technicalIdentities.find(item => `${item.kind}:${item.id}` === target.id);
        if (!identity) throw new Error('The affected technical identity no longer exists.');
        await saveAccessPolicyTechnicalIdentity({
          kind: identity.kind,
          id: identity.id,
          compositeId,
          bundleMode: identity.allowedBundleIds == null ? 'all' : 'selected',
          allowedBundleIds: identity.allowedBundleIds ?? [],
          toolMode: identity.allowedTools == null ? 'all' : 'selected',
          allowedTools: identity.allowedTools ?? [],
          deniedTools: identity.deniedTools ?? [],
        });
        return { label: identity.label };
      }

      throw new Error('This finding requires manual policy review.');
    },
    onSuccess: async result => {
      setLastRemediation(`${result.label} now has an explicit composite boundary.`);
      setRemediationFindingId(null);
      setSelectedCompositeId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      ]);
    },
  });

  const openRemediation = (finding: AccessPolicyPostureFinding) => {
    remediation.reset();
    setLastRemediation(null);
    setRemediationFindingId(finding.id);
    setSelectedCompositeId(
      remediationCandidates.find(candidate => !candidate.lockoutRisk)?.composite.id
      ?? remediationCandidates[0]?.composite.id
      ?? null,
    );
  };

  return (
    <section className="posture-dashboard">
      <header className={`posture-hero is-${posture.status}`}>
        <div
          className="posture-score-ring"
          style={{ background: `conic-gradient(var(--posture-color) ${posture.score * 3.6}deg, var(--surface) 0deg)` }}
          aria-label={`Policy posture score ${posture.score} out of 100`}
        >
          <span><strong>{posture.score}</strong><small>/ 100</small></span>
        </div>
        <div className="posture-hero-copy">
          <span className="eyebrow">CONTINUOUS ACCESS REVIEW</span>
          <h2>{status.label}</h2>
          <p>{status.description}</p>
          <div className="posture-hero-meta">
            <span><ShieldCheck size={12} />{posture.coveredPrincipals} of {posture.totalPrincipals} active principals covered</span>
            <span><KeyRound size={12} />{posture.unrestrictedPrincipals} unrestricted</span>
          </div>
        </div>
        <div className="posture-generated">
          <Sparkles size={13} />
          <span>Evaluated from live policy state</span>
          <small>{new Date(data.generatedAt).toLocaleString()}</small>
        </div>
      </header>

      <div className="posture-severity-grid" aria-label="Policy finding severity">
        {(Object.keys(severityLabels) as AccessPolicyPostureSeverity[]).map(severity => (
          <button
            type="button"
            className={`posture-severity-card is-${severity}${filter === severity ? ' is-active' : ''}`}
            onClick={() => setFilter(current => current === severity ? 'all' : severity)}
            key={severity}
          >
            <span>{severity === 'critical' || severity === 'high' ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}</span>
            <div><small>{severityLabels[severity]}</small><strong>{posture.summary[severity]}</strong></div>
            <em>{filter === severity ? 'Filtered' : 'View findings'}</em>
          </button>
        ))}
      </div>

      {lastRemediation && (
        <div className="remediation-success" role="status">
          <CheckCircle2 size={15} />
          <span><b>Remediation applied.</b> {lastRemediation} The posture score has been recalculated.</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setLastRemediation(null)}><X size={13} /></button>
        </div>
      )}

      {remediationFinding && (
        <section className="remediation-center" aria-label={`Remediate ${remediationFinding.entityLabel}`}>
          <header className="remediation-heading">
            <span className="remediation-heading-icon"><Sparkles size={17} /></span>
            <div>
              <span className="eyebrow">GUIDED REMEDIATION</span>
              <h3>Apply an explicit boundary to {remediationFinding.entityLabel}</h3>
              <p>Choose an enabled composite, inspect the effective tool delta, then apply it through the audited policy API.</p>
            </div>
            <button
              type="button"
              aria-label="Close remediation"
              onClick={() => {
                remediation.reset();
                setRemediationFindingId(null);
              }}
            >
              <X size={15} />
            </button>
          </header>

          <div className="remediation-grid">
            <section className="remediation-candidates">
              <div className="posture-section-title"><ShieldCheck size={15} /><span><small>STEP 1</small><b>Select a composite</b></span></div>
              <div className="remediation-candidate-list">
                {remediationCandidates.map((candidate, index) => {
                  const selected = selectedCompositeId === candidate.composite.id;
                  return (
                    <button
                      type="button"
                      className={`${selected ? 'is-selected' : ''}${candidate.lockoutRisk ? ' has-lockout-risk' : ''}`}
                      onClick={() => {
                        remediation.reset();
                        setSelectedCompositeId(candidate.composite.id);
                      }}
                      key={candidate.composite.id}
                    >
                      <span className="policy-list-icon"><ShieldCheck size={14} /></span>
                      <span>
                        <b>{candidate.composite.name}</b>
                        <small>
                          {candidate.composite.bundleMode === 'all' ? 'All bundles' : `${candidate.composite.includedBundleIds.length} bundles`}
                          {' · '}{candidate.allowedTools.length} effective tools
                        </small>
                      </span>
                      {candidate.lockoutRisk
                        ? <em>Lockout</em>
                        : index === 0 ? <em className="is-recommended">Recommended</em> : <span className="connection-check">{selected && <CheckCircle2 size={11} />}</span>}
                    </button>
                  );
                })}
                {remediationCandidates.length === 0 && (
                  <div className="policy-rule-empty">Create and enable a composite before starting guided remediation.</div>
                )}
              </div>
            </section>

            <section className="remediation-impact">
              <div className="posture-section-title"><Wrench size={15} /><span><small>STEP 2</small><b>Review effective impact</b></span></div>
              {selectedImpact ? (
                <>
                  <div className="remediation-delta">
                    <article>
                      <span>Before</span>
                      <strong>{data.tools.length}</strong>
                      <small>catalog tools · fallback mode</small>
                    </article>
                    <ArrowRight size={17} />
                    <article className={selectedImpact.lockoutRisk ? 'is-lockout' : 'is-after'}>
                      <span>After</span>
                      <strong>{selectedImpact.allowedTools.length}</strong>
                      <small>effective tools · policy mode</small>
                    </article>
                    <article className="remediation-reduction">
                      <span>Reduced</span>
                      <strong>{selectedImpact.removedTools.length}</strong>
                      <small>tools removed from reach</small>
                    </article>
                  </div>

                  <dl className="remediation-scope">
                    <div><dt><Boxes size={12} />Bundle boundary</dt><dd>{selectedImpact.composite.bundleMode === 'all' ? 'All bundles, including future' : `${selectedImpact.composite.includedBundleIds.length} selected`}</dd></div>
                    <div><dt><Wrench size={12} />Allow boundary</dt><dd>{selectedImpact.composite.toolAllowPatterns.length || 'Wildcard inside scope'}</dd></div>
                    <div><dt><ShieldAlert size={12} />Deny guardrails</dt><dd>{selectedImpact.composite.toolDenyPatterns.length}</dd></div>
                  </dl>

                  <div className="remediation-tool-preview">
                    <div>
                      <span>Effective sample</span>
                      <div>{selectedImpact.allowedTools.slice(0, 5).map(tool => <code key={tool}>{tool}</code>)}</div>
                      {selectedImpact.allowedTools.length === 0 && <small>No current catalog tool would remain accessible.</small>}
                    </div>
                    <div>
                      <span>Removed sample</span>
                      <div>{selectedImpact.removedTools.slice(0, 5).map(tool => <code key={tool}>{tool}</code>)}</div>
                    </div>
                  </div>

                  {selectedImpact.lockoutRisk && (
                    <div className="remediation-warning">
                      <AlertTriangle size={14} />
                      <span>This composite matches no current tools. Applying it is blocked to prevent an accidental lockout.</span>
                    </div>
                  )}
                  {selectedImpact.futureBundleExposure && !selectedImpact.lockoutRisk && (
                    <div className="remediation-note">
                      <AlertTriangle size={13} />
                      <span>Future bundles remain in scope, but the composite tool patterns still limit their effective capabilities.</span>
                    </div>
                  )}
                  {remediation.error && <div className="access-manager-error" role="alert">{remediation.error.message}</div>}

                  <footer className="remediation-footer">
                    <small>
                      {remediationFinding.target?.tab === 'users'
                        ? 'Existing direct composite assignments are replaced; Agent visibility and user overrides are preserved.'
                        : remediationFinding.target?.id.startsWith('agent:')
                          ? 'The Agent receives this composite on its next execution. The change is written to the admin audit trail.'
                          : 'Existing key-level filters are preserved. The change is written to the admin audit trail.'}
                    </small>
                    {selectedImpact.lockoutRisk ? (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() => onNavigate({ tab: 'composites', id: String(selectedImpact.composite.id) })}
                      >
                        <Wrench size={14} />Fix composite scope
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="button button-primary"
                        disabled={remediation.isPending}
                        onClick={() => remediation.mutate({
                          finding: remediationFinding,
                          compositeId: selectedImpact.composite.id,
                        })}
                      >
                        <ShieldCheck size={14} />{remediation.isPending ? 'Applying…' : 'Apply composite'}
                      </button>
                    )}
                  </footer>
                </>
              ) : (
                <div className="remediation-no-candidate">
                  <ShieldAlert size={18} />
                  <b>No enabled composite is available</b>
                  <p>Create a least-privilege composite before applying a guided fix.</p>
                  <button type="button" onClick={() => onNavigate({ tab: 'composites', id: 'new' })}>
                    Create composite<ArrowRight size={13} />
                  </button>
                </div>
              )}
            </section>
          </div>
        </section>
      )}

      <div className="posture-layout">
        <section className="posture-findings">
          <header className="posture-section-heading">
            <div>
              <span className="eyebrow">PRIORITIZED FINDINGS</span>
              <h3>{filter === 'all' ? 'All detected risks' : `${severityLabels[filter]} findings`}</h3>
            </div>
            {filter !== 'all' && (
              <button type="button" onClick={() => setFilter('all')}>Clear filter</button>
            )}
            <span>{visibleFindings.length} item{visibleFindings.length === 1 ? '' : 's'}</span>
          </header>

          <div className="posture-finding-list">
            {visibleFindings.map(finding => (
              <article className={`posture-finding is-${finding.severity}`} key={finding.id}>
                <span className="posture-finding-icon">
                  {finding.severity === 'critical' || finding.severity === 'high'
                    ? <ShieldAlert size={16} />
                    : <AlertTriangle size={16} />}
                </span>
                <div className="posture-finding-copy">
                  <header>
                    <span className={`posture-severity-pill is-${finding.severity}`}>{severityLabels[finding.severity]}</span>
                    <span className="posture-category">{finding.category}</span>
                    <small>{finding.entityLabel}</small>
                  </header>
                  <h4>{finding.title}</h4>
                  <p>{finding.description}</p>
                  <div className="posture-recommendation">
                    <Sparkles size={12} />
                    <span><b>Recommended:</b> {finding.recommendation}</span>
                  </div>
                </div>
                {finding.target && (
                  <button
                    type="button"
                    className={`posture-review${canRemediate(finding) && remediationCandidates.length > 0 ? ' is-fix' : ''}`}
                    onClick={() => canRemediate(finding) && remediationCandidates.length > 0
                      ? openRemediation(finding)
                      : onNavigate(finding.target!)}
                  >
                    {canRemediate(finding) && remediationCandidates.length > 0 ? 'Fix' : 'Review'}<ArrowRight size={13} />
                  </button>
                )}
              </article>
            ))}

            {visibleFindings.length === 0 && (
              <div className="posture-empty">
                <span><CheckCircle2 size={23} /></span>
                <b>{filter === 'all' ? 'No policy risks detected' : `No ${severityLabels[filter]} findings`}</b>
                <p>{filter === 'all' ? 'The current policy state passes every posture check.' : 'Choose another severity or clear the filter.'}</p>
              </div>
            )}
          </div>
        </section>

        <aside className="posture-insights">
          <section>
            <div className="posture-section-title"><ShieldCheck size={15} /><span><small>CONTROL COVERAGE</small><b>Explicit boundaries</b></span></div>
            <div className="posture-coverage-value"><strong>{posture.coveragePercent}%</strong><span>{posture.coveredPrincipals}/{posture.totalPrincipals}</span></div>
            <div className="posture-progress"><span style={{ width: `${posture.coveragePercent}%` }} /></div>
            <p>Active users and technical identities governed by an enabled composite.</p>
          </section>

          <section>
            <div className="posture-section-title"><ShieldAlert size={15} /><span><small>RISK SURFACE</small><b>Findings by control</b></span></div>
            <dl className="posture-category-list">
              <div><dt><span className="is-exposure" />Broad exposure</dt><dd>{categoryCounts.exposure}</dd></div>
              <div><dt><span className="is-coverage" />Coverage gaps</dt><dd>{categoryCounts.coverage}</dd></div>
              <div><dt><span className="is-hygiene" />Policy hygiene</dt><dd>{categoryCounts.hygiene}</dd></div>
            </dl>
          </section>

          <section className="posture-next-step">
            <div className="posture-section-title"><Sparkles size={15} /><span><small>NEXT BEST ACTION</small><b>Fix highest impact first</b></span></div>
            {posture.findings[0] ? (
              <>
                <strong>{posture.findings[0].title}</strong>
                <p>{posture.findings[0].recommendation}</p>
                {posture.findings[0].target && (
                  <button
                    type="button"
                    onClick={() => canRemediate(posture.findings[0]!) && remediationCandidates.length > 0
                      ? openRemediation(posture.findings[0]!)
                      : onNavigate(posture.findings[0]!.target!)}
                  >
                    {canRemediate(posture.findings[0]!) && remediationCandidates.length > 0 ? 'Start guided fix' : 'Open affected policy'}<ArrowRight size={13} />
                  </button>
                )}
              </>
            ) : (
              <p>No remediation is currently required. Re-check after changing bundles, identities or policies.</p>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

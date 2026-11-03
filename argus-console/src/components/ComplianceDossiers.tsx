import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BadgeCheck,
  BookOpenCheck,
  CircleAlert,
  Download,
  FileArchive,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  PackageCheck,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  downloadAiComplianceDossierArtifact,
  generateAiComplianceDossier,
  getAiComplianceDossiers,
  getAiSystemRegistry,
  getAuditReportCatalog,
} from '../api';
import type {
  AiComplianceDossier,
  AiComplianceDossierArtifactFormat,
  AiSystemRegistryItem,
} from '../types';
import { EmptyState, ErrorState, LoadingState, timeAgo } from './Ui';

const shortDigest = (value: string): string => `${value.slice(0, 12)}…${value.slice(-8)}`;
const formatState = (value: string): string => value.replaceAll('_', ' ');
const formatBytes = (value: number): string => value < 1_024 ? `${value} B` : value < 1_048_576 ? `${(value / 1_024).toFixed(1)} KB` : `${(value / 1_048_576).toFixed(1)} MB`;

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function DossierCard({
  dossier,
  downloading,
  onDownload,
}: {
  dossier: AiComplianceDossier;
  downloading: { dossierId: string; format: AiComplianceDossierArtifactFormat } | undefined;
  onDownload: (dossierId: string, format: AiComplianceDossierArtifactFormat) => void;
}) {
  const manifest = dossier.manifest;
  const valid = dossier.verification.state === 'valid';
  const highGaps = manifest.declaredGaps.filter(gap => gap.severity === 'high' || gap.severity === 'critical').length;
  return (
    <article className={`dossier-card${valid ? ' is-valid' : ' is-invalid'}`}>
      <header>
        <span className={`dossier-proof-icon ${valid ? 'is-valid' : 'is-invalid'}`}>{valid ? <BadgeCheck size={19} /> : <ShieldAlert size={19} />}</span>
        <div>
          <small>DOSSIER V{manifest.schemaVersion} · REVISION {manifest.aiSystem.revision}</small>
          <h3>{manifest.aiSystem.displayName}</h3>
          <p>{timeAgo(manifest.generatedAt)} · {manifest.scope.environments.join(', ')}</p>
        </div>
        <span className={`dossier-state ${manifest.assessmentStatus === 'ready_for_independent_review' ? 'is-ready' : 'is-warning'}`}>{formatState(manifest.assessmentStatus)}</span>
      </header>
      <div className="dossier-facts">
        <span><Fingerprint size={13} /><b>Manifest</b><code title={manifest.dossierSha256}>{shortDigest(manifest.dossierSha256)}</code></span>
        <span><LockKeyhole size={13} /><b>Source pack</b><code title={manifest.sourceEvidencePack.sha256}>{shortDigest(manifest.sourceEvidencePack.sha256)}</code></span>
        <span className={valid ? 'is-valid' : 'is-invalid'}>{valid ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}<b>Integrity</b>{valid ? 'verified' : dossier.verification.reasons.join(', ')}</span>
      </div>
      <div className="dossier-coverage">
        <span><b>{manifest.controlCoverage.satisfied}</b> satisfied</span>
        <span><b>{manifest.controlCoverage.open}</b> open</span>
        <span><b>{manifest.declaredGaps.length}</b> declared gaps</span>
        <span className={highGaps ? 'is-warning' : ''}><b>{highGaps}</b> high / critical</span>
        <span className={manifest.externalAnchors.length ? 'is-valid' : 'is-warning'}><b>{manifest.externalAnchors.length}</b> external anchors</span>
      </div>
      {manifest.complianceMatrix && (
        <details className="dossier-matrix">
          <summary>
            <BookOpenCheck size={14} />
            AI Act obligation matrix
            <span><b>{manifest.complianceMatrix.coverage.satisfied}/{manifest.complianceMatrix.coverage.applicable}</b> satisfied · {manifest.complianceMatrix.coverage.partial} partial · {manifest.complianceMatrix.coverage.missing} missing</span>
          </summary>
          <div className="dossier-matrix-body">
            <p className="dossier-matrix-rationale">{manifest.complianceMatrix.legalBaseline.applicabilityRationale}</p>
            {manifest.complianceMatrix.groups.map(group => (
              <section key={group.groupId} className="dossier-matrix-group">
                <header>
                  <div><small>{group.legalRefs.join(' · ')}</small><h4>{group.title}</h4></div>
                  <span>{group.coverage.satisfied}/{group.coverage.applicable} satisfied</span>
                </header>
                <div>
                  {group.requirements.map(requirement => (
                    <details key={requirement.requirementId} className={`dossier-requirement state-${requirement.state}`}>
                      <summary>
                        <span className="dossier-requirement-state">{formatState(requirement.state)}</span>
                        <b>{requirement.title}</b>
                        <code>{requirement.legalRefs.join(', ')}</code>
                      </summary>
                      <div>
                        <p>{requirement.description}</p>
                        {requirement.findings.map(finding => <p className="is-finding" key={finding}>{finding}</p>)}
                        <small>Owner: {formatState(requirement.ownerRole)} · Evidence {requirement.evidence.length} · Expected: {requirement.expectedEvidence.join(', ')}</small>
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ))}
            <footer><Fingerprint size={12} />Matrix <code title={manifest.complianceMatrix.matrixSha256}>{shortDigest(manifest.complianceMatrix.matrixSha256)}</code> · legal review remains required</footer>
          </div>
        </details>
      )}
      {manifest.externalAnchors.length > 0 && <div className="dossier-anchors">{manifest.externalAnchors.map(anchor => <span key={`${anchor.kind}:${anchor.provider}:${anchor.reference}`} title={anchor.reference}><LockKeyhole size={12} /><b>{anchor.kind === 'worm_object' ? 'WORM' : anchor.kind === 'qualified_timestamp' ? 'Timestamp' : 'Transparency'}</b>{anchor.provider}<small>{timeAgo(anchor.anchoredAt)} · {anchor.verification}</small></span>)}</div>}
      {manifest.declaredGaps.length > 0 && (
        <details className="dossier-gaps">
          <summary><CircleAlert size={13} />Review {manifest.declaredGaps.length} explicit limitation(s)</summary>
          <div>{manifest.declaredGaps.map(gap => <p key={gap.gapId}><span className={`severity severity-${gap.severity}`}>{gap.severity}</span><b>{formatState(gap.gapId)}</b><small>{gap.description}</small></p>)}</div>
        </details>
      )}
      <footer>
        <small>{manifest.claimBoundary}</small>
        <div className="dossier-downloads">
          {(['manifest', 'json', 'pdf', 'signature'] as const).map(format => {
            const artifact = manifest.artifacts.find(item => item.format === format);
            const pending = downloading?.dossierId === manifest.dossierId && downloading.format === format;
            return <button type="button" key={format} disabled={Boolean(downloading)} aria-label={`Download dossier ${format}`} onClick={() => onDownload(manifest.dossierId, format)}><Download size={12} />{pending ? '…' : format.toUpperCase()}{artifact && <em>{formatBytes(artifact.bytes)}</em>}</button>;
          })}
        </div>
      </footer>
    </article>
  );
}

export function ComplianceDossiers() {
  const queryClient = useQueryClient();
  const registry = useQuery({ queryKey: ['ai-system-registry'], queryFn: getAiSystemRegistry, retry: false });
  const reports = useQuery({ queryKey: ['audit-reports'], queryFn: getAuditReportCatalog, retry: false });
  const [selectedSystemId, setSelectedSystemId] = useState('');
  const [selectedReportId, setSelectedReportId] = useState('');
  const releasedSystems = useMemo(() => (registry.data?.aiSystems ?? []).filter(system => system.lifecycleState === 'released'), [registry.data]);
  const eligibleReports = useMemo(() => (reports.data?.runs ?? []).filter(report => report.status === 'completed' && report.verificationState === 'valid' && report.packDigest), [reports.data]);
  const selectedSystem = releasedSystems.find(system => system.aiSystemId === selectedSystemId) ?? null;
  const dossiers = useQuery({
    queryKey: ['ai-compliance-dossiers', selectedSystemId],
    queryFn: () => getAiComplianceDossiers(selectedSystemId),
    enabled: Boolean(selectedSystemId),
    retry: false,
  });

  useEffect(() => {
    if (!releasedSystems.some(system => system.aiSystemId === selectedSystemId)) setSelectedSystemId(releasedSystems[0]?.aiSystemId ?? '');
  }, [releasedSystems, selectedSystemId]);
  useEffect(() => {
    if (!eligibleReports.some(report => report.id === selectedReportId)) setSelectedReportId(eligibleReports[0]?.id ?? '');
  }, [eligibleReports, selectedReportId]);

  const refreshDossiers = () => queryClient.invalidateQueries({ queryKey: ['ai-compliance-dossiers', selectedSystemId] });
  const generate = useMutation({
    mutationFn: ({ system, reportId }: { system: AiSystemRegistryItem; reportId: string }) => generateAiComplianceDossier(system, reportId),
    onSuccess: () => void refreshDossiers(),
  });
  const download = useMutation({
    mutationFn: ({ dossierId, format }: { dossierId: string; format: AiComplianceDossierArtifactFormat }) => downloadAiComplianceDossierArtifact(dossierId, format),
    onSuccess: result => saveBlob(result.blob, result.filename),
  });
  const exportSecurity = reports.data?.exportSecurity;
  const withFreshMfa = (action: () => void) => {
    if (exportSecurity?.requiresFreshMfa && !exportSecurity.satisfied) {
      window.location.assign(`/auth/oidc/step-up?returnTo=${encodeURIComponent('/governance/compliance?tab=dossiers')}`);
      return;
    }
    action();
  };

  if (registry.isLoading || reports.isLoading) return <LoadingState label="Loading AI compliance dossiers…" />;
  if (registry.error || reports.error) return <ErrorState error={registry.error ?? reports.error ?? new Error('Dossier prerequisites are unavailable')} />;

  return (
    <div className="dossier-workspace">
      <section className="dossier-readiness panel">
        <div><span className="eyebrow">EU AI ACT · RELEASE EVIDENCE</span><h2>Immutable compliance dossiers</h2><p>Freeze one released AI-system revision together with its verified Evidence Pack, signed checkpoint and explicit limitations.</p></div>
        <div className="dossier-readiness-facts">
          <span><b>{releasedSystems.length}</b> released systems</span>
          <span><b>{eligibleReports.length}</b> verified reports</span>
          <span className={exportSecurity?.satisfied ? 'is-valid' : 'is-warning'}><KeyRound size={12} /><b>{exportSecurity?.satisfied ? 'Confirmed' : 'Required'}</b> SSO + fresh MFA</span>
        </div>
      </section>

      {releasedSystems.length === 0 ? (
        <section className="panel dossier-empty-system"><EmptyState title="No released AI system is eligible" description="Register, classify, independently review and release an AI-system revision before creating a dossier." /><a className="button button-primary" href="/governance/compliance?tab=systems">Open AI-system registry</a></section>
      ) : (
        <>
          <section className="dossier-builder panel">
            <div className="dossier-builder-copy"><span><FileArchive size={20} /></span><div><small>CONTROLLED PACKAGING</small><h2>Build dossier</h2><p>The server verifies the exact revision digest, report signature and cryptographic release binding before it writes anything.</p></div></div>
            <label><span>Released AI system</span><select aria-label="Released AI system" value={selectedSystemId} onChange={event => setSelectedSystemId(event.target.value)}>{releasedSystems.map(system => <option value={system.aiSystemId} key={system.aiSystemId}>{system.displayName} · rev {system.revision} · {formatState(system.classification)}</option>)}</select></label>
            <label><span>Verified source report</span><select aria-label="Verified source report" value={selectedReportId} onChange={event => setSelectedReportId(event.target.value)} disabled={eligibleReports.length === 0}>{eligibleReports.length === 0 ? <option value="">No verified report available</option> : eligibleReports.map(report => <option value={report.id} key={report.id}>{report.name} · {report.environment} · {timeAgo(report.completedAt ?? report.createdAt)}</option>)}</select></label>
            <button className="button button-primary" type="button" disabled={!selectedSystem || !selectedReportId || generate.isPending} onClick={() => selectedSystem && withFreshMfa(() => generate.mutate({ system: selectedSystem, reportId: selectedReportId }))}><PackageCheck size={15} />{generate.isPending ? 'Verifying & freezing…' : exportSecurity?.satisfied === false ? 'Confirm MFA to build' : 'Build immutable dossier'}</button>
            <a href="/observe/audit?tab=reports">Open signed reports</a>
          </section>
          {(generate.error || download.error) && <div className="state-panel state-error" role="alert"><ShieldAlert size={17} /><span>{(generate.error ?? download.error)?.message}</span></div>}
          <section className="dossier-history">
            <header><div><span className="eyebrow">DOSSIER HISTORY</span><h2>{selectedSystem?.displayName}</h2><p>Append-only artifacts for the selected released revision.</p></div><button className="icon-button" type="button" aria-label="Refresh dossiers" onClick={() => void dossiers.refetch()}><RefreshCw size={15} /></button></header>
            {dossiers.isLoading ? <LoadingState label="Verifying stored dossiers…" /> : dossiers.error ? <ErrorState error={dossiers.error} /> : (dossiers.data?.dossiers.length ?? 0) === 0 ? <section className="panel"><EmptyState title="No dossier generated yet" description={eligibleReports.length ? 'Choose a release-bound verified report and build the first immutable dossier.' : 'Generate a signed report containing or referenced by the release decision first.'} /></section> : <div className="dossier-list">{dossiers.data!.dossiers.map(dossier => <DossierCard key={dossier.manifest.dossierId} dossier={dossier} downloading={download.isPending ? download.variables : undefined} onDownload={(dossierId, format) => withFreshMfa(() => download.mutate({ dossierId, format }))} />)}</div>}
          </section>
        </>
      )}
    </div>
  );
}

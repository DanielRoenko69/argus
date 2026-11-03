import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Fingerprint,
  KeyRound,
  Layers3,
  Plus,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  UsersRound,
  X,
} from 'lucide-react';
import {
  classifyAiSystem,
  createAiSystem,
  getAiActControlCatalog,
  getAiSystemControlLedger,
  getAiSystemRegistry,
  getAiSystemRegistryDetail,
  getAuditReportCatalog,
  recordAiSystemControlAssessment,
  releaseAiSystem,
} from '../api';
import type {
  AiActControlCatalog,
  AiSystemClassification,
  AiSystemClassificationInput,
  AiSystemComponentBinding,
  AiSystemComponentType,
  AiSystemCreateInput,
  AiSystemMarketRole,
  AiSystemControlProjection,
  AiSystemControlStatus,
  AiSystemRegistryItem,
  AiSystemRevision,
  AuditReportRun,
} from '../types';
import { EmptyState, ErrorState, LoadingState, timeAgo } from './Ui';

const SHA256 = /^[a-f0-9]{64}$/i;
const CLASSIFICATIONS: AiSystemClassification[] = ['assessment_required', 'high_risk', 'limited_transparency', 'minimal_or_no_risk', 'out_of_scope', 'prohibited'];
const ROLES: AiSystemMarketRole[] = ['provider', 'deployer', 'importer', 'distributor', 'authorised_representative', 'product_manufacturer', 'data_controller', 'data_processor'];
const COMPONENT_TYPES: AiSystemComponentType[] = ['agent', 'workflow', 'model', 'runtime_profile', 'mcp_bundle', 'skill', 'knowledge_source', 'dataset'];

type RegistrationDraft = {
  displayName: string;
  intendedPurpose: string;
  targetUsers: string;
  affectedGroups: string;
  regions: string;
  prohibitedUses: string;
  dataCategories: string;
  role: AiSystemMarketRole;
  organisationId: string;
  organisationName: string;
  roleRationale: string;
  prohibitedDecision: 'clear' | 'blocked' | 'external_review_required';
  prohibitedArticleRefs: string;
  prohibitedRationale: string;
  classification: AiSystemClassification;
  classificationArticleRefs: string;
  annexRefs: string;
  classificationRationale: string;
  highRiskBasis: string;
  legalReviewRequired: boolean;
  nextReviewAt: string;
  components: AiSystemComponentBinding[];
  catalogId: string;
  catalogVersion: string;
  catalogSha256: string;
};

const futureReview = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 16);
const blankComponent = (): AiSystemComponentBinding => ({ resourceType: 'agent', resourceId: '', revision: '', sha256: '' });
const initialDraft = (catalog: AiActControlCatalog): RegistrationDraft => ({
  displayName: '', intendedPurpose: '', targetUsers: '', affectedGroups: '', regions: 'EU/EEA', prohibitedUses: '', dataCategories: '',
  role: 'provider', organisationId: '', organisationName: '', roleRationale: '',
  prohibitedDecision: 'external_review_required', prohibitedArticleRefs: 'Article 5', prohibitedRationale: '',
  classification: 'assessment_required', classificationArticleRefs: 'Article 6', annexRefs: '', classificationRationale: '', highRiskBasis: '', legalReviewRequired: true, nextReviewAt: futureReview(),
  components: [blankComponent()], catalogId: catalog.catalogId, catalogVersion: String(catalog.catalogVersion), catalogSha256: catalog.catalogSha256,
});

const splitList = (value: string) => [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
const humanize = (value: string) => value.replaceAll('_', ' ');
const shortDigest = (value: string) => `${value.slice(0, 10)}…${value.slice(-8)}`;
const isMfaError = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && String((error as { code?: unknown }).code ?? '').includes('MFA');

function buildCreateInput(draft: RegistrationDraft): AiSystemCreateInput {
  return {
    displayName: draft.displayName.trim(),
    intendedPurpose: draft.intendedPurpose.trim(),
    prohibitedUses: splitList(draft.prohibitedUses),
    targetUsers: splitList(draft.targetUsers),
    affectedGroups: splitList(draft.affectedGroups),
    regions: splitList(draft.regions),
    marketRoles: [{ role: draft.role, organisationId: draft.organisationId.trim(), organisationName: draft.organisationName.trim(), rationale: draft.roleRationale.trim() }],
    prohibitedPracticeCheck: { decision: draft.prohibitedDecision, articleRefs: splitList(draft.prohibitedArticleRefs), rationale: draft.prohibitedRationale.trim() },
    classification: {
      classification: draft.classification,
      articleRefs: splitList(draft.classificationArticleRefs),
      annexRefs: splitList(draft.annexRefs),
      ...(draft.highRiskBasis.trim() ? { highRiskBasis: draft.highRiskBasis.trim() } : {}),
      rationale: draft.classificationRationale.trim(),
      legalReviewRequired: draft.legalReviewRequired,
      nextReviewAt: new Date(draft.nextReviewAt).toISOString(),
    },
    componentBindings: draft.components.map(component => ({ ...component, resourceId: component.resourceId.trim(), revision: component.revision.trim(), sha256: component.sha256.trim().toLowerCase() })),
    dataCategories: splitList(draft.dataCategories),
    controlCatalog: { catalogId: draft.catalogId.trim(), catalogVersion: Number(draft.catalogVersion), catalogSha256: draft.catalogSha256.trim().toLowerCase() },
  };
}

function registrationStepValid(step: number, draft: RegistrationDraft): boolean {
  if (step === 0) return Boolean(draft.displayName.trim() && draft.intendedPurpose.trim() && splitList(draft.targetUsers).length && splitList(draft.regions).length);
  if (step === 1) return Boolean(draft.organisationId.trim() && draft.organisationName.trim() && draft.roleRationale.trim());
  if (step === 2) return Boolean(draft.prohibitedRationale.trim() && draft.classificationRationale.trim() && draft.nextReviewAt && (draft.classification !== 'high_risk' || draft.highRiskBasis.trim()));
  return Boolean(draft.catalogId.trim() && Number(draft.catalogVersion) > 0 && SHA256.test(draft.catalogSha256) && draft.components.length && draft.components.every(component => component.resourceId.trim() && component.revision.trim() && SHA256.test(component.sha256)));
}

function RegistryCard({ item, selected, onSelect }: { item: AiSystemRegistryItem; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={`ai-system-card${selected ? ' is-selected' : ''}`} onClick={onSelect}>
    <span className={`ai-system-state state-${item.lifecycleState}`}><i />{humanize(item.lifecycleState)}</span>
    <strong>{item.displayName}</strong>
    <small>{humanize(item.classification)} · revision {item.revision}</small>
    <footer><span><Boxes size={12} />{item.componentCount} components</span><span>{timeAgo(item.createdAt)}</span><ChevronRight size={14} /></footer>
  </button>;
}

function RegistrationDialog({ catalog, onClose, onCreated }: { catalog: AiActControlCatalog; onClose: () => void; onCreated: (system: AiSystemRegistryItem | { aiSystemId: string }) => void }) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState(() => initialDraft(catalog));
  const create = useMutation({
    mutationFn: () => createAiSystem(buildCreateInput(draft)),
    onSuccess: result => onCreated(result.aiSystem.revision),
  });
  const set = <K extends keyof RegistrationDraft>(key: K, value: RegistrationDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const updateComponent = (index: number, patch: Partial<AiSystemComponentBinding>) => setDraft(current => ({ ...current, components: current.components.map((component, componentIndex) => componentIndex === index ? { ...component, ...patch } : component) }));
  const stages = ['Identity', 'Responsibility', 'Classification', 'Evidence'];

  return <div className="compliance-layer" role="presentation" onMouseDown={onClose}>
    <section className="compliance-dialog ai-system-dialog" role="dialog" aria-modal="true" aria-label="Register AI system" onMouseDown={event => event.stopPropagation()}>
      <header><div><span className="eyebrow">AI SYSTEM REGISTRATION · STEP {step + 1}/4</span><h2>{stages[step]}</h2></div><button type="button" aria-label="Close AI-system registration" onClick={onClose}><X size={16} /></button></header>
      <ol className="ai-registration-steps">{stages.map((label, index) => <li className={index === step ? 'is-current' : index < step ? 'is-complete' : ''} key={label}><span>{index < step ? <Check size={12} /> : index + 1}</span>{label}</li>)}</ol>
      <form onSubmit={event => { event.preventDefault(); if (step < 3) setStep(value => value + 1); else create.mutate(); }}>
        {step === 0 && <div className="ai-form-grid">
          <label className="is-wide"><span>System name</span><input aria-label="AI-system name" required maxLength={240} value={draft.displayName} onChange={event => set('displayName', event.target.value)} placeholder="Customer support copilot" /></label>
          <label className="is-wide"><span>Intended purpose</span><textarea aria-label="Intended purpose" required maxLength={4000} value={draft.intendedPurpose} onChange={event => set('intendedPurpose', event.target.value)} placeholder="What the system may do, for whom and under which human control…" /></label>
          <label><span>Target users</span><input aria-label="Target users" value={draft.targetUsers} onChange={event => set('targetUsers', event.target.value)} placeholder="Support agents, supervisors" /><small>Comma separated</small></label>
          <label><span>Operating regions</span><input aria-label="Operating regions" value={draft.regions} onChange={event => set('regions', event.target.value)} placeholder="EU/EEA" /></label>
          <label><span>Affected groups</span><input aria-label="Affected groups" value={draft.affectedGroups} onChange={event => set('affectedGroups', event.target.value)} placeholder="Customers, employees" /></label>
          <label><span>Data categories</span><input aria-label="Data categories" value={draft.dataCategories} onChange={event => set('dataCategories', event.target.value)} placeholder="Conversation content, account metadata" /></label>
          <label className="is-wide"><span>Explicitly prohibited uses</span><textarea aria-label="Prohibited uses" value={draft.prohibitedUses} onChange={event => set('prohibitedUses', event.target.value)} placeholder="One boundary per line" /></label>
        </div>}
        {step === 1 && <div className="ai-form-grid">
          <label><span>Primary market role</span><select aria-label="Primary market role" value={draft.role} onChange={event => set('role', event.target.value as AiSystemMarketRole)}>{ROLES.map(role => <option value={role} key={role}>{humanize(role)}</option>)}</select></label>
          <label><span>Organisation ID</span><input aria-label="Organisation ID" value={draft.organisationId} onChange={event => set('organisationId', event.target.value)} placeholder="acme-eu" /></label>
          <label className="is-wide"><span>Organisation name</span><input aria-label="Organisation name" value={draft.organisationName} onChange={event => set('organisationName', event.target.value)} placeholder="Acme GmbH" /></label>
          <label className="is-wide"><span>Why this role applies</span><textarea aria-label="Market role rationale" value={draft.roleRationale} onChange={event => set('roleRationale', event.target.value)} placeholder="This organisation configures and offers the AI system…" /></label>
          <div className="ai-guidance is-wide"><UsersRound size={17} /><p><b>Responsibilities stay explicit.</b> Additional roles can be added in a later immutable revision. Argus records who confirmed each assignment and when.</p></div>
        </div>}
        {step === 2 && <div className="ai-form-grid">
          <label><span>Article 5 screening</span><select aria-label="Prohibited-practice decision" value={draft.prohibitedDecision} onChange={event => set('prohibitedDecision', event.target.value as RegistrationDraft['prohibitedDecision'])}><option value="external_review_required">Independent review required</option><option value="clear">Clear</option><option value="blocked">Blocked / prohibited</option></select></label>
          <label><span>Article references</span><input aria-label="Prohibited-practice article references" value={draft.prohibitedArticleRefs} onChange={event => set('prohibitedArticleRefs', event.target.value)} /></label>
          <label className="is-wide"><span>Screening rationale</span><textarea aria-label="Prohibited-practice rationale" value={draft.prohibitedRationale} onChange={event => set('prohibitedRationale', event.target.value)} placeholder="Explain the intended-purpose screening and unresolved legal questions…" /></label>
          <label><span>Preliminary classification</span><select aria-label="AI-system classification" value={draft.classification} onChange={event => { const classification = event.target.value as AiSystemClassification; setDraft(current => ({ ...current, classification, prohibitedDecision: classification === 'prohibited' ? 'blocked' : current.prohibitedDecision === 'blocked' ? 'external_review_required' : current.prohibitedDecision })); }}>{CLASSIFICATIONS.map(value => <option value={value} key={value}>{humanize(value)}</option>)}</select></label>
          <label><span>Next review</span><input aria-label="Next classification review" type="datetime-local" value={draft.nextReviewAt} onChange={event => set('nextReviewAt', event.target.value)} /></label>
          <label><span>Classification references</span><input aria-label="Classification article references" value={draft.classificationArticleRefs} onChange={event => set('classificationArticleRefs', event.target.value)} placeholder="Article 6, Annex III" /></label>
          <label><span>Annex references</span><input aria-label="Classification annex references" value={draft.annexRefs} onChange={event => set('annexRefs', event.target.value)} placeholder="Annex III 5(b)" /></label>
          {draft.classification === 'high_risk' && <label className="is-wide"><span>High-risk legal basis</span><textarea aria-label="High-risk legal basis" value={draft.highRiskBasis} onChange={event => set('highRiskBasis', event.target.value)} /></label>}
          <label className="is-wide"><span>Classification rationale</span><textarea aria-label="Classification rationale" value={draft.classificationRationale} onChange={event => set('classificationRationale', event.target.value)} placeholder="Record facts and assumptions; an authorized independent reviewer confirms them later." /></label>
          <label className="ai-checkbox is-wide"><input type="checkbox" checked={draft.legalReviewRequired} onChange={event => set('legalReviewRequired', event.target.checked)} /><span>Require an independent legal review</span></label>
        </div>}
        {step === 3 && <div className="ai-evidence-form">
          <div className="ai-guidance"><Fingerprint size={17} /><p><b>Pin exact revisions.</b> Use SHA-256 values from the source system. Argus does not invent or silently recalculate evidence identity in the browser.</p></div>
          <div className="ai-component-list"><header><div><span className="eyebrow">SYSTEM COMPOSITION</span><h3>Bound components</h3></div><button type="button" onClick={() => setDraft(current => ({ ...current, components: [...current.components, blankComponent()] }))}><Plus size={13} />Add component</button></header>{draft.components.map((component, index) => <div className="ai-component-row" key={index}>
            <select aria-label={`Component ${index + 1} type`} value={component.resourceType} onChange={event => updateComponent(index, { resourceType: event.target.value as AiSystemComponentType })}>{COMPONENT_TYPES.map(type => <option value={type} key={type}>{humanize(type)}</option>)}</select>
            <input aria-label={`Component ${index + 1} ID`} value={component.resourceId} onChange={event => updateComponent(index, { resourceId: event.target.value })} placeholder="Resource ID" />
            <input aria-label={`Component ${index + 1} revision`} value={component.revision} onChange={event => updateComponent(index, { revision: event.target.value })} placeholder="Revision" />
            <input aria-label={`Component ${index + 1} SHA-256`} className={component.sha256 && !SHA256.test(component.sha256) ? 'is-invalid' : ''} value={component.sha256} onChange={event => updateComponent(index, { sha256: event.target.value })} placeholder="64-character SHA-256" />
            {draft.components.length > 1 && <button type="button" aria-label={`Remove component ${index + 1}`} onClick={() => setDraft(current => ({ ...current, components: current.components.filter((_, componentIndex) => componentIndex !== index) }))}><X size={13} /></button>}
          </div>)}</div>
          <div className="ai-catalog-pin"><ShieldCheck size={18} /><div><span className="eyebrow">SERVER-OWNED CONTROL BASELINE</span><b>{catalog.catalogId} · version {catalog.catalogVersion}</b><small>{catalog.controls.length} legal controls · effective {new Date(catalog.effectiveFrom).toLocaleDateString()} · <code title={catalog.catalogSha256}>{shortDigest(catalog.catalogSha256)}</code></small></div></div>
        </div>}
        {create.error && <p className="decision-error">{create.error.message}</p>}
        <footer><button className="button button-secondary" type="button" onClick={() => step ? setStep(value => value - 1) : onClose()}>{step ? <><ArrowLeft size={13} />Back</> : 'Cancel'}</button><button className="button button-primary" type="submit" disabled={!registrationStepValid(step, draft) || create.isPending}>{create.isPending ? 'Registering…' : step === 3 ? 'Register immutable draft' : <>Continue<ArrowRight size={13} /></>}</button></footer>
      </form>
    </section>
  </div>;
}

function ControlAssessmentDialog({ control, revision, reports, onClose, onRecorded, onMfa }: {
  control: AiSystemControlProjection;
  revision: AiSystemRevision;
  reports: AuditReportRun[];
  onClose: () => void;
  onRecorded: () => Promise<void>;
  onMfa: () => void;
}) {
  const current = control.assessment;
  const [status, setStatus] = useState<AiSystemControlStatus>(current?.status ?? (control.applicable ? 'in_progress' : 'not_applicable'));
  const [ownerParty, setOwnerParty] = useState(current?.ownerParty ?? 'provider');
  const [ownerId, setOwnerId] = useState(current?.ownerId ?? revision.owner.actorId);
  const [rationale, setRationale] = useState(current?.rationale ?? 'Control owner assigned; implementation and evidence are under review.');
  const [dueAt, setDueAt] = useState(current?.dueAt?.slice(0, 16) ?? futureReview());
  const [reassessmentAt, setReassessmentAt] = useState(current?.reassessmentAt?.slice(0, 16) ?? futureReview());
  const [reportId, setReportId] = useState(current?.evidence.find(item => item.evidenceType === 'report')?.evidenceId ?? reports[0]?.id ?? '');
  const [exceptionRationale, setExceptionRationale] = useState(current?.exception?.rationale ?? 'Time-bounded exception approved after independent review.');
  const [compensatingControls, setCompensatingControls] = useState(current?.exception?.compensatingControls.join('\n') ?? 'Enhanced human review');
  const [exceptionExpiry, setExceptionExpiry] = useState(current?.exception?.expiresAt.slice(0, 16) ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 16));
  const save = useMutation({
    mutationFn: () => {
      const report = reports.find(item => item.id === reportId);
      return recordAiSystemControlAssessment(revision.aiSystemId, control.definition.controlId, {
        expectedRevision: revision.revision,
        expectedRevisionSha256: revision.revisionSha256,
        status,
        ownerParty,
        ownerId: ownerId.trim(),
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        reassessmentAt: reassessmentAt ? new Date(reassessmentAt).toISOString() : null,
        rationale: rationale.trim(),
        evidence: status === 'satisfied' && report ? [{ evidenceType: 'report', evidenceId: report.id, sha256: report.packDigest! }] : [],
        exception: status === 'exception' ? { rationale: exceptionRationale.trim(), compensatingControls: splitList(compensatingControls), expiresAt: new Date(exceptionExpiry).toISOString() } : null,
      });
    },
    onSuccess: async () => { await onRecorded(); onClose(); },
    onError: error => { if (isMfaError(error)) onMfa(); },
  });
  const valid = Boolean(ownerId.trim() && rationale.trim()
    && (status !== 'satisfied' || reports.some(item => item.id === reportId && item.packDigest))
    && (status !== 'exception' || (exceptionRationale.trim() && splitList(compensatingControls).length && exceptionExpiry)));
  return <div className="compliance-layer" role="presentation" onMouseDown={onClose}>
    <section className="compliance-dialog ai-decision-dialog ai-control-assessment-dialog" role="dialog" aria-modal="true" aria-label={`Assess ${control.definition.title}`} onMouseDown={event => event.stopPropagation()}>
      <header><div><span className="eyebrow">{control.definition.articleRefs.join(' · ')} · REVISION {revision.revision}</span><h2>{control.definition.title}</h2></div><button type="button" aria-label="Close control assessment" onClick={onClose}><X size={16} /></button></header>
      <form onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <div className="ai-guidance"><ShieldCheck size={17} /><p><b>Append-only control decision.</b> SSO identity, fresh MFA, catalog digest, evidence references and deadlines become canonical audit evidence.</p></div>
        <label><span>Control status</span><select aria-label="Control status" value={status} onChange={event => setStatus(event.target.value as AiSystemControlStatus)}><option value="not_assessed">Not assessed</option><option value="in_progress">In progress</option><option value="satisfied">Satisfied with verified evidence</option><option value="exception">Time-bounded exception</option>{control.definition.applicability !== 'always' && <option value="not_applicable">Not applicable</option>}</select></label>
        <div className="ai-form-grid"><label><span>Responsible party</span><select aria-label="Control owner party" value={ownerParty} onChange={event => setOwnerParty(event.target.value as typeof ownerParty)}><option value="argus_platform">Argus platform</option><option value="provider">Provider</option><option value="deployer">Deployer</option><option value="external_assessor">External assessor</option></select></label><label><span>Owner ID</span><input aria-label="Control owner ID" value={ownerId} onChange={event => setOwnerId(event.target.value)} /></label><label><span>Due at</span><input aria-label="Control due at" type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} /></label><label><span>Reassess at</span><input aria-label="Control reassessment at" type="datetime-local" value={reassessmentAt} onChange={event => setReassessmentAt(event.target.value)} /></label></div>
        <label><span>Decision rationale</span><textarea aria-label="Control rationale" value={rationale} onChange={event => setRationale(event.target.value)} /></label>
        {status === 'satisfied' && <label><span>Verified signed evidence report</span><select aria-label="Control evidence report" value={reportId} onChange={event => setReportId(event.target.value)}>{reports.length ? reports.map(report => <option value={report.id} key={report.id}>{report.name} · {shortDigest(report.packDigest!)}</option>) : <option value="">No verified signed report available</option>}</select></label>}
        {status === 'exception' && <div className="ai-form-grid"><label className="is-wide"><span>Exception rationale</span><textarea aria-label="Control exception rationale" value={exceptionRationale} onChange={event => setExceptionRationale(event.target.value)} /></label><label><span>Expires at</span><input aria-label="Control exception expiry" type="datetime-local" value={exceptionExpiry} onChange={event => setExceptionExpiry(event.target.value)} /></label><label><span>Compensating controls</span><textarea aria-label="Control compensating controls" value={compensatingControls} onChange={event => setCompensatingControls(event.target.value)} /></label></div>}
        {control.definition.blocksProduction && status === 'exception' && <p className="decision-error">This control blocks production. An exception is recorded for audit, but cannot bypass the release gate.</p>}
        {save.error && <p className="decision-error">{save.error.message}</p>}
        <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={!valid || save.isPending}>{save.isPending ? 'Recording…' : 'Record immutable assessment'}</button></footer>
      </form>
    </section>
  </div>;
}

export function AiSystemRegistry() {
  const queryClient = useQueryClient();
  const registry = useQuery({ queryKey: ['ai-system-registry'], queryFn: getAiSystemRegistry, retry: false });
  const catalog = useQuery({ queryKey: ['ai-act-control-catalog'], queryFn: getAiActControlCatalog, retry: false });
  const reports = useQuery({ queryKey: ['audit-reports'], queryFn: getAuditReportCatalog, retry: false });
  const [selectedId, setSelectedId] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [controlId, setControlId] = useState('');
  const [reviewClassification, setReviewClassification] = useState<AiSystemClassification>('minimal_or_no_risk');
  const [reviewRationale, setReviewRationale] = useState('');
  const [reviewRefs, setReviewRefs] = useState('Article 6');
  const [reviewHighRiskBasis, setReviewHighRiskBasis] = useState('');
  const [reviewLegalRequired, setReviewLegalRequired] = useState(false);
  const [reviewDate, setReviewDate] = useState(futureReview);
  const [releaseReportId, setReleaseReportId] = useState('');
  const [releaseRationale, setReleaseRationale] = useState('Independent evidence review completed for this exact immutable revision.');
  const systems = registry.data?.aiSystems ?? [];
  useEffect(() => { if (!selectedId && systems[0]) setSelectedId(systems[0].aiSystemId); }, [selectedId, systems]);
  const detail = useQuery({ queryKey: ['ai-system-registry-detail', selectedId], queryFn: () => getAiSystemRegistryDetail(selectedId), enabled: Boolean(selectedId), retry: false });
  const ledger = useQuery({ queryKey: ['ai-system-control-ledger', selectedId], queryFn: () => getAiSystemControlLedger(selectedId), enabled: Boolean(selectedId), retry: false });
  const current = detail.data?.aiSystem;
  const selectedControl = ledger.data?.controls.find(control => control.definition.controlId === controlId);
  const verifiedReports = useMemo(() => (reports.data?.runs ?? []).filter(report => report.status === 'completed' && report.verificationState === 'valid' && report.packDigest), [reports.data]);
  useEffect(() => { if (!releaseReportId && verifiedReports[0]) setReleaseReportId(verifiedReports[0].id); }, [releaseReportId, verifiedReports]);

  const refresh = async (nextId?: string) => {
    await queryClient.invalidateQueries({ queryKey: ['ai-system-registry'] });
    if (nextId) setSelectedId(nextId);
    await queryClient.invalidateQueries({ queryKey: ['ai-system-registry-detail', nextId ?? selectedId] });
    await queryClient.invalidateQueries({ queryKey: ['ai-system-control-ledger', nextId ?? selectedId] });
  };
  const stepUp = () => { window.location.assign(`/auth/oidc/step-up?returnTo=${encodeURIComponent('/governance/compliance?tab=systems')}`); };
  const withFreshMfa = (action: () => void) => reports.data?.exportSecurity.requiresFreshMfa && !reports.data.exportSecurity.satisfied ? stepUp() : action();
  const classify = useMutation({
    mutationFn: () => {
      const revision = current!.revision;
      const input: AiSystemClassificationInput = {
        expectedRevision: revision.revision,
        expectedRevisionSha256: revision.revisionSha256,
        prohibitedPracticeCheck: {
          decision: reviewClassification === 'prohibited' ? 'blocked' : 'clear',
          articleRefs: ['Article 5'],
          rationale: reviewClassification === 'prohibited' ? 'Independent review identified a prohibited practice.' : 'Independent reviewer confirmed the Article 5 screening for the stated intended purpose.',
        },
        classification: {
          classification: reviewClassification,
          articleRefs: splitList(reviewRefs),
          annexRefs: [],
          rationale: reviewRationale.trim(),
          legalReviewRequired: reviewLegalRequired,
          nextReviewAt: new Date(reviewDate).toISOString(),
          ...(reviewClassification === 'high_risk' ? { highRiskBasis: reviewHighRiskBasis.trim() } : {}),
        },
      };
      return classifyAiSystem(revision.aiSystemId, input);
    },
    onSuccess: async result => { setReviewOpen(false); await refresh(result.aiSystem.revision.aiSystemId); },
    onError: error => { if (isMfaError(error)) stepUp(); },
  });
  const release = useMutation({
    mutationFn: () => {
      const revision = current!.revision;
      const report = verifiedReports.find(item => item.id === releaseReportId)!;
      return releaseAiSystem(revision.aiSystemId, {
        expectedRevision: revision.revision,
        expectedRevisionSha256: revision.revisionSha256,
        decisionRationale: releaseRationale.trim(),
        evidence: [{ evidenceType: 'report', evidenceId: report.id, sha256: report.packDigest! }],
      });
    },
    onSuccess: async result => { setReleaseOpen(false); await refresh(result.aiSystem.revision.aiSystemId); },
    onError: error => { if (isMfaError(error)) stepUp(); },
  });

  if (registry.isLoading) return <LoadingState label="Loading AI-system registry…" />;
  if (registry.error) return <ErrorState error={registry.error} />;
  return <div className="ai-registry-workspace">
    <section className="ai-registry-hero panel"><div><span className="eyebrow">EU AI ACT · SYSTEM REGISTRY</span><h2>Govern the complete AI-system lifecycle</h2><p>Register intended purpose, accountable organisations, immutable components and the applicable control baseline before production release.</p></div><div className="ai-registry-metrics"><span><b>{systems.length}</b> systems</span><span><b>{systems.filter(system => system.lifecycleState === 'released').length}</b> released</span><span><b>{systems.filter(system => system.lifecycleState === 'blocked').length}</b> blocked</span></div><button className="button button-primary" type="button" disabled={!catalog.data} onClick={() => setRegisterOpen(true)}><Plus size={15} />Register AI system</button></section>
    <section className="ai-registry-layout">
      <aside className="panel ai-system-list"><header><div><span className="eyebrow">REGISTERED SYSTEMS</span><h3>Immutable revisions</h3></div><button className="icon-button" type="button" aria-label="Refresh AI-system registry" onClick={() => void registry.refetch()}><RefreshCw size={14} /></button></header>{systems.length ? systems.map(system => <RegistryCard key={system.aiSystemId} item={system} selected={system.aiSystemId === selectedId} onSelect={() => setSelectedId(system.aiSystemId)} />) : <EmptyState title="No AI systems registered" description="Start with intended purpose, responsibility and exact component revisions." />}</aside>
      <main className="ai-system-detail">
        {!selectedId ? <section className="panel"><EmptyState title="Register the first governed AI system" description="The guided flow creates an immutable draft and surfaces every remaining release gate." /></section> : detail.isLoading ? <LoadingState label="Evaluating registration readiness…" /> : detail.error ? <ErrorState error={detail.error} /> : current && <>
          <section className="panel ai-system-summary">
            <header><span className="ai-system-icon"><Layers3 size={20} /></span><div><span className="eyebrow">{humanize(current.revision.classification.classification)} · REVISION {current.revision.revision}</span><h2>{current.revision.displayName}</h2><p>{current.revision.intendedPurpose}</p></div><span className={`ai-system-state state-${current.revision.lifecycleState}`}><i />{humanize(current.revision.lifecycleState)}</span></header>
            <dl><div><dt>Owner</dt><dd>{current.revision.owner.displayName ?? current.revision.owner.actorId}</dd></div><div><dt>Regions</dt><dd>{current.revision.regions.join(', ')}</dd></div><div><dt>Market roles</dt><dd>{current.revision.marketRoles.map(role => humanize(role.role)).join(', ')}</dd></div><div><dt>Revision digest</dt><dd><code title={current.revision.revisionSha256}>{shortDigest(current.revision.revisionSha256)}</code></dd></div></dl>
            <footer><span><ShieldCheck size={13} />Server-enforced SSO, MFA, four-eyes and optimistic revision lock</span><div>{current.allowedActions.includes('classify') && <button className="button button-secondary" type="button" onClick={() => { setReviewClassification(current.revision.classification.classification === 'assessment_required' ? 'minimal_or_no_risk' : current.revision.classification.classification); setReviewRationale(current.revision.classification.rationale); setReviewRefs(current.revision.classification.articleRefs.join(', ') || 'Article 6'); setReviewHighRiskBasis(current.revision.classification.highRiskBasis ?? ''); setReviewLegalRequired(false); setReviewDate(new Date(current.revision.classification.nextReviewAt).toISOString().slice(0, 16)); setReviewOpen(true); }}><ClipboardCheck size={14} />Independent classification</button>}{current.allowedActions.includes('release') && <button className="button button-primary" type="button" disabled={!ledger.data?.releaseReady} title={ledger.data?.releaseReady ? 'All production-blocking controls are satisfied' : ledger.data?.blockingReasons[0] ?? 'Control ledger is loading'} onClick={() => withFreshMfa(() => setReleaseOpen(true))}><Rocket size={14} />Release revision</button>}</div></footer>
          </section>
          <section className="panel ai-control-matrix"><header><div><span className="eyebrow">CONTROL &amp; READINESS MATRIX</span><h2>{current.readiness.evidenceCoverage.satisfied}/{current.readiness.evidenceCoverage.applicable} gates satisfied</h2><p>Every state is calculated for revision {current.revision.revision}; no browser-only approval state is trusted.</p></div><div className="ai-coverage-ring" style={{ '--coverage': `${Math.round(current.readiness.evidenceCoverage.satisfied / Math.max(current.readiness.evidenceCoverage.applicable, 1) * 100)}%` } as CSSProperties}><b>{Math.round(current.readiness.evidenceCoverage.satisfied / Math.max(current.readiness.evidenceCoverage.applicable, 1) * 100)}%</b></div></header>
            <div className="ai-control-grid">{current.readiness.steps.map(step => <article className={`status-${step.status}`} key={step.stepId}><span>{step.status === 'complete' ? <CheckCircle2 size={16} /> : step.blocking ? <ShieldAlert size={16} /> : <AlertTriangle size={16} />}</span><div><small>{humanize(step.status)}</small><h3>{step.title}</h3>{step.issues.map(issue => <p key={issue}>{issue}</p>)}</div></article>)}</div>
            <footer><ShieldCheck size={14} /><span>{current.readiness.claimBoundary}</span></footer>
          </section>
          {ledger.isLoading ? <LoadingState label="Loading legal control ledger…" /> : ledger.error ? <ErrorState error={ledger.error} /> : ledger.data && <section className="panel ai-legal-control-ledger">
            <header><div><span className="eyebrow">LEGAL CONTROL LEDGER · {ledger.data.catalog.catalogId} V{ledger.data.catalog.catalogVersion}</span><h2>{ledger.data.coverage.satisfied}/{ledger.data.coverage.applicable} applicable controls satisfied</h2><p>Article-level decisions are append-only and bound to {ledger.data.assessmentSourceRevision.relation === 'release_source' ? `release source revision ${ledger.data.assessmentSourceRevision.revision}; immutable release revision ${ledger.data.revision} retains that provenance` : `revision ${ledger.data.revision}`}. Production remains {ledger.data.releaseReady ? 'eligible for release' : 'blocked'}.</p></div><div className={`ai-release-verdict${ledger.data.releaseReady ? ' is-ready' : ''}`}><ShieldCheck size={17} /><span>{ledger.data.releaseReady ? 'Release ready' : `${ledger.data.blockingReasons.length} blockers`}</span></div></header>
            <div className="ai-legal-control-grid">{ledger.data.controls.map(control => <article className={`status-${control.effectiveStatus}${control.releaseBlocking ? ' is-release-blocking' : ''}`} key={control.definition.controlId}><header><div><span>{control.definition.articleRefs.join(' · ')}</span><h3>{control.definition.title}</h3></div><span className="ai-control-status">{control.expired ? 'expired' : humanize(control.effectiveStatus)}</span></header><p>{control.definition.description}</p><dl><div><dt>Applicability</dt><dd>{control.applicable ? humanize(control.definition.applicability) : 'not applicable'}</dd></div><div><dt>Owner</dt><dd>{control.assessment ? `${humanize(control.assessment.ownerParty)} · ${control.assessment.ownerId}` : 'Unassigned'}</dd></div><div><dt>Evidence</dt><dd>{control.assessment?.evidence.length ?? 0} verified refs</dd></div><div><dt>Enforcement</dt><dd>{humanize(control.definition.enforcement)}</dd></div></dl>{control.issues[0] && <small>{control.issues[0]}</small>}<footer><span>{control.definition.blocksProduction ? <><ShieldAlert size={12} />Production gate</> : 'Monitoring control'}</span>{current.allowedActions.includes('assess_controls') && <button className="button button-secondary" type="button" onClick={() => withFreshMfa(() => setControlId(control.definition.controlId))}>{control.assessment ? 'Update assessment' : 'Assess control'}</button>}</footer></article>)}</div>
            <footer><Fingerprint size={14} /><span>Catalog digest <code title={ledger.data.catalog.catalogSha256}>{shortDigest(ledger.data.catalog.catalogSha256)}</code> · {ledger.data.claimBoundary}</span></footer>
          </section>}
          <section className="ai-system-evidence-grid">
            <article className="panel"><header><Boxes size={17} /><div><span className="eyebrow">PINNED COMPOSITION</span><h3>{current.revision.componentBindings.length} components</h3></div></header><div className="ai-binding-list">{current.revision.componentBindings.map(component => <div key={`${component.resourceType}:${component.resourceId}`}><span>{humanize(component.resourceType)}</span><b>{component.resourceId}</b><small>rev {component.revision}</small><code title={component.sha256}>{shortDigest(component.sha256)}</code></div>)}</div></article>
            <article className="panel"><header><UsersRound size={17} /><div><span className="eyebrow">SHARED RESPONSIBILITY</span><h3>Customer actions</h3></div></header>{current.readiness.customerResponsibilities.length ? <div className="ai-responsibility-list">{current.readiness.customerResponsibilities.map(item => <div key={item.responsibilityId}><span className={`status-${item.status}`}>{item.status}</span><b>{item.title}</b><small>{humanize(item.ownerRole)}{item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleDateString()}` : ''}</small></div>)}</div> : <EmptyState title="No open customer responsibility" description="No responsibility item is projected for this revision." />}</article>
          </section>
        </>}
      </main>
    </section>
    {registerOpen && catalog.data && <RegistrationDialog catalog={catalog.data.catalog} onClose={() => setRegisterOpen(false)} onCreated={async system => { setRegisterOpen(false); await refresh(system.aiSystemId); }} />}
    {selectedControl && current && <ControlAssessmentDialog control={selectedControl} revision={current.revision} reports={verifiedReports} onClose={() => setControlId('')} onRecorded={() => refresh(current.revision.aiSystemId)} onMfa={stepUp} />}
    {reviewOpen && current && <div className="compliance-layer" role="presentation" onMouseDown={() => setReviewOpen(false)}><section className="compliance-dialog ai-decision-dialog" role="dialog" aria-modal="true" aria-label="Independent classification" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">FOUR-EYES DECISION · REVISION {current.revision.revision}</span><h2>Confirm classification</h2></div><button type="button" aria-label="Close classification dialog" onClick={() => setReviewOpen(false)}><X size={16} /></button></header><form onSubmit={event => { event.preventDefault(); withFreshMfa(() => classify.mutate()); }}><div className="ai-guidance"><KeyRound size={17} /><p><b>A different authorized reviewer must submit this decision.</b> SSO identity, fresh MFA, exact revision digest and the decision rationale become canonical audit evidence.</p></div><label><span>Final classification</span><select aria-label="Final AI-system classification" value={reviewClassification} onChange={event => setReviewClassification(event.target.value as AiSystemClassification)}>{CLASSIFICATIONS.filter(value => value !== 'assessment_required').map(value => <option value={value} key={value}>{humanize(value)}</option>)}</select></label><label><span>Article references</span><input aria-label="Final classification references" value={reviewRefs} onChange={event => setReviewRefs(event.target.value)} /></label>{reviewClassification === 'high_risk' && <label><span>High-risk legal basis</span><textarea aria-label="Independent high-risk legal basis" value={reviewHighRiskBasis} onChange={event => setReviewHighRiskBasis(event.target.value)} /></label>}<label><span>Decision rationale</span><textarea aria-label="Independent classification rationale" value={reviewRationale} onChange={event => setReviewRationale(event.target.value)} /></label><label><span>Next review</span><input aria-label="Independent classification next review" type="datetime-local" value={reviewDate} onChange={event => setReviewDate(event.target.value)} /></label><label className="ai-checkbox"><input type="checkbox" checked={reviewLegalRequired} onChange={event => setReviewLegalRequired(event.target.checked)} /><span>Keep external legal review required (blocks release)</span></label>{classify.error && <p className="decision-error">{classify.error.message}</p>}<footer><button className="button button-secondary" type="button" onClick={() => setReviewOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!reviewRationale.trim() || (reviewClassification === 'high_risk' && !reviewHighRiskBasis.trim()) || classify.isPending}>{classify.isPending ? 'Recording…' : 'Record independent decision'}</button></footer></form></section></div>}
    {releaseOpen && current && <div className="compliance-layer" role="presentation" onMouseDown={() => setReleaseOpen(false)}><section className="compliance-dialog ai-decision-dialog" role="dialog" aria-modal="true" aria-label="Release AI system" onMouseDown={event => event.stopPropagation()}><header><div><span className="eyebrow">PRODUCTION RELEASE · REVISION {current.revision.revision}</span><h2>Bind verified evidence</h2></div><button type="button" aria-label="Close release dialog" onClick={() => setReleaseOpen(false)}><X size={16} /></button></header><form onSubmit={event => { event.preventDefault(); withFreshMfa(() => release.mutate()); }}><div className="ai-guidance"><Rocket size={17} /><p><b>This is a critical governance decision.</b> Argus re-verifies the report digest server-side, requires a different reviewer and prevents stale-revision release.</p></div><label><span>Signed evidence report</span><select aria-label="Release evidence report" value={releaseReportId} onChange={event => setReleaseReportId(event.target.value)}>{verifiedReports.length ? verifiedReports.map(report => <option value={report.id} key={report.id}>{report.name} · {report.environment} · {shortDigest(report.packDigest!)}</option>) : <option value="">No verified signed report available</option>}</select></label><label><span>Release rationale</span><textarea aria-label="Release rationale" value={releaseRationale} onChange={event => setReleaseRationale(event.target.value)} /></label>{release.error && <p className="decision-error">{release.error.message}</p>}<footer><button className="button button-secondary" type="button" onClick={() => setReleaseOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={!releaseReportId || !releaseRationale.trim() || release.isPending}>{release.isPending ? 'Verifying…' : 'Release immutable revision'}</button></footer></form></section></div>}
  </div>;
}

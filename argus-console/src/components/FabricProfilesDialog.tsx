import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Download,
  GitCompareArrows,
  History,
  Layers3,
  Link2,
  PackageCheck,
  Plus,
  RefreshCw,
  ShieldCheck,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  applyFabricProfileRestore,
  applyFabricProfileImport,
  checkFabricProfileDrift,
  decideFabricProfileRestore,
  exportFabricProfile,
  getFabricProfiles,
  getFabricProfileVersionDiff,
  getFabricProfileVersions,
  getFabricProfileRestoreRequests,
  previewFabricProfileImport,
  requestFabricProfileRestore,
} from '../api';
import type {
  FabricManagementBackend,
  FabricManagementBundle,
  FabricManagementSkill,
  FabricProfileManifest,
  FabricProfileDrift,
  FabricProfileRecord,
  FabricProfileVersionRecord,
} from '../types';
import { EmptyState, ErrorState, LoadingState, timeAgo } from './Ui';

type ProfileView = 'saved' | 'create' | 'import' | 'history';
type ProfileMappings = {
  backends: Record<string, string>;
  skills: Record<string, string>;
  groups: Record<string, string>;
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128);
}

function parseManifest(value: string): FabricProfileManifest | null {
  try {
    const parsed = JSON.parse(value) as Partial<FabricProfileManifest>;
    return parsed && parsed.kind === 'FabricProfile' ? parsed as FabricProfileManifest : null;
  } catch {
    return null;
  }
}

function downloadManifest(name: string, version: string, manifest: FabricProfileManifest, revision?: number) {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}-${version}${revision ? `-r${revision}` : ''}.fabric-profile.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FabricProfilesDialog({
  bundles,
  backends,
  skills,
  onClose,
  onApplied,
}: {
  bundles: FabricManagementBundle[];
  backends: FabricManagementBackend[];
  skills: FabricManagementSkill[];
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<ProfileView>('saved');
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [createComposite, setCreateComposite] = useState(true);
  const [groupAliases, setGroupAliases] = useState('');
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const [manifestText, setManifestText] = useState('');
  const [mappings, setMappings] = useState<ProfileMappings>({ backends: {}, skills: {}, groups: {} });
  const [localError, setLocalError] = useState<string | null>(null);
  const [driftByProfile, setDriftByProfile] = useState<Record<number, FabricProfileDrift>>({});
  const [historyProfile, setHistoryProfile] = useState<FabricProfileRecord | null>(null);
  const [fromRevision, setFromRevision] = useState<number | null>(null);
  const [toRevision, setToRevision] = useState<number | null>(null);
  const [restoreComment, setRestoreComment] = useState('');
  const [decisionComment, setDecisionComment] = useState('');
  const profiles = useQuery({ queryKey: ['mcp-fabric', 'profiles'], queryFn: getFabricProfiles });
  const versions = useQuery({
    queryKey: ['mcp-fabric', 'profiles', historyProfile?.id, 'versions'],
    queryFn: () => getFabricProfileVersions(historyProfile!.id),
    enabled: historyProfile != null && view === 'history',
  });
  const versionDiff = useQuery({
    queryKey: ['mcp-fabric', 'profiles', historyProfile?.id, 'diff', fromRevision, toRevision],
    queryFn: () => getFabricProfileVersionDiff(historyProfile!.id, fromRevision!, toRevision!),
    enabled: historyProfile != null && fromRevision != null && toRevision != null && fromRevision !== toRevision && view === 'history',
  });
  const restoreRequests = useQuery({
    queryKey: ['mcp-fabric', 'profiles', historyProfile?.id, 'restores'],
    queryFn: () => getFabricProfileRestoreRequests(historyProfile!.id),
    enabled: historyProfile != null && view === 'history',
  });
  const parsedManifest = useMemo(() => parseManifest(manifestText), [manifestText]);

  const createProfile = useMutation({
    mutationFn: exportFabricProfile,
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles'] });
      setView('saved');
      setLabel('');
      setName('');
      setNameTouched(false);
      setDescription('');
      setGroupAliases('');
      setBundleIds([]);
      onApplied(`Bundle Set “${result.profile.label}” saved as a secret-free, portable profile.`);
    },
  });
  const preview = useMutation({ mutationFn: previewFabricProfileImport });
  const driftCheck = useMutation({
    mutationFn: async (profileId: number) => ({ profileId, result: await checkFabricProfileDrift(profileId) }),
    onSuccess: ({ profileId, result }) => {
      setDriftByProfile(current => ({ ...current, [profileId]: result.drift }));
    },
  });
  const applyProfile = useMutation({
    mutationFn: applyFabricProfileImport,
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
      onApplied(`Bundle Set “${result.profile.label}” applied to ${result.bundleIds.length} bundle${result.bundleIds.length === 1 ? '' : 's'}${result.groupBindings.length ? ` and ${result.groupBindings.length} SSO group${result.groupBindings.length === 1 ? '' : 's'}` : result.compositeId ? ' with team access' : ''}.`);
      onClose();
    },
  });
  const requestRestore = useMutation({
    mutationFn: async (versionRecord: FabricProfileVersionRecord) => {
      if (!historyProfile) throw new Error('Choose a Bundle Set first');
      const mappings = versionRecord.appliedMappings ?? {};
      const result = await previewFabricProfileImport({ manifest: versionRecord.manifest, mappings });
      if (result.plan.blockers.length > 0) {
        throw new Error(`Restore is blocked: ${result.plan.blockers.map(blocker => blocker.message).join(' · ')}`);
      }
      return requestFabricProfileRestore(historyProfile.id, {
        targetRevision: versionRecord.revision,
        mappings,
        planToken: result.plan.planToken,
        comment: restoreComment.trim(),
      });
    },
    onSuccess: async result => {
      setRestoreComment('');
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles', result.request.profileId, 'restores'] });
      onApplied(`Restore of “${result.request.profileLabel}” to r${result.request.targetRevision} is waiting for a second policy admin.`);
    },
  });
  const decideRestore = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      decideFabricProfileRestore(id, { decision, comment: decisionComment.trim() }),
    onSuccess: async result => {
      setDecisionComment('');
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles', result.request.profileId, 'restores'] });
      onApplied(`Restore request ${result.request.status}.`);
    },
  });
  const applyRestore = useMutation({
    mutationFn: applyFabricProfileRestore,
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles', result.profile.id, 'versions'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'profiles', result.profile.id, 'restores'] }),
      ]);
      onApplied(`Bundle Set “${result.profile.label}” restored from r${result.restoreRequest.targetRevision}; new immutable head is r${result.profile.revision}.`);
    },
  });

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !createProfile.isPending && !applyProfile.isPending) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [applyProfile.isPending, createProfile.isPending, onClose]);

  const resetImportPlan = () => {
    preview.reset();
    applyProfile.reset();
    setLocalError(null);
  };
  const openImportManifest = (manifest?: FabricProfileManifest) => {
    const nextText = manifest ? JSON.stringify(manifest, null, 2) : manifestText;
    setView('import');
    setManifestText(nextText);
    setMappings({ backends: {}, skills: {}, groups: {} });
    resetImportPlan();
    if (manifest) preview.mutate({ manifest, mappings: {} });
  };
  const openImport = (profile?: FabricProfileRecord) => openImportManifest(profile?.manifest);
  const openHistory = (profile: FabricProfileRecord) => {
    setHistoryProfile(profile);
    setFromRevision(profile.revision > 1 ? profile.revision - 1 : null);
    setToRevision(profile.revision);
    setView('history');
  };
  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    const aliases = [...new Set(groupAliases.split(',').map(slugify).filter(Boolean))];
    createProfile.mutate({
      name,
      label,
      description,
      version,
      bundleIds,
      createComposite,
      groupBindings: createComposite
        ? aliases.map(logicalName => ({ logicalName, required: true }))
        : [],
    });
  };
  const runPreview = () => {
    resetImportPlan();
    if (!parsedManifest) {
      setLocalError('Choose a valid FabricProfile JSON file or paste its manifest.');
      return;
    }
    preview.mutate({ manifest: parsedManifest, mappings });
  };
  const applyPreview = () => {
    if (!preview.data || preview.data.plan.blockers.length > 0) return;
    applyProfile.mutate({
      manifest: preview.data.plan.manifest,
      mappings,
      planToken: preview.data.plan.planToken,
    });
  };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    resetImportPlan();
    setManifestText(await file.text());
    event.target.value = '';
  };
  const updateMapping = (kind: keyof ProfileMappings, key: string, value: string) => {
    setMappings(current => ({ ...current, [kind]: { ...current[kind], [key]: value } }));
    resetImportPlan();
  };
  const manifestSkills = parsedManifest
    ? [...new Set(parsedManifest.spec.bundles.flatMap(bundle => bundle.skills))]
    : [];
  const manifestGroupBindings = parsedManifest?.spec.access?.groupBindings ?? [];
  const knownGroups = profiles.data?.groups ?? [];

  return (
    <div className="editor-layer" role="presentation" onMouseDown={() => !createProfile.isPending && !applyProfile.isPending && onClose()}>
      <section className="fabric-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="fabric-profile-title" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header fabric-profile-header">
          <div className="fabric-profile-title">
            <span><Layers3 size={21} /></span>
            <div>
              <span className="eyebrow">MCP FABRIC · PORTABLE GOVERNANCE</span>
              <h2 id="fabric-profile-title">Bundle Sets</h2>
              <p>Give every team the same backends, tool policies, skills and access boundary—without exporting secrets.</p>
            </div>
          </div>
          <button className="editor-close" type="button" aria-label="Close Bundle Sets" disabled={createProfile.isPending || applyProfile.isPending} onClick={onClose}><X size={17} /></button>
        </header>

        <nav className="fabric-profile-tabs" aria-label="Bundle Set actions">
          <button type="button" className={view === 'saved' ? 'is-active' : ''} onClick={() => setView('saved')}><PackageCheck size={14} />Saved sets</button>
          <button type="button" className={view === 'create' ? 'is-active' : ''} onClick={() => setView('create')}><Plus size={14} />Create from Fabric</button>
          <button type="button" className={view === 'import' ? 'is-active' : ''} onClick={() => openImport()}><Upload size={14} />Import & apply</button>
          {historyProfile && <button type="button" className={view === 'history' ? 'is-active' : ''} onClick={() => setView('history')}><History size={14} />Version history</button>}
          <span><ShieldCheck size={13} />Credentials stay local</span>
        </nav>

        <div className="fabric-profile-body">
          {view === 'saved' && (
            <div className="fabric-profile-library">
              <div className="fabric-profile-intro">
                <div><span className="eyebrow">TEAM BASELINES</span><h3>Reusable Fabric configurations</h3><p>Download a reviewed set for another Argus environment, or preview it against the connections available here.</p></div>
                <button className="button button-primary" type="button" onClick={() => setView('create')}><Plus size={14} />Create Bundle Set</button>
              </div>
              {profiles.isLoading ? <LoadingState label="Loading Bundle Sets…" /> : profiles.error ? <ErrorState error={profiles.error} /> : profiles.data?.profiles.length ? (
                <div className="fabric-profile-grid">
                  {profiles.data.profiles.map(profile => {
                    const observedDrift = driftByProfile[profile.id] ?? profile.drift;
                    const driftIsCurrent = observedDrift != null
                      && observedDrift.profileRevision === profile.revision
                      && observedDrift.manifestDigest === profile.manifestDigest;
                    return (
                    <article className="fabric-profile-card" key={profile.id}>
                      <header><span><Layers3 size={16} /></span><div><small>{profile.source.toUpperCase()} · V{profile.manifestVersion}</small><h3>{profile.label}</h3></div><b>r{profile.revision}</b></header>
                      <p>{profile.description || 'Portable backend bundle and policy baseline.'}</p>
                      <div className="fabric-profile-card-facts">
                        <span><b>{profile.manifest.spec.bundles.length}</b> bundles</span>
                        <span><b>{profile.manifest.spec.connectors.length}</b> connector slots</span>
                        <span><b>{profile.manifest.spec.access?.groupBindings?.length ?? 0}</b> SSO aliases</span>
                        <span>{profile.lastAppliedAt ? `Applied ${timeAgo(profile.lastAppliedAt)}` : `Updated ${timeAgo(profile.updatedAt)}`}</span>
                      </div>
                      {observedDrift && driftIsCurrent && (
                        <div className={`fabric-profile-drift is-${observedDrift.status}`}>
                          {observedDrift.status === 'in_sync' ? <ShieldCheck size={13} /> : observedDrift.status === 'drifted' ? <AlertTriangle size={13} /> : <Layers3 size={13} />}
                          <span>
                            <b>{observedDrift.status === 'in_sync' ? 'In sync' : observedDrift.status === 'drifted' ? 'Drift detected' : profile.lastAppliedAt ? 'Verification pending' : 'Saved baseline'}</b>
                            <small>{observedDrift.status === 'drifted'
                              ? `${observedDrift.counts.total} finding${observedDrift.counts.total === 1 ? '' : 's'} · ${observedDrift.findings.slice(0, 2).map(finding => finding.message).join(' · ')}`
                              : observedDrift.status === 'in_sync' ? `Checked ${timeAgo(observedDrift.checkedAt)}${'source' in observedDrift && observedDrift.source === 'scheduled' ? ' automatically' : ''}` : 'Apply this set before checking live configuration drift.'}</small>
                            {'consecutiveFailures' in observedDrift
                              && typeof observedDrift.consecutiveFailures === 'number'
                              && observedDrift.consecutiveFailures > 0
                              && <small className="is-warning">Automatic verification delayed · retaining last verified state</small>}
                          </span>
                        </div>
                      )}
                      {observedDrift && !driftIsCurrent && (
                        <div className="fabric-profile-drift is-not_applied"><RefreshCw size={13} /><span><b>Check required</b><small>The Bundle Set revision changed after the last drift observation.</small></span></div>
                      )}
                      {driftCheck.isError && driftCheck.variables === profile.id && <div className="fabric-profile-drift is-drifted"><AlertTriangle size={13} /><span><b>Drift check failed</b><small>{driftCheck.error.message}</small></span></div>}
                      <footer>
                        <button type="button" onClick={() => downloadManifest(profile.name, profile.manifestVersion, profile.manifest)}><Download size={13} />Download JSON</button>
                        <button type="button" onClick={() => openHistory(profile)}><History size={13} />History</button>
                        <button type="button" disabled={driftCheck.isPending && driftCheck.variables === profile.id} onClick={() => driftCheck.mutate(profile.id)}><RefreshCw size={13} className={driftCheck.isPending && driftCheck.variables === profile.id ? 'spin' : ''} />Check drift</button>
                        <button type="button" onClick={() => openImport(profile)}>Review & apply <Link2 size={13} /></button>
                      </footer>
                    </article>
                    );
                  })}
                </div>
              ) : <EmptyState title="No Bundle Sets yet" description="Capture one or more existing bundles as a portable team baseline." />}
            </div>
          )}

          {view === 'history' && historyProfile && (
            <div className="fabric-profile-history">
              <section className="fabric-profile-history-head">
                <div><span className="eyebrow">IMMUTABLE REVISION LEDGER</span><h3>{historyProfile.label}</h3><p>Every saved or applied Bundle Set is preserved with its exact manifest digest.</p></div>
                <button className="button button-secondary" type="button" onClick={() => setView('saved')}>Back to saved sets</button>
              </section>
              {versions.isLoading ? <LoadingState label="Loading version history…" /> : versions.error ? <ErrorState error={versions.error} /> : (
                <>
                  <section className="fabric-profile-version-list" aria-label="Bundle Set version history">
                    {versions.data?.versions.map(item => (
                      <article key={item.id} className={item.revision === historyProfile.revision ? 'is-current' : ''}>
                        <span><b>r{item.revision}</b><small>v{item.manifestVersion} · {item.changeKind}</small></span>
                        <span><code>{item.manifestDigest.slice(0, 12)}</code><small>{item.createdBy ?? 'system'} · {timeAgo(item.createdAt)}</small></span>
                        <span className={item.applied ? 'is-applied' : ''}>{item.applied ? 'Applied' : 'Saved'}</span>
                        <button type="button" onClick={() => downloadManifest(historyProfile.name, item.manifestVersion, item.manifest, item.revision)}><Download size={13} />JSON</button>
                        {item.revision === historyProfile.revision
                          ? <span className="fabric-profile-current-head"><ShieldCheck size={13} />Current head</span>
                          : <button type="button" disabled={requestRestore.isPending} onClick={() => requestRestore.mutate(item)}><History size={13} />Request restore</button>}
                      </article>
                    ))}
                  </section>
                  {(versions.data?.versions.length ?? 0) > 1 ? (
                    <section className="fabric-profile-version-diff">
                      <header><div><span className="eyebrow">SERVER-SIDE DIFF</span><h3>Compare exact revisions</h3></div><GitCompareArrows size={18} /></header>
                      <div className="fabric-profile-version-selectors">
                        <label><span>From</span><select value={fromRevision ?? ''} onChange={event => setFromRevision(Number(event.target.value))}>{versions.data!.versions.map(item => <option value={item.revision} key={item.revision}>r{item.revision} · v{item.manifestVersion}</option>)}</select></label>
                        <GitCompareArrows size={16} />
                        <label><span>To</span><select value={toRevision ?? ''} onChange={event => setToRevision(Number(event.target.value))}>{versions.data!.versions.map(item => <option value={item.revision} key={item.revision}>r{item.revision} · v{item.manifestVersion}</option>)}</select></label>
                      </div>
                      {fromRevision === toRevision ? <div className="fabric-profile-warning"><AlertTriangle size={14} />Choose two different revisions.</div> : versionDiff.isLoading ? <LoadingState label="Comparing revisions…" /> : versionDiff.error ? <ErrorState error={versionDiff.error} /> : versionDiff.data?.diff && (
                        <div className="fabric-profile-diff-result">
                          <div className="fabric-profile-diff-counts"><span><b>{versionDiff.data.diff.counts.total}</b> total</span><span><b>{versionDiff.data.diff.counts.added}</b> added</span><span><b>{versionDiff.data.diff.counts.removed}</b> removed</span><span><b>{versionDiff.data.diff.counts.changed}</b> changed</span></div>
                          {versionDiff.data.diff.changes.length ? <ul>{versionDiff.data.diff.changes.map((change, index) => <li key={`${change.scope}-${change.resource}-${index}`} className={`is-${change.kind}`}><b>{change.kind}</b><span>{change.scope} · {change.resource}</span><code>{change.field}</code></li>)}</ul> : <div className="fabric-profile-diff-empty"><ShieldCheck size={14} />The selected revisions have identical desired state.</div>}
                          {versionDiff.data.diff.truncated && <small>Showing the first 200 changes.</small>}
                        </div>
                      )}
                    </section>
                  ) : <EmptyState title="First immutable revision" description="The next save or apply will create another revision that can be compared here." />}
                  <section className="fabric-profile-version-diff fabric-profile-restore-panel">
                    <header><div><span className="eyebrow">APPROVAL-GATED RESTORE</span><h3>Restore a reviewed revision</h3><p>A historical manifest is dry-run again, bound to the current head, and must be approved by a different policy admin.</p></div><ShieldCheck size={18} /></header>
                    <label className="editor-field"><span>Restore request note <small>(optional)</small></span><input maxLength={2000} value={restoreComment} onChange={event => setRestoreComment(event.target.value)} placeholder="Why should this revision become the desired state again?" /></label>
                    {(requestRestore.error || decideRestore.error || applyRestore.error) && <div className="editor-error" role="alert"><AlertTriangle size={14} />{(requestRestore.error ?? decideRestore.error ?? applyRestore.error)?.message}</div>}
                    {restoreRequests.isLoading ? <LoadingState label="Loading restore approvals…" /> : restoreRequests.error ? <ErrorState error={restoreRequests.error} /> : restoreRequests.data?.requests.length ? <div className="fabric-profile-restore-list">
                      {restoreRequests.data.requests.map(request => <article key={request.id} className={`is-${request.status}`}>
                        <div><b>r{request.requestedFromRevision} → r{request.targetRevision}</b><small>{request.requestedByUsername} · {timeAgo(request.requestedAt)}</small></div>
                        <span>{request.status}</span>
                        <code>{request.targetManifestDigest.slice(0, 12)}</code>
                        {request.status === 'pending' && <div className="fabric-profile-restore-decision"><input aria-label={`Decision comment for restore to r${request.targetRevision}`} maxLength={2000} value={decisionComment} onChange={event => setDecisionComment(event.target.value)} placeholder="Approval evidence (required)" /><button type="button" disabled={decisionComment.trim().length < 4 || decideRestore.isPending} onClick={() => decideRestore.mutate({ id: request.id, decision: 'rejected' })}>Reject</button><button type="button" disabled={decisionComment.trim().length < 4 || decideRestore.isPending} onClick={() => decideRestore.mutate({ id: request.id, decision: 'approved' })}>Approve</button></div>}
                        {request.status === 'approved' && <button className="button button-primary" type="button" disabled={applyRestore.isPending} onClick={() => applyRestore.mutate(request.id)}>{applyRestore.isPending ? 'Restoring…' : 'Apply approved restore'}</button>}
                        {request.decisionComment && <small>{request.decidedByUsername}: {request.decisionComment}</small>}
                      </article>)}
                    </div> : <div className="fabric-profile-diff-empty"><ShieldCheck size={14} />No restore requests for this Bundle Set.</div>}
                  </section>
                </>
              )}
            </div>
          )}

          {view === 'create' && (
            <form className="fabric-profile-create" onSubmit={submitCreate}>
              <section>
                <span className="eyebrow">PROFILE IDENTITY</span>
                <h3>Name this team baseline</h3>
                <div className="fabric-profile-form-grid">
                  <label><span>Display name</span><input autoFocus required maxLength={256} value={label} onChange={event => { setLabel(event.target.value); if (!nameTouched) setName(slugify(event.target.value)); }} placeholder="Platform engineering" /></label>
                  <label><span>Stable name</span><input required pattern="[a-z0-9][a-z0-9_-]*" maxLength={128} value={name} onChange={event => { setNameTouched(true); setName(slugify(event.target.value)); }} placeholder="platform-engineering" /></label>
                  <label className="is-wide"><span>Description</span><textarea rows={3} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} placeholder="Standard backends and least-privilege policies for the platform team." /></label>
                  <label><span>Profile version</span><input required pattern="[0-9]+\.[0-9]+\.[0-9]+.*" maxLength={32} value={version} onChange={event => setVersion(event.target.value)} /></label>
                  <label className="fabric-profile-composite"><input type="checkbox" checked={createComposite} onChange={event => setCreateComposite(event.target.checked)} /><span><b>Create team access composite</b><small>Creates one reusable policy target across all bundles in this set.</small></span></label>
                  {createComposite && <label className="is-wide"><span>Portable SSO group aliases <small>(optional, comma-separated)</small></span><input maxLength={2000} value={groupAliases} onChange={event => setGroupAliases(event.target.value)} placeholder="platform-engineers, sre-on-call" /><small>Aliases contain no tenant IDs. Each destination explicitly maps them to its own SSO groups.</small></label>}
                </div>
              </section>
              <section>
                <span className="eyebrow">BUNDLE CONTENTS</span>
                <h3>Select governed bundles</h3>
                <p className="fabric-profile-section-copy">Endpoints and credentials are deliberately excluded. The destination maps connector slots to its own local backends.</p>
                <div className="fabric-profile-bundle-list">
                  {bundles.map(bundle => (
                    <label className={bundleIds.includes(bundle.id) ? 'is-selected' : ''} key={bundle.id}>
                      <input type="checkbox" checked={bundleIds.includes(bundle.id)} onChange={event => setBundleIds(current => event.target.checked ? [...current, bundle.id] : current.filter(id => id !== bundle.id))} />
                      <span><b>{bundle.label}</b><small>{bundle.backendCount} backends · {bundle.toolCount} tools · {bundle.skillIds.length} skills</small></span>
                      <Check size={15} />
                    </label>
                  ))}
                </div>
              </section>
              {createProfile.error && <div className="editor-error" role="alert"><AlertTriangle size={14} />{createProfile.error.message}</div>}
              <footer className="fabric-profile-footer"><span><ShieldCheck size={13} />Secret-free manifest · versioned · auditable</span><div><button className="button button-secondary" type="button" onClick={() => setView('saved')}>Cancel</button><button className="button button-primary" type="submit" disabled={createProfile.isPending || bundleIds.length === 0 || !name || !label}>{createProfile.isPending ? 'Saving…' : <><PackageCheck size={14} />Save Bundle Set</>}</button></div></footer>
            </form>
          )}

          {view === 'import' && (
            <div className="fabric-profile-import">
              <section className="fabric-profile-import-source">
                <div className="fabric-profile-section-heading"><div><span className="eyebrow">PORTABLE MANIFEST</span><h3>Import JSON</h3></div><label className="button button-secondary"><Upload size={14} />Choose file<input type="file" accept="application/json,.json" onChange={readFile} /></label></div>
                <textarea aria-label="Fabric Profile JSON" spellCheck={false} value={manifestText} onChange={event => { setManifestText(event.target.value); resetImportPlan(); }} placeholder={'{\n  "apiVersion": "fabric.argus.dev/v1alpha1",\n  "kind": "FabricProfile"\n}'} />
                {manifestText && !parsedManifest && <div className="fabric-profile-warning"><AlertTriangle size={14} />This is not valid FabricProfile JSON yet.</div>}
              </section>

              {parsedManifest && (
                <section className="fabric-profile-mappings">
                  <span className="eyebrow">LOCAL RESOURCE & SSO MAPPING</span>
                  <h3>{parsedManifest.metadata.label} <small>v{parsedManifest.metadata.version}</small></h3>
                  <p className="fabric-profile-section-copy">Map portable slots to existing local resources. Nothing creates or copies a credential.</p>
                  <div className="fabric-profile-map-list">
                    {parsedManifest.spec.connectors.map(connector => (
                      <label key={connector.slot}><span><Link2 size={13} /><b>{connector.slot}</b><small>{connector.backendType} · expected {connector.backendName}</small></span><select aria-label={`Backend mapping for ${connector.slot}`} value={mappings.backends[connector.slot] ?? connector.backendName} onChange={event => updateMapping('backends', connector.slot, event.target.value)}><option value={connector.backendName}>Match by name: {connector.backendName}</option>{backends.filter(backend => backend.name !== connector.backendName).map(backend => <option value={backend.name} key={backend.id}>{backend.name} · {backend.type}</option>)}</select></label>
                    ))}
                    {manifestSkills.map(skill => (
                      <label key={skill}><span><Layers3 size={13} /><b>{skill}</b><small>required skill</small></span><select aria-label={`Skill mapping for ${skill}`} value={mappings.skills[skill] ?? skill} onChange={event => updateMapping('skills', skill, event.target.value)}><option value={skill}>Match by name: {skill}</option>{skills.filter(item => item.name !== skill).map(item => <option value={item.name} key={item.id}>{item.label}</option>)}</select></label>
                    ))}
                    {manifestGroupBindings.map(binding => {
                      const exactMatch = knownGroups.some(group => group.name === binding.logicalName) ? binding.logicalName : '';
                      const selected = mappings.groups[binding.logicalName] ?? exactMatch;
                      return (
                        <label key={binding.logicalName}>
                          <span><Users size={13} /><b>{binding.logicalName}</b><small>{binding.required ? 'required' : 'optional'} SSO group alias</small></span>
                          <select aria-label={`SSO group mapping for ${binding.logicalName}`} value={selected} onChange={event => updateMapping('groups', binding.logicalName, event.target.value)}>
                            <option value="">{binding.required ? 'Choose local SSO group…' : 'Do not bind in this environment'}</option>
                            {knownGroups.map(group => <option value={group.name} key={group.name}>{group.name} · {group.memberCount} member{group.memberCount === 1 ? '' : 's'}</option>)}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  {manifestGroupBindings.length > 0 && knownGroups.length === 0 && <div className="fabric-profile-warning"><AlertTriangle size={14} />No local SSO/Entra groups are known yet. Sign in through SSO or create a group policy before applying this set.</div>}
                </section>
              )}

              {(localError || preview.error || applyProfile.error) && <div className="editor-error" role="alert"><AlertTriangle size={14} />{localError ?? preview.error?.message ?? applyProfile.error?.message}</div>}
              {preview.data && (
                <section className="fabric-profile-plan">
                  <header><div><span className="eyebrow">DRY-RUN RESULT</span><h3>{preview.data.plan.blockers.length ? 'Resolve import blockers' : 'Ready to apply'}</h3></div><span className={preview.data.plan.blockers.length ? 'is-blocked' : 'is-ready'}>{preview.data.plan.blockers.length ? `${preview.data.plan.blockers.length} blocked` : <><ShieldCheck size={13} />Validated</>}</span></header>
                  <div className="fabric-profile-actions-list">{preview.data.plan.actions.map((action, index) => <span key={`${action.kind}-${action.target}-${index}`}><i>{action.operation}</i><b>{action.target}</b><small>{action.detail}</small></span>)}</div>
                  {preview.data.plan.blockers.length > 0 && <div className="fabric-profile-blockers">{preview.data.plan.blockers.map(blocker => <span key={`${blocker.code}-${blocker.resource}`}><AlertTriangle size={13} />{blocker.message}</span>)}</div>}
                </section>
              )}
              <footer className="fabric-profile-footer"><span><ShieldCheck size={13} />Apply is bound to this exact dry-run and current Fabric state.</span><div><button className="button button-secondary" type="button" disabled={!parsedManifest || preview.isPending || applyProfile.isPending} onClick={runPreview}><RefreshCw size={14} className={preview.isPending ? 'spin' : ''} />{preview.isPending ? 'Checking…' : preview.data ? 'Refresh preview' : 'Preview changes'}</button><button className="button button-primary" type="button" disabled={!preview.data || preview.data.plan.blockers.length > 0 || applyProfile.isPending} onClick={applyPreview}>{applyProfile.isPending ? 'Applying…' : <><Check size={14} />Apply Bundle Set</>}</button></div></footer>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

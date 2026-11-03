import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, Rocket, Save, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { deleteAgentTemplateDraft, previewAgentTemplateDraft, publishAgentTemplateDraft, saveAgentTemplateDraft } from '../api';
import type { AgentStudioCatalog, AgentTemplateDraft, AgentTemplateDraftInput, AgentTemplatePreflight } from '../types';

interface AgentPresetBuilderProps {
  initial: AgentTemplateDraftInput;
  draft?: AgentTemplateDraft | null;
  catalog: Pick<AgentStudioCatalog, 'models' | 'runtimeProfiles' | 'bundles' | 'composites' | 'skills'>;
  onClose: () => void;
  onChanged: (message: string) => Promise<void> | void;
}

function lines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}

export function AgentPresetBuilder({ initial, draft, catalog, onClose, onChanged }: AgentPresetBuilderProps) {
  const [form, setForm] = useState(initial);
  const [savedDraft, setSavedDraft] = useState<AgentTemplateDraft | null>(draft ?? null);
  const [dirty, setDirty] = useState(!draft);
  const [model, setModel] = useState(catalog.models[0]?.model_name ?? '');
  const [runtimeProfileId, setRuntimeProfileId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [preflight, setPreflight] = useState<AgentTemplatePreflight | null>(null);

  useEffect(() => { setPreflight(null); }, [model, runtimeProfileId, bundleId]);

  const update = <K extends keyof AgentTemplateDraftInput>(key: K, value: AgentTemplateDraftInput[K]) => {
    setForm(current => ({ ...current, [key]: value }));
    setDirty(true);
    setPreflight(null);
  };
  const updateConfig = <K extends keyof AgentTemplateDraftInput['config']>(key: K, value: AgentTemplateDraftInput['config'][K]) => {
    setForm(current => ({ ...current, config: { ...current.config, [key]: value } }));
    setDirty(true);
    setPreflight(null);
  };

  const saveMutation = useMutation({
    mutationFn: () => saveAgentTemplateDraft(form),
    onSuccess: async saved => {
      setForm(saved.definition);
      setSavedDraft(saved);
      setDirty(false);
      setPreflight(null);
      await onChanged(`${saved.definition.label} saved as draft for v${saved.targetVersion}.`);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () => previewAgentTemplateDraft(savedDraft!.name, {
      model,
      runtimeProfileId: runtimeProfileId ? Number(runtimeProfileId) : null,
      bundleIds: bundleId ? [Number(bundleId)] : [],
    }),
    onSuccess: setPreflight,
  });
  const publishMutation = useMutation({
    mutationFn: () => publishAgentTemplateDraft(savedDraft!.name),
    onSuccess: async published => {
      await onChanged(`${published.label} published as preset v${published.version}.`);
      onClose();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAgentTemplateDraft(savedDraft!.name),
    onSuccess: async () => {
      await onChanged(`${form.label} draft deleted.`);
      onClose();
    },
  });

  const error = saveMutation.error || previewMutation.error || publishMutation.error || deleteMutation.error;
  const minimumBundles = Number(form.minimumBundleCount || 0);
  const bundleReady = minimumBundles === 0 || Boolean(bundleId);
  const publishReady = Boolean(savedDraft && !dirty && preflight?.selectionValid && preflight.readiness?.ready);
  const busy = saveMutation.isPending || previewMutation.isPending || publishMutation.isPending || deleteMutation.isPending;

  return <div className="agent-preset-builder-backdrop" role="presentation">
    <section className="agent-preset-builder" role="dialog" aria-modal="true" aria-labelledby="agent-preset-builder-title">
      <header>
        <div><small>AGENT PRESET BUILDER · {savedDraft ? `DRAFT v${savedDraft.targetVersion}` : 'NEW DRAFT'}</small><h2 id="agent-preset-builder-title">{savedDraft ? `Edit ${form.label}` : 'Create governed preset'}</h2><p>Author provider-neutral Agent policy, prove one executable environment and publish an immutable version.</p></div>
        <button type="button" aria-label="Close preset builder" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>

      {error && <div className="connection-notice is-error" role="alert"><TriangleAlert size={15} /><span>{error.message}</span></div>}

      <div className="agent-preset-builder-body">
        <form className="agent-preset-definition" onSubmit={event => { event.preventDefault(); saveMutation.mutate(); }}>
          <div className="agent-preset-section-title"><span>1</span><div><b>Definition</b><small>Identity, role and reusable instructions</small></div></div>
          <div className="agent-preset-grid">
            <label><span>Internal name</span><input aria-label="Preset internal name" value={form.name} disabled={Boolean(savedDraft)} onChange={event => update('name', event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} /></label>
            <label><span>Display name</span><input aria-label="Preset display name" value={form.label} onChange={event => update('label', event.target.value)} /></label>
            <label><span>Category</span><input aria-label="Preset category" value={form.category} onChange={event => update('category', event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} /></label>
            <label><span>Agent mode</span><select aria-label="Preset Agent mode" value={form.agentMode} onChange={event => update('agentMode', event.target.value as AgentTemplateDraftInput['agentMode'])}><option value="chat">Chat</option><option value="worker">Worker</option><option value="reviewer">Reviewer</option></select></label>
          </div>
          <label><span>Description</span><textarea aria-label="Preset description" rows={2} value={form.description} onChange={event => update('description', event.target.value)} /></label>
          <label><span>System prompt</span><textarea aria-label="Preset system prompt" rows={7} value={form.config.systemPrompt ?? ''} onChange={event => updateConfig('systemPrompt', event.target.value)} /></label>
          <div className="agent-preset-grid three">
            <label><span>Agent role</span><input aria-label="Preset Agent role" value={form.config.agentRole ?? ''} onChange={event => updateConfig('agentRole', event.target.value)} /></label>
            <label><span>Temperature</span><input aria-label="Preset temperature" type="number" min="0" max="2" step="0.05" value={form.config.temperature ?? 0.3} onChange={event => updateConfig('temperature', Number(event.target.value))} /></label>
            <label><span>Max tokens</span><input aria-label="Preset max tokens" type="number" min="256" max="131072" value={form.config.maxTokens ?? 4096} onChange={event => updateConfig('maxTokens', Number(event.target.value))} /></label>
            <label><span>Max iterations</span><input aria-label="Preset max iterations" type="number" min="1" max="100" value={form.config.maxIterations ?? 10} onChange={event => updateConfig('maxIterations', Number(event.target.value))} /></label>
            <label><span>Policy composite</span><select aria-label="Preset composite" value={form.compositeName ?? ''} onChange={event => update('compositeName', event.target.value || null)}><option value="">No composite</option>{catalog.composites.filter(item => item.enabled).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
            <label><span>Risk level</span><select aria-label="Preset risk level" value={form.config.riskLevel ?? 'low'} onChange={event => updateConfig('riskLevel', event.target.value as 'low' | 'medium' | 'high')}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>

          <div className="agent-preset-section-title"><span>2</span><div><b>Capabilities & governance</b><small>Declare requirements without binding a vendor</small></div></div>
          <div className="agent-preset-grid">
            <label><span>Required tool patterns</span><textarea aria-label="Preset required tool patterns" rows={3} placeholder="*_get_file_contents" value={form.requiredToolPatterns.join('\n')} onChange={event => update('requiredToolPatterns', lines(event.target.value))} /></label>
            <label><span>Capability labels</span><textarea aria-label="Preset capability labels" rows={3} placeholder="repository-read, evidence" value={form.recommendedCapabilities.join('\n')} onChange={event => update('recommendedCapabilities', lines(event.target.value))} /></label>
            <label><span>Used by</span><textarea aria-label="Preset consumers" rows={3} value={form.requiredBy.join('\n')} onChange={event => update('requiredBy', lines(event.target.value))} /></label>
            <label><span>Minimum MCP bundles</span><input aria-label="Preset minimum bundle count" type="number" min="0" max="16" value={form.minimumBundleCount} onChange={event => update('minimumBundleCount', Number(event.target.value))} /></label>
          </div>
          <fieldset className="agent-preset-skills">
            <legend>Reusable skills</legend>
            {catalog.skills.length > 0
              ? catalog.skills.map(skill => <label key={skill.id}><input type="checkbox" checked={form.skillNames.includes(skill.name)} onChange={event => update('skillNames', event.target.checked ? [...form.skillNames, skill.name] : form.skillNames.filter(name => name !== skill.name))} /><span><b>{skill.label}</b><small>{skill.category || skill.name}</small></span></label>)
              : <p>No reusable skills are registered. The preset can still be published without skills.</p>}
          </fieldset>
          <div className="agent-preset-switches">
            <label><input type="checkbox" checked={form.config.untrustedToolOutputEnforcement ?? true} onChange={event => updateConfig('untrustedToolOutputEnforcement', event.target.checked)} /><span>Enforce untrusted tool-output isolation</span></label>
            <label><input type="checkbox" checked={form.config.humanOversightRequired ?? false} onChange={event => updateConfig('humanOversightRequired', event.target.checked)} /><span>Require human oversight</span></label>
            <label><input type="checkbox" checked={form.config.codegraphEnabled ?? false} onChange={event => updateConfig('codegraphEnabled', event.target.checked)} /><span>Enable native code intelligence</span></label>
          </div>
          <button className="button button-secondary" type="submit" disabled={busy || !form.name || !form.label}><Save size={14} />{saveMutation.isPending ? 'Saving…' : dirty ? 'Save draft' : 'Draft saved'}</button>
        </form>

        <aside className="agent-preset-proof">
          <div className="agent-preset-section-title"><span>3</span><div><b>Execution proof</b><small>One real environment must pass before publish</small></div></div>
          {!savedDraft && <div className="agent-preset-proof-empty"><Save size={20} /><b>Save the draft first</b><p>Draft persistence establishes its optimistic base version.</p></div>}
          {savedDraft && <>
            {dirty && <div className="agent-preset-proof-warning"><TriangleAlert size={14} />Save current edits before running preflight.</div>}
            <label><span>Runtime model</span><select aria-label="Draft preflight model" value={model} disabled={dirty || busy} onChange={event => setModel(event.target.value)}>{catalog.models.map(item => <option key={item.model_name} value={item.model_name}>{item.model_name} · {item.provider}</option>)}</select></label>
            <label><span>Execution runtime</span><select aria-label="Draft preflight runtime" value={runtimeProfileId} disabled={dirty || busy} onChange={event => setRuntimeProfileId(event.target.value)}><option value="">Deployment default</option>{(catalog.runtimeProfiles ?? []).filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.label}{item.model ? ` · ${item.model}` : ''}</option>)}</select></label>
            {minimumBundles > 0 && <label><span>MCP bundle</span><select aria-label="Draft preflight bundle" value={bundleId} disabled={dirty || busy} onChange={event => setBundleId(event.target.value)}><option value="">Select bundle</option>{catalog.bundles.map(item => <option key={item.id} value={item.id}>{item.label} · {item.tool_count} tools</option>)}</select></label>}
            <button className="button button-secondary" type="button" disabled={dirty || busy || !model || !bundleReady} onClick={() => previewMutation.mutate()}><FlaskConical size={14} />{previewMutation.isPending ? 'Running preflight…' : 'Run draft preflight'}</button>
            {preflight && <div className={`agent-preset-proof-result is-${preflight.readiness?.status ?? 'blocked'}`}>
              <b>{preflight.readiness?.ready ? <CheckCircle2 size={14} /> : <TriangleAlert size={14} />}{preflight.readiness?.ready ? 'Execution proof passed' : 'Execution proof blocked'}</b>
              <p>{preflight.readiness?.runtime.detail ?? preflight.errors.join(' · ')}</p>
              {preflight.readiness && <small>{preflight.readiness.tools.length} effective tools · {preflight.readiness.blockers.length} blockers · {preflight.readiness.warnings.length} warnings</small>}
            </div>}
          </>}
          <div className="agent-preset-publish-gate">
            <ShieldCheck size={17} /><div><b>Publish gate</b><p>{publishReady ? `Ready to publish immutable v${savedDraft?.targetVersion}.` : 'Save and pass preflight to unlock publish.'}</p></div>
          </div>
          <button className="button button-primary" type="button" disabled={!publishReady || busy} onClick={() => publishMutation.mutate()}><Rocket size={14} />{publishMutation.isPending ? 'Publishing…' : `Publish v${savedDraft?.targetVersion ?? 1}`}</button>
          {savedDraft && <button className="button button-danger" type="button" disabled={busy} onClick={() => deleteMutation.mutate()}><Trash2 size={14} />Delete draft</button>}
        </aside>
      </div>
    </section>
  </div>;
}

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Blocks,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Database,
  GitBranch,
  KeyRound,
  Network,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { getAgentHookConfig } from '../api';
import type {
  AgentStudioCatalog,
  AgentStudioSaveInput,
  ArgusUserRole,
  ManagedAgent,
} from '../types';

interface AgentEditorProps {
  agent: ManagedAgent | null;
  catalog: AgentStudioCatalog;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: AgentStudioSaveInput) => void;
  onDelete: (agent: ManagedAgent) => void;
}

const ROLES: Array<{ value: ArgusUserRole; label: string }> = [
  { value: 'platform_admin', label: 'Platform admin' },
  { value: 'operations_admin', label: 'Operations admin' },
  { value: 'developer', label: 'Developer' },
  { value: 'agent_operator', label: 'Agent operator' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'chat_user', label: 'Chat user' },
];

function stringList(value: string): string[] | null {
  const values = value.split('\n').map(item => item.trim()).filter(Boolean);
  return values.length ? values : null;
}

function toggleId(current: number[], id: number): number[] {
  return current.includes(id) ? current.filter(value => value !== id) : [...current, id];
}

function runtimeChoiceLabel(profile: NonNullable<AgentStudioCatalog['runtimeProfiles']>[number]): string {
  const details = [profile.model || profile.runtime_type, profile.reasoning_effort].filter(Boolean).join(' · ');
  const recommended = profile.runtime_type === 'codex' && profile.model?.includes('codex-spark');
  return `${profile.label} · ${details}${recommended ? ' · recommended' : ''}`;
}

export function AgentEditor({ agent, catalog, busy, error, onClose, onSave, onDelete }: AgentEditorProps) {
  const assignedRuntimeProfile = (catalog.runtimeProfiles ?? []).find(
    profile => profile.id === agent?.runtime_profile_id,
  ) ?? null;
  const defaultRuntimeProfile = agent ? null : (catalog.runtimeProfiles ?? []).find(
    profile => profile.enabled && profile.runtime_type === 'codex' && profile.model?.includes('codex-spark'),
  ) ?? (catalog.runtimeProfiles ?? []).find(profile => profile.enabled) ?? null;
  const [name, setName] = useState(agent?.name ?? '');
  const [label, setLabel] = useState(agent?.label ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [mode, setMode] = useState<ManagedAgent['agent_mode']>(agent?.agent_mode ?? 'chat');
  const [model, setModel] = useState(assignedRuntimeProfile?.model ?? agent?.model ?? defaultRuntimeProfile?.model ?? catalog.models[0]?.model_name ?? '');
  const [temperature, setTemperature] = useState(String(agent?.temperature ?? 0.7));
  const [maxTokens, setMaxTokens] = useState(String(agent?.max_tokens ?? 4096));
  const [maxIterations, setMaxIterations] = useState(String(agent?.max_iterations ?? 10));
  const [thinkingBudget, setThinkingBudget] = useState(String(agent?.thinking_budget ?? 0));
  const [systemPrompt, setSystemPrompt] = useState(agent?.system_prompt ?? '');
  const [agentRole, setAgentRole] = useState(agent?.agent_role ?? '');
  const [visibility, setVisibility] = useState<ManagedAgent['visibility']>(agent?.visibility ?? 'internal');
  const [minRole, setMinRole] = useState<ArgusUserRole | ''>(agent?.min_role ?? '');
  const [riskLevel, setRiskLevel] = useState<ManagedAgent['risk_level']>(agent?.risk_level ?? 'low');
  const [humanOversightRequired, setHumanOversightRequired] = useState(agent?.human_oversight_required ?? false);
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [compositeId, setCompositeId] = useState(agent?.composite_id ? String(agent.composite_id) : '');
  const [bundleIds, setBundleIds] = useState<number[]>(agent?.bundle_ids ?? []);
  const [ragIndexIds, setRagIndexIds] = useState<number[]>(agent?.rag_indexes.map(item => item.id) ?? []);
  const [codeIndexIds, setCodeIndexIds] = useState<number[]>(agent?.code_indexes?.map(item => item.id) ?? []);
  const [skillIds, setSkillIds] = useState<number[]>(agent?.skills.map(item => item.id) ?? []);
  const [taskType, setTaskType] = useState(agent?.task_type ?? '');
  const [bitbucketRepo, setBitbucketRepo] = useState(agent?.bitbucket_repo ?? '');
  const [giteaProject, setGiteaProject] = useState(agent?.gitea_project ?? '');
  const [prBranch, setPrBranch] = useState(agent?.pr_branch ?? '');
  const [prNumber, setPrNumber] = useState(agent?.pr_number == null ? '' : String(agent.pr_number));
  const [ticketId, setTicketId] = useState(agent?.ticket_id ?? '');
  const [allowedPaths, setAllowedPaths] = useState(agent?.allowed_paths?.join('\n') ?? '');
  const [untrustedEnforcement, setUntrustedEnforcement] = useState(agent?.untrusted_tool_output_enforcement ?? true);
  const [codegraphEnabled, setCodegraphEnabled] = useState(agent?.codegraph_enabled ?? false);
  const [hookPatterns, setHookPatterns] = useState('');
  const [hookMaxCalls, setHookMaxCalls] = useState('');
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>(agent?.llm_api_key ? 'keep' : 'replace');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [credentialProfileId, setCredentialProfileId] = useState(agent?.llm_credential_profile_id?.toString() ?? '');
  const [runtimeProfileId, setRuntimeProfileId] = useState(agent?.runtime_profile_id?.toString() ?? defaultRuntimeProfile?.id.toString() ?? '');
  const [validation, setValidation] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteName, setDeleteName] = useState('');

  const hookQuery = useQuery({
    queryKey: ['agent-hook-config', agent?.id],
    queryFn: () => getAgentHookConfig(agent!.id),
    enabled: agent != null,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!hookQuery.data) return;
    setHookPatterns(hookQuery.data.extra_destructive_patterns.join('\n'));
    setHookMaxCalls(hookQuery.data.max_tool_calls == null ? '' : String(hookQuery.data.max_tool_calls));
  }, [hookQuery.data]);

  useEffect(() => {
    document.body.classList.add('has-dialog');
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('has-dialog');
      window.removeEventListener('keydown', onKey);
    };
  }, [busy, onClose]);

  const selectedModel = useMemo(() => catalog.models.find(option => option.model_name === model), [catalog.models, model]);
  const compatibleCredentialProfiles = useMemo(
    () => catalog.credentialProfiles.filter(profile => profile.providerType === selectedModel?.provider),
    [catalog.credentialProfiles, selectedModel?.provider],
  );
  const selectedCredentialProfile = useMemo(
    () => catalog.credentialProfiles.find(profile => profile.id === Number(credentialProfileId)),
    [catalog.credentialProfiles, credentialProfileId],
  );
  const selectedRuntimeProfile = useMemo(
    () => (catalog.runtimeProfiles ?? []).find(profile => profile.id === Number(runtimeProfileId)),
    [catalog.runtimeProfiles, runtimeProfileId],
  );
  const executionChoice = selectedRuntimeProfile ? `runtime:${selectedRuntimeProfile.id}` : `model:${model}`;
  const executionProvider = selectedRuntimeProfile?.runtime_type ?? selectedModel?.provider ?? 'unconfigured';

  const selectExecution = (choice: string) => {
    if (choice.startsWith('runtime:')) {
      const profileId = choice.slice('runtime:'.length);
      const profile = (catalog.runtimeProfiles ?? []).find(item => String(item.id) === profileId);
      setRuntimeProfileId(profileId);
      if (profile?.model) setModel(profile.model);
      return;
    }
    if (choice.startsWith('model:')) {
      setRuntimeProfileId('');
      setModel(choice.slice('model:'.length));
    }
  };

  useEffect(() => {
    if (!credentialProfileId || !selectedModel) return;
    const assigned = catalog.credentialProfiles.find(profile => profile.id === Number(credentialProfileId));
    if (assigned && assigned.providerType !== selectedModel.provider) setCredentialProfileId('');
  }, [catalog.credentialProfiles, credentialProfileId, selectedModel]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    const parsedTemperature = Number(temperature);
    const parsedMaxTokens = Number(maxTokens);
    const parsedMaxIterations = Number(maxIterations);
    const parsedThinkingBudget = Number(thinkingBudget);
    const parsedPr = prNumber.trim() ? Number(prNumber) : null;
    const parsedHookMax = hookMaxCalls.trim() ? Number(hookMaxCalls) : null;
    const patterns = stringList(hookPatterns) ?? [];

    try {
      if (!agent && !/^[a-z0-9_-]+$/.test(normalizedName)) throw new Error('Technical name must use lowercase letters, numbers, _ or -.');
      if (!label.trim()) throw new Error('Display name is required.');
      if (!model) throw new Error('Select a model.');
      if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) throw new Error('Temperature must be between 0 and 2.');
      if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) throw new Error('Maximum tokens must be a positive integer.');
      if (!Number.isInteger(parsedMaxIterations) || parsedMaxIterations < 1 || parsedMaxIterations > 100) throw new Error('Maximum iterations must be between 1 and 100.');
      if (!Number.isInteger(parsedThinkingBudget) || parsedThinkingBudget < 0) throw new Error('Thinking budget must be zero or a positive integer.');
      if (parsedPr != null && (!Number.isInteger(parsedPr) || parsedPr < 1)) throw new Error('PR number must be a positive integer.');
      if (parsedHookMax != null && (!Number.isInteger(parsedHookMax) || parsedHookMax < 1)) throw new Error('Tool-call ceiling must be a positive integer.');
      patterns.forEach(pattern => { try { new RegExp(pattern); } catch { throw new Error(`Invalid destructive-command pattern: ${pattern}`); } });
      if (keyMode === 'replace' && llmApiKey.trim() && llmApiKey.trim().length < 8) throw new Error('The provider key looks too short.');

      const keyValue = keyMode === 'keep' ? undefined : keyMode === 'clear' ? null : llmApiKey.trim() || undefined;
      setValidation(null);
      onSave({
        agent: {
          ...(!agent ? { name: normalizedName } : {}),
          label: label.trim(),
          description: description.trim(),
          model,
          temperature: parsedTemperature,
          max_tokens: parsedMaxTokens,
          system_prompt: systemPrompt.trim() || null,
          agent_role: agentRole.trim() || null,
          composite_id: compositeId ? Number(compositeId) : null,
          gitea_project: giteaProject.trim() || null,
          enabled,
          max_iterations: parsedMaxIterations,
          agent_mode: mode,
          task_type: taskType.trim() || null,
          pr_branch: prBranch.trim() || null,
          pr_number: parsedPr,
          ticket_id: ticketId.trim() || null,
          allowed_paths: stringList(allowedPaths),
          bitbucket_repo: bitbucketRepo.trim() || null,
          bundle_ids: bundleIds.length ? bundleIds : null,
          ...(keyValue !== undefined ? { llm_api_key: keyValue } : {}),
          llm_credential_profile_id: credentialProfileId ? Number(credentialProfileId) : null,
          runtime_profile_id: runtimeProfileId ? Number(runtimeProfileId) : null,
          thinking_budget: parsedThinkingBudget,
          untrusted_tool_output_enforcement: untrustedEnforcement,
          codegraph_enabled: codegraphEnabled,
          visibility,
          min_role: minRole || null,
          risk_level: riskLevel,
          human_oversight_required: humanOversightRequired,
        },
        ragIndexIds,
        codeIndexIds,
        skillIds,
        hookConfig: { extra_destructive_patterns: patterns, max_tool_calls: parsedHookMax },
      });
    } catch (caught) {
      setValidation(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="editor-layer" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="bundle-editor agent-editor" role="dialog" aria-modal="true" aria-labelledby="agent-editor-title" onMouseDown={event => event.stopPropagation()}>
        <header className="editor-header">
          <div><span className="eyebrow">AGENT STUDIO</span><h2 id="agent-editor-title">{agent ? `Configure ${agent.label}` : 'Create agent'}</h2><p>Runtime, MCP scope, knowledge and safety controls in one place.</p></div>
          <button className="editor-close" type="button" aria-label="Close agent editor" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>

        <form className="bundle-editor-form agent-editor-form" onSubmit={submit}>
          <div className="editor-form-column">
            <section className="editor-section">
              <div className="editor-section-heading"><span><Bot size={17} /></span><div><small>IDENTITY</small><h3>Name and availability</h3></div><strong>{enabled ? 'ACTIVE' : 'DISABLED'}</strong></div>
              <div className="agent-editor-identity-grid">
                <label className="editor-field"><span>Technical name <em>required</em></span><input required disabled={agent != null} value={name} onChange={event => setName(event.target.value)} placeholder="platform-engineer" /></label>
                <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="Platform Engineer" /></label>
              </div>
              <label className="editor-field"><span>Description</span><textarea rows={3} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} placeholder="What this agent does and when people should use it." /></label>
              <div className="agent-editor-identity-grid">
                <label className="editor-field"><span>Visibility</span><select value={visibility} onChange={event => setVisibility(event.target.value as ManagedAgent['visibility'])}><option value="internal">Internal workspace</option><option value="public">Public widget eligible</option></select></label>
                <label className="editor-field"><span>Minimum role</span><select value={minRole} onChange={event => setMinRole(event.target.value as ArgusUserRole | '')}><option value="">No role minimum</option>{ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
              </div>
              <label className="agent-switch"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span className="connection-check">{enabled && <CheckCircle2 size={12} />}</span><span><b>Agent enabled</b><small>Disabled agents cannot start new chat or worker runs.</small></span></label>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><BrainCircuit size={17} /></span><div><small>RUNTIME</small><h3>How this Agent runs</h3></div><strong>{executionProvider.toUpperCase()}</strong></div>
              <p className="editor-section-description">Choose one execution setup. Subscription runtimes already include their effective model and authentication; direct API models use your managed provider catalog.</p>
              <div className="agent-editor-model-grid">
                <label className="editor-field"><span>Execution <em>required</em></span><select aria-label="Execution setup" required value={executionChoice} onChange={event => selectExecution(event.target.value)}>{(catalog.runtimeProfiles ?? []).length > 0 && <optgroup label="Subscription and managed runtimes">{(catalog.runtimeProfiles ?? []).map(profile => <option value={`runtime:${profile.id}`} disabled={!profile.enabled} key={profile.id}>{runtimeChoiceLabel(profile)}{profile.enabled ? '' : ' (unavailable)'}</option>)}</optgroup>}<optgroup label="Direct API models">{catalog.models.map(option => <option key={option.model_name} value={`model:${option.model_name}`}>{option.model_name} · {option.provider}</option>)}{model && !catalog.models.some(option => option.model_name === model) && <option value={`model:${model}`}>{model} · legacy assignment</option>}</optgroup></select><small>Fast, Deep, Claude Code and Hermes are complete runtime choices—not an additional model override.</small></label>
                <label className="editor-field"><span>Mode</span><select value={mode} onChange={event => setMode(event.target.value as ManagedAgent['agent_mode'])}><option value="chat">Chat</option><option value="worker">Worker</option><option value="reviewer">Reviewer</option></select></label>
              </div>
              <div className={`agent-execution-summary${selectedRuntimeProfile?.enabled === false ? ' is-warning' : ''}`}>
                <Zap size={16} />
                <span><small>{selectedRuntimeProfile ? 'EFFECTIVE RUNTIME' : 'DIRECT PROVIDER'}</small><b>{selectedRuntimeProfile?.label ?? selectedModel?.model_name ?? model}</b><em>{selectedRuntimeProfile ? [selectedRuntimeProfile.model ?? selectedRuntimeProfile.runtime_type, selectedRuntimeProfile.reasoning_effort, selectedRuntimeProfile.auth_mode === 'chatgpt' ? 'ChatGPT subscription' : selectedRuntimeProfile.auth_mode === 'claude_subscription' ? 'Claude subscription' : selectedRuntimeProfile.auth_mode].filter(Boolean).join(' · ') : `${selectedModel?.provider ?? 'legacy'} · managed credential`}</em></span>
              </div>
              {selectedRuntimeProfile?.runtime_type === 'hermes' && <div className="agent-runtime-note">{selectedRuntimeProfile.execution_strategy === 'attached' ? 'Attached v1 runs chat only. Hermes native tools are externally attested; Core bundles, memory and workspace writes require Managed Hermes.' : 'Hermes executes through the governed Argus adapter with the workspace, Bundle and memory policy shown by this profile.'}</div>}
              <details className="agent-advanced-settings"><summary>Advanced generation limits</summary><div className="agent-editor-number-grid">
                <label className="editor-field"><span>Temperature</span><input type="number" min="0" max="2" step="0.1" value={temperature} onChange={event => setTemperature(event.target.value)} /></label>
                <label className="editor-field"><span>Max tokens</span><input type="number" min="1" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} /></label>
                <label className="editor-field"><span>Max iterations</span><input type="number" min="1" max="100" value={maxIterations} onChange={event => setMaxIterations(event.target.value)} /></label>
                <label className="editor-field"><span>Thinking budget</span><input type="number" min="0" value={thinkingBudget} onChange={event => setThinkingBudget(event.target.value)} /></label>
              </div><small>Runtime profiles may enforce stricter model and reasoning limits. These values remain the Agent-level ceiling and direct-provider configuration.</small></details>
              <label className="editor-field"><span>Agent role / blueprint</span><input value={agentRole} onChange={event => setAgentRole(event.target.value)} placeholder="platform-engineer" /><small>Used for role-specific behavior and optional Entra identity blueprints.</small></label>
              <label className="editor-field"><span>System prompt</span><textarea className="prompt-textarea" rows={10} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} placeholder="You are an Argus agent that…" /></label>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><GitBranch size={17} /></span><div><small>DEVELOPMENT CONTEXT</small><h3>Repository and task scope</h3></div><strong>{mode.toUpperCase()}</strong></div>
              <div className="agent-editor-identity-grid">
                <label className="editor-field"><span>Task type</span><input value={taskType} onChange={event => setTaskType(event.target.value)} placeholder="feature, review, incident" /></label>
                <label className="editor-field"><span>Ticket ID</span><input value={ticketId} onChange={event => setTicketId(event.target.value)} placeholder="ARG-142" /></label>
                <label className="editor-field"><span>Bitbucket repository</span><input value={bitbucketRepo} onChange={event => setBitbucketRepo(event.target.value)} placeholder="workspace/repository" /></label>
                <label className="editor-field"><span>Gitea project</span><input value={giteaProject} onChange={event => setGiteaProject(event.target.value)} placeholder="org/project" /></label>
                <label className="editor-field"><span>PR branch</span><input value={prBranch} onChange={event => setPrBranch(event.target.value)} placeholder="feature/argus-agent" /></label>
                <label className="editor-field"><span>PR number</span><input type="number" min="1" value={prNumber} onChange={event => setPrNumber(event.target.value)} placeholder="42" /></label>
              </div>
              <label className="editor-field"><span>Allowed paths</span><textarea className="prompt-textarea" rows={5} value={allowedPaths} onChange={event => setAllowedPaths(event.target.value)} placeholder={'src/**\ntests/**'} /><small>One repository path or glob per line.</small></label>
            </section>
          </div>

          <div className="editor-form-column">
            <section className="editor-section">
              <div className="editor-section-heading"><span><Blocks size={17} /></span><div><small>MCP FABRIC</small><h3>Composite and access bundles</h3></div><strong>{bundleIds.length} BUNDLES</strong></div>
              {agent?.readiness && <div className={`agent-readiness-panel is-${agent.readiness.status}`} aria-label="Agent capability readiness">
                <header>
                  <span>{agent.readiness.ready ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span>
                  <div><small>EXECUTION READINESS</small><b>{agent.readiness.status}</b><p>{agent.readiness.runtime.detail}</p></div>
                  <em>{agent.readiness.tools.length} tools</em>
                </header>
                <div className="agent-readiness-capabilities">
                  <span><b>{agent.readiness.capabilities.workspace.toolCount}</b>Workspace</span>
                  <span><b>{agent.readiness.capabilities.knowledge.toolCount}</b>Knowledge</span>
                  <span><b>{agent.readiness.capabilities.subagents.toolCount}</b>Delegation</span>
                  <span><b>{agent.readiness.bundles.length}</b>Bundles</span>
                </div>
                {agent.readiness.blockers.length > 0 && <div className="agent-readiness-issues is-blocked"><b>Start blockers</b>{agent.readiness.blockers.map(item => <span key={item}>{item}</span>)}</div>}
                {agent.readiness.warnings.length > 0 && <div className="agent-readiness-issues is-warning"><b>Warnings</b>{agent.readiness.warnings.map(item => <span key={item}>{item}</span>)}</div>}
                {agent.readiness.bundles.length > 0 && <div className="agent-readiness-bundles">{agent.readiness.bundles.map(bundle => <div key={bundle.id}>
                  <span><b>{bundle.label}</b><small>{bundle.toolNames.length} allowed tools</small></span>
                  <em className={`is-${bundle.state}`}>{bundle.state}</em>
                  {bundle.backends.map(backend => <small key={backend.id}>{backend.name} · {backend.detail}</small>)}
                </div>)}</div>}
                <details className="agent-readiness-tools">
                  <summary>Show effective tool catalog</summary>
                  <div>{agent.readiness.tools.map(tool => <code key={tool.name} data-source={tool.source}>{tool.name}<small>{tool.source}</small></code>)}</div>
                </details>
              </div>}
              <label className="editor-field"><span>Composite endpoint</span><select value={compositeId} onChange={event => setCompositeId(event.target.value)}><option value="">No composite</option>{catalog.composites.map(composite => <option key={composite.id} value={composite.id}>{composite.name}</option>)}</select><small>The composite controls the aggregated MCP surface; bundles constrain direct tool access.</small></label>
              <div className="agent-option-list">{catalog.bundles.length ? catalog.bundles.map(bundle => <label className={`agent-option${bundleIds.includes(bundle.id) ? ' is-selected' : ''}`} key={bundle.id}><input type="checkbox" checked={bundleIds.includes(bundle.id)} onChange={() => setBundleIds(current => toggleId(current, bundle.id))} /><span className="connection-check">{bundleIds.includes(bundle.id) && <CheckCircle2 size={12} />}</span><span><b>{bundle.icon || '◫'} {bundle.label || bundle.name}</b><small>{bundle.tool_count} capabilities · {bundle.backend_count} connections</small></span></label>) : <div className="agent-option-empty">No access bundles configured.</div>}</div>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><Database size={17} /></span><div><small>KNOWLEDGE</small><h3>RAG indexes</h3></div><strong>{ragIndexIds.length} SELECTED</strong></div>
              <div className="agent-option-list compact">{catalog.ragIndexes.length ? catalog.ragIndexes.map(index => <label className={`agent-option${ragIndexIds.includes(index.id) ? ' is-selected' : ''}`} key={index.id}><input type="checkbox" checked={ragIndexIds.includes(index.id)} onChange={() => setRagIndexIds(current => toggleId(current, index.id))} /><span className="connection-check">{ragIndexIds.includes(index.id) && <CheckCircle2 size={12} />}</span><span><b>{index.label}</b><small>{index.provider} · top {index.top_k}{index.hyde_enabled ? ' · HyDE' : ''}</small></span></label>) : <div className="agent-option-empty">No RAG indexes configured.</div>}</div>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><Network size={17} /></span><div><small>REPOSITORY KNOWLEDGE</small><h3>Graphify snapshots</h3></div><strong>{codeIndexIds.length} SELECTED</strong></div>
              <p className="editor-section-description">Attach immutable repository architecture and code relations as query-time Agent context. Snapshot Bundle permissions remain enforced.</p>
              <div className="agent-option-list compact">{(catalog.codeIndexes ?? []).length ? (catalog.codeIndexes ?? []).map(snapshot => <label className={`agent-option${codeIndexIds.includes(snapshot.id) ? ' is-selected' : ''}`} key={snapshot.id}><input type="checkbox" checked={codeIndexIds.includes(snapshot.id)} onChange={() => setCodeIndexIds(current => toggleId(current, snapshot.id))} /><span className="connection-check">{codeIndexIds.includes(snapshot.id) && <CheckCircle2 size={12} />}</span><span><b>{snapshot.repositoryKey}</b><small>{snapshot.branchName} · {snapshot.commitSha.slice(0, 8)} · {snapshot.symbolCount.toLocaleString()} symbols · {snapshot.edgeCount.toLocaleString()} relations</small></span></label>) : <div className="agent-option-empty">No ready Graphify snapshots. Create one in Knowledge Hub first.</div>}</div>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><Sparkles size={17} /></span><div><small>INSTRUCTIONS</small><h3>Reusable skills</h3></div><strong>{skillIds.length} SELECTED</strong></div>
              <div className="agent-option-list compact">{catalog.skills.length ? catalog.skills.map(skill => <label className={`agent-option${skillIds.includes(skill.id) ? ' is-selected' : ''}`} key={skill.id}><input type="checkbox" checked={skillIds.includes(skill.id)} onChange={() => setSkillIds(current => toggleId(current, skill.id))} /><span className="connection-check">{skillIds.includes(skill.id) && <CheckCircle2 size={12} />}</span><span><b>{skill.icon || '✦'} {skill.label}</b><small>{skill.category || 'uncategorized'} · {skill.name}{agent?.skills.find(s=>s.id===skill.id)?.revision_id ? ` · pinned #${agent.skills.find(s=>s.id===skill.id)!.revision_id}` : ' · catalog version pinned on assignment'}</small></span></label>) : <div className="agent-option-empty">No reusable skills configured.</div>}</div>
              <p>Saving preserves existing Skill pins. <a href="/build/evaluations#skill-versions">Compare and release a new version</a> for this Agent.</p>
            </section>

            <section className="editor-section">
              <div className="editor-section-heading"><span><ShieldCheck size={17} /></span><div><small>GUARDRAILS</small><h3>Risk, oversight and execution limits</h3></div><strong>{riskLevel.toUpperCase()}</strong></div>
              <label className="editor-field"><span>Governance risk level</span><select value={riskLevel} onChange={event => setRiskLevel(event.target.value as ManagedAgent['risk_level'])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><small>Classifies the agent for governance, audit and review workflows.</small></label>
              <label className="agent-switch"><input aria-label="Require human approval for sensitive writes" type="checkbox" checked={humanOversightRequired} onChange={event => setHumanOversightRequired(event.target.checked)} /><span className="connection-check">{humanOversightRequired && <CheckCircle2 size={12} />}</span><span><b>Require human approval for sensitive writes</b><small>Pauses governed tool actions until an authorized reviewer approves or rejects the exact arguments.</small></span></label>
              <label className="agent-switch"><input type="checkbox" checked={untrustedEnforcement} onChange={event => setUntrustedEnforcement(event.target.checked)} /><span className="connection-check">{untrustedEnforcement && <CheckCircle2 size={12} />}</span><span><b>Enforce untrusted tool-output boundaries</b><small>Tag and isolate external tool content before it re-enters the model.</small></span></label>
              <label className="agent-switch"><input type="checkbox" checked={codegraphEnabled} onChange={event => setCodegraphEnabled(event.target.checked)} /><span className="connection-check">{codegraphEnabled && <CheckCircle2 size={12} />}</span><span><b>Build a live Dev workspace graph</b><small>Refresh codegraph_* tools against the current worker checkout. Immutable Knowledge Hub snapshots above remain separate.</small></span></label>
              <label className="editor-field"><span>Additional destructive-command patterns</span><textarea className="prompt-textarea" rows={5} value={hookPatterns} onChange={event => setHookPatterns(event.target.value)} placeholder={'\\brm\\s+-rf\\b\n\\bkubectl\\s+delete\\b'} /><small>One regular expression per line. These only tighten the built-in hooks.</small></label>
              <label className="editor-field"><span>Maximum tool calls per run</span><input type="number" min="1" value={hookMaxCalls} onChange={event => setHookMaxCalls(event.target.value)} placeholder="Use platform ceiling" /></label>
            </section>

            {!selectedRuntimeProfile && <section className="editor-section">
              <div className="editor-section-heading"><span><KeyRound size={17} /></span><div><small>CREDENTIAL CONTROL</small><h3>Runtime credential</h3></div><strong>{selectedCredentialProfile ? 'PROFILE' : agent?.llm_api_key ? 'DIRECT' : 'INHERITED'}</strong></div>
              <p className="editor-section-description">Assign a reusable credential for Agent-, department- and cost-center-level control. Without one, the model provider credential is inherited.</p>
              <label className="editor-field"><span>Credential profile</span><select value={credentialProfileId} onChange={event => setCredentialProfileId(event.target.value)}><option value="">Inherit from model provider</option>{compatibleCredentialProfiles.map(profile => <option value={profile.id} disabled={!profile.enabled || profile.expired || !profile.credentialConfigured} key={profile.id}>{profile.label}{profile.enabled && !profile.expired && profile.credentialConfigured ? '' : ' (unavailable)'}</option>)}</select><small>{selectedModel ? `${compatibleCredentialProfiles.length} compatible ${selectedModel.provider} profile${compatibleCredentialProfiles.length === 1 ? '' : 's'}` : 'Select a model first.'}</small></label>
              {selectedCredentialProfile && <div className={`agent-credential-summary${selectedCredentialProfile.enabled && !selectedCredentialProfile.expired && selectedCredentialProfile.credentialConfigured ? '' : ' is-warning'}`}><ShieldCheck size={14} /><span><b>{selectedCredentialProfile.department || 'Shared platform'} · {selectedCredentialProfile.costCenter || 'No cost center'}</b><small>${selectedCredentialProfile.currentMonthSpendUsd.toFixed(2)} this month{selectedCredentialProfile.monthlyBudgetUsd == null ? '' : ` of $${selectedCredentialProfile.monthlyBudgetUsd.toFixed(2)} · ${selectedCredentialProfile.budgetMode}`}</small></span></div>}
              <div className="agent-legacy-key"><span>Legacy direct key</span><small>Optional emergency override. It is used only when no profile is assigned and <code>DIRECT_AGENT_API_KEYS=true</code>.</small></div>
              {agent?.llm_api_key && <div className="agent-key-actions"><button type="button" className={keyMode === 'keep' ? 'is-active' : ''} onClick={() => setKeyMode('keep')}>Keep current</button><button type="button" className={keyMode === 'replace' ? 'is-active' : ''} onClick={() => setKeyMode('replace')}>Replace</button><button type="button" className={keyMode === 'clear' ? 'is-danger' : ''} onClick={() => setKeyMode('clear')}>Remove</button></div>}
              {keyMode === 'replace' && <label className="editor-field"><span>{agent?.llm_api_key ? 'New provider key' : 'Provider key'}</span><input type="password" autoComplete="new-password" value={llmApiKey} onChange={event => setLlmApiKey(event.target.value)} placeholder={agent?.llm_api_key ? 'Leave blank to keep current via the option above' : 'Optional'} /></label>}
              {keyMode === 'clear' && <div className="agent-warning"><AlertTriangle size={14} /><span>The agent will fall back to the platform provider credential after saving.</span></div>}
            </section>}
          </div>

          {(validation || error || hookQuery.error) && <div className="editor-error" role="alert"><AlertTriangle size={15} /><span>{validation || error || hookQuery.error?.message}</span></div>}

          <footer className="editor-footer agent-editor-footer">
            <div>{agent && (!deleteArmed ? <button className="button editor-delete" type="button" disabled={busy} onClick={() => setDeleteArmed(true)}><Trash2 size={14} />Delete agent</button> : <div className="agent-delete-confirm"><input value={deleteName} onChange={event => setDeleteName(event.target.value)} placeholder={`Type ${agent.name}`} aria-label="Confirm agent name" /><button className="button button-danger" type="button" disabled={busy || deleteName !== agent.name} onClick={() => onDelete(agent)}>Confirm delete</button><button className="button button-secondary" type="button" onClick={() => { setDeleteArmed(false); setDeleteName(''); }}>Cancel</button></div>)}</div>
            <div><button className="button button-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || hookQuery.isLoading}><Save size={14} />{busy ? 'Saving…' : agent ? 'Save agent' : 'Create agent'}</button></div>
          </footer>
        </form>
      </section>
    </div>
  );
}

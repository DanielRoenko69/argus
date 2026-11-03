import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  Gauge,
  KeyRound,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import {
  deleteAccessPolicyComposite,
  getAccessPolicies,
  saveAccessPolicyComposite,
  saveAccessPolicyGroup,
  saveAccessPolicyTechnicalIdentity,
  saveAccessPolicyUser,
  simulateAccessPolicy,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import { PolicyPostureDashboard } from '../components/PolicyPostureDashboard';
import { previewCompositeImpact, suggestToolPatterns } from '../policyRemediation';
import type {
  AccessPolicyComposite,
  AccessPolicyCompositeMutation,
  AccessPolicyGroup,
  AccessPolicyGroupMutation,
  AccessPolicyResponse,
  AccessPolicySimulation,
  AccessPolicySimulatorPrincipalKind,
  AccessPolicyPostureTarget,
  AccessPolicyTechnicalIdentity,
  AccessPolicyTechnicalIdentityMutation,
  AccessPolicyUser,
  AccessPolicyUserMutation,
} from '../types';

type PolicyTab = 'posture' | 'composites' | 'groups' | 'users' | 'technical' | 'simulator';

function initialPolicyTab(): PolicyTab {
  const requested = new URLSearchParams(window.location.search).get('tab');
  return ['posture', 'composites', 'groups', 'users', 'technical', 'simulator'].includes(requested ?? '')
    ? requested as PolicyTab
    : 'posture';
}

function initialPolicyUserId(): number | null {
  const requested = Number(new URLSearchParams(window.location.search).get('user'));
  return Number.isInteger(requested) && requested > 0 ? requested : null;
}

function patternLines(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean))];
}

function usageCount(policy: AccessPolicyComposite): number {
  return policy.userCount + policy.groupCount + policy.agentCount + policy.apiKeyCount;
}

function CompositeEditor({
  policy,
  data,
  saving,
  deleting,
  error,
  onSave,
  onDelete,
}: {
  policy: AccessPolicyComposite | null;
  data: AccessPolicyResponse;
  saving: boolean;
  deleting: boolean;
  error: string | null;
  onSave: (input: AccessPolicyCompositeMutation) => void;
  onDelete: (() => void) | null;
}) {
  const [name, setName] = useState(policy?.name ?? '');
  const [description, setDescription] = useState(policy?.description ?? '');
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [bundleMode, setBundleMode] = useState<'all' | 'selected'>(policy?.bundleMode ?? 'selected');
  const [bundleIds, setBundleIds] = useState<number[]>(policy?.includedBundleIds ?? []);
  const [allowPatterns, setAllowPatterns] = useState((policy?.toolAllowPatterns ?? []).join('\n'));
  const [denyPatterns, setDenyPatterns] = useState((policy?.toolDenyPatterns ?? []).join('\n'));
  const [agentRole, setAgentRole] = useState(policy?.agentRole ?? '');
  const [systemPrompt, setSystemPrompt] = useState(policy?.systemPrompt ?? '');
  const selectedBundles = useMemo(() => new Set(bundleIds), [bundleIds]);
  const assigned = policy ? usageCount(policy) : 0;
  const draftImpact = useMemo(() => previewCompositeImpact(data, {
    id: policy?.id ?? 0,
    name: name || 'draft',
    description,
    bundleMode,
    includedBundleIds: bundleIds,
    toolAllowPatterns: patternLines(allowPatterns),
    toolDenyPatterns: patternLines(denyPatterns),
    systemPrompt: systemPrompt || null,
    agentRole: agentRole || null,
    enabled,
    userCount: policy?.userCount ?? 0,
    groupCount: policy?.groupCount ?? 0,
    agentCount: policy?.agentCount ?? 0,
    apiKeyCount: policy?.apiKeyCount ?? 0,
    groupNames: policy?.groupNames ?? [],
    createdAt: policy?.createdAt ?? '',
    updatedAt: policy?.updatedAt ?? '',
  }), [
    agentRole,
    allowPatterns,
    bundleIds,
    bundleMode,
    data,
    denyPatterns,
    description,
    enabled,
    name,
    policy,
    systemPrompt,
  ]);
  const suggestions = useMemo(
    () => suggestToolPatterns(draftImpact.scopedTools).slice(0, 10),
    [draftImpact.scopedTools],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      name,
      description,
      enabled,
      bundleMode,
      includedBundleIds: bundleIds,
      toolAllowPatterns: patternLines(allowPatterns),
      toolDenyPatterns: patternLines(denyPatterns),
      agentRole: agentRole || null,
      systemPrompt: systemPrompt || null,
    });
  };

  return (
    <form className="policy-editor" onSubmit={submit}>
      <div className="policy-editor-heading">
        <span className="policy-editor-icon"><ShieldCheck size={18} /></span>
        <div>
          <span className="eyebrow">COMPOSITE POLICY</span>
          <h2>{policy ? policy.name : 'Create composite'}</h2>
          <p>Combine bundle scope with a final tool-name allow/deny boundary.</p>
        </div>
        <label className="policy-enabled-toggle">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          <span>{enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <section className="policy-editor-section">
        <div className="policy-section-title"><KeyRound size={15} /><span><small>IDENTITY</small><b>Policy definition</b></span></div>
        <div className="policy-field-grid">
          <label className="editor-field">
            <span>Internal name <em>required</em></span>
            <input
              required
              maxLength={128}
              pattern="[a-z0-9][a-z0-9_-]*"
              value={name}
              onChange={event => setName(event.target.value.toLowerCase())}
              placeholder="platform-operators"
            />
          </label>
          <label className="editor-field">
            <span>Effective endpoint</span>
            <input disabled value={`/mcp/composite/${name || 'policy-name'}`} readOnly />
          </label>
        </div>
        <label className="editor-field">
          <span>Description</span>
          <textarea rows={2} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} />
        </label>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title"><Boxes size={15} /><span><small>RESOURCE SCOPE</small><b>Included bundles</b></span></div>
        <div className="policy-mode-switch">
          <button type="button" className={bundleMode === 'all' ? 'is-active' : ''} onClick={() => setBundleMode('all')}>
            <Boxes size={14} /><span><b>All bundles</b><small>Includes future bundles</small></span>
          </button>
          <button type="button" className={bundleMode === 'selected' ? 'is-active' : ''} onClick={() => setBundleMode('selected')}>
            <LockKeyhole size={14} /><span><b>Selected bundles</b><small>Future bundles stay denied</small></span>
          </button>
        </div>
        {bundleMode === 'all' ? (
          <div className="policy-scope-warning">
            <AlertTriangle size={14} />
            <span>This wildcard also includes bundles created later. Tool patterns remain the final boundary.</span>
          </div>
        ) : (
          <div className="policy-bundle-grid">
            {data.bundles.map(bundle => {
              const checked = selectedBundles.has(bundle.id);
              return (
                <label className={`policy-bundle-option${checked ? ' is-selected' : ''}`} key={bundle.id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setBundleIds(current =>
                      current.includes(bundle.id)
                        ? current.filter(id => id !== bundle.id)
                        : [...current, bundle.id],
                    )}
                  />
                  <span className="connection-check">{checked && <Check size={12} />}</span>
                  <span aria-hidden="true">{bundle.icon || '◈'}</span>
                  <span><b>{bundle.label}</b><small>{bundle.toolCount} tools</small></span>
                </label>
              );
            })}
          </div>
        )}
        {bundleMode === 'selected' && bundleIds.length > 0 && (
          <div className="policy-bundle-workspace-links">
            <small>Bundle workspaces</small>
            <span>
              {data.bundles.filter(bundle => selectedBundles.has(bundle.id)).map(bundle => (
                <a href={`/mcp-fabric/bundles/${bundle.id}`} key={bundle.id}>
                  {bundle.icon || '◈'} {bundle.label}<ExternalLink size={11} />
                </a>
              ))}
            </span>
          </div>
        )}
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title"><Wrench size={15} /><span><small>CAPABILITY FILTER</small><b>Tool patterns</b></span></div>
        <p className="policy-help">One glob per line. Deny always wins. An empty allow list means all tools inside the selected bundle scope.</p>
        <div className="policy-field-grid">
          <label className="editor-field">
            <span>Allow patterns</span>
            <textarea
              className="policy-pattern-textarea"
              rows={6}
              value={allowPatterns}
              onChange={event => setAllowPatterns(event.target.value)}
              placeholder={'github_*\nk8s_*'}
            />
          </label>
          <label className="editor-field">
            <span>Deny patterns</span>
            <textarea
              className="policy-pattern-textarea is-deny"
              rows={6}
              value={denyPatterns}
              onChange={event => setDenyPatterns(event.target.value)}
              placeholder={'*_delete\n*_destroy'}
            />
          </label>
        </div>
        <div className="policy-suggestions">
          <small>Suggestions</small>
          {suggestions.map(suggestion => (
            <button
              type="button"
              className={suggestion.kind === 'write' ? 'is-write' : 'is-read'}
              key={suggestion.pattern}
              title={`${suggestion.matchCount} matching tool${suggestion.matchCount === 1 ? '' : 's'} · ${suggestion.kind} capability`}
              onClick={() => setAllowPatterns(current => patternLines(`${current}\n${suggestion.pattern}`).join('\n'))}
            >
              + {suggestion.pattern}<em>{suggestion.matchCount}</em>
            </button>
          ))}
        </div>

        <div className={`composite-match-preview${draftImpact.lockoutRisk ? ' is-lockout' : ''}`}>
          <header>
            <div className="policy-section-title">
              {draftImpact.lockoutRisk ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
              <span><small>LIVE MATCH PREVIEW</small><b>Effective catalog coverage</b></span>
            </div>
            <span>{draftImpact.allowedTools.length}/{data.tools.length} tools matched</span>
          </header>
          <div className="composite-match-metrics">
            <article><span>Bundle scope</span><strong>{draftImpact.scopedTools.length}</strong><small>catalog tools</small></article>
            <article><span>Effective</span><strong>{draftImpact.allowedTools.length}</strong><small>after all patterns</small></article>
            <article><span>Denied</span><strong>{draftImpact.deniedTools.length}</strong><small>explicitly blocked</small></article>
            <article><span>Removed</span><strong>{draftImpact.removedTools.length}</strong><small>outside final scope</small></article>
          </div>
          {(draftImpact.unmatchedAllowPatterns.length > 0 || draftImpact.unmatchedDenyPatterns.length > 0) && (
            <div className="composite-unmatched-patterns">
              <AlertTriangle size={13} />
              <div>
                <b>Patterns without a current match</b>
                <span>
                  {[...draftImpact.unmatchedAllowPatterns, ...draftImpact.unmatchedDenyPatterns]
                    .map(pattern => <code key={pattern}>{pattern}</code>)}
                </span>
              </div>
            </div>
          )}
          <div className="composite-match-sample">
            <span>Effective tool sample</span>
            <div>
              {draftImpact.allowedTools.slice(0, 8).map(tool => <code key={tool}>{tool}</code>)}
              {draftImpact.allowedTools.length === 0 && <small>No registered tool passes this policy.</small>}
            </div>
          </div>
          {draftImpact.lockoutRisk && (
            <div className="remediation-warning">
              <AlertTriangle size={14} />
              <span>Saving this composite is allowed, but assigning it would currently block every registered tool. Update its bundles or allow patterns first.</span>
            </div>
          )}
        </div>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title"><Users size={15} /><span><small>CONTEXT</small><b>Agent role and prompt</b></span></div>
        <label className="editor-field">
          <span>Agent role</span>
          <input maxLength={128} value={agentRole} onChange={event => setAgentRole(event.target.value)} placeholder="Platform Operator" />
        </label>
        <label className="editor-field">
          <span>System prompt</span>
          <textarea rows={4} maxLength={20_000} value={systemPrompt} onChange={event => setSystemPrompt(event.target.value)} />
        </label>
      </section>

      {policy && (
        <div className="policy-usage-strip">
          <span><b>{policy.userCount}</b> users</span>
          <span><b>{policy.groupCount}</b> groups</span>
          <span><b>{policy.agentCount}</b> agents</span>
          <span><b>{policy.apiKeyCount}</b> API keys</span>
        </div>
      )}
      {error && <div className="access-manager-error" role="alert">{error}</div>}
      <footer className="policy-editor-footer">
        <div>
          {onDelete && (
            <button
              type="button"
              className="button editor-delete"
              disabled={deleting || saving || assigned > 0}
              title={assigned > 0 ? 'Remove all assignments before deleting this composite' : undefined}
              onClick={() => {
                if (window.confirm(`Delete composite “${policy?.name}”?`)) onDelete();
              }}
            >
              <Trash2 size={14} />{deleting ? 'Deleting…' : assigned > 0 ? `In use by ${assigned}` : 'Delete'}
            </button>
          )}
        </div>
        <button
          className="button button-primary"
          type="submit"
          disabled={saving || deleting || !name || (bundleMode === 'selected' && bundleIds.length === 0)}
        >
          <ShieldCheck size={14} />{saving ? 'Saving…' : policy ? 'Save policy' : 'Create policy'}
        </button>
      </footer>
    </form>
  );
}

function GroupPolicyEditor({
  group,
  data,
  saving,
  error,
  onSave,
}: {
  group: AccessPolicyGroup | null;
  data: AccessPolicyResponse;
  saving: boolean;
  error: string | null;
  onSave: (input: AccessPolicyGroupMutation) => void;
}) {
  const [groupName, setGroupName] = useState(group?.name ?? '');
  const [compositeIds, setCompositeIds] = useState<number[]>(group?.compositeIds ?? []);
  const [agentIds, setAgentIds] = useState<number[]>(group?.agentIds ?? []);
  const [rules, setRules] = useState(() => (group?.rules ?? []).map(rule => ({ ...rule })));
  const selected = useMemo(() => new Set(compositeIds), [compositeIds]);
  const selectedAgents = useMemo(() => new Set(agentIds), [agentIds]);
  const deniedAgents = useMemo(() => new Set(group?.deniedAgentIds ?? []), [group?.deniedAgentIds]);
  const agents = data.simulatorPrincipals.filter(principal => principal.kind === 'agent');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      groupName,
      compositeIds,
      agentIds,
      rules: rules
        .filter(rule => rule.toolPattern.trim())
        .map(rule => ({
          toolPattern: rule.toolPattern.trim(),
          effect: rule.effect,
          reason: rule.reason?.trim() || null,
        })),
    });
  };

  return (
    <form className="policy-editor" onSubmit={submit}>
      <div className="policy-editor-heading">
        <span className="policy-editor-icon violet"><Users size={18} /></span>
        <div>
          <span className="eyebrow">GROUP POLICY</span>
          <h2>{group?.name || 'Create group binding'}</h2>
          <p>Bind an identity-provider group to composites and optional final tool rules.</p>
        </div>
        {group && <strong className="policy-member-count">{group.memberCount} known members</strong>}
      </div>

      <section className="policy-editor-section">
        <div className="policy-section-title"><KeyRound size={15} /><span><small>IDENTITY SOURCE</small><b>Group identifier</b></span></div>
        <label className="editor-field">
          <span>Group name or object ID <em>required</em></span>
          <input
            required
            disabled={Boolean(group)}
            maxLength={128}
            value={groupName}
            onChange={event => setGroupName(event.target.value)}
            placeholder="platform-engineering or Entra Object ID"
          />
          <small>Must exactly match the group value provided by the identity token.</small>
        </label>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <Bot size={15} />
          <span><small>INHERITED CHAT ACCESS</small><b>Visible agents</b></span>
          <em className="policy-selection-count">{agentIds.length === 0 ? 'All agents' : `${agentIds.length} selected`}</em>
        </div>
        <p className="policy-help">No selection leaves all internal Agents visible to group members. Once selected, this becomes an inherited allowlist; explicit group denies remain locked.</p>
        <div className="user-agent-grid">
          {agents.map(agent => {
            const numericId = Number(agent.id);
            const denied = deniedAgents.has(numericId);
            const checked = selectedAgents.has(numericId);
            return (
              <label className={`user-agent-option${checked ? ' is-selected' : ''}${denied ? ' is-denied' : ''}`} key={agent.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={denied}
                  onChange={() => setAgentIds(current =>
                    current.includes(numericId)
                      ? current.filter(id => id !== numericId)
                      : [...current, numericId],
                  )}
                />
                <span className="connection-check">{checked && <Check size={12} />}</span>
                <span className="policy-list-icon violet"><Bot size={13} /></span>
                <span><b>{agent.label}</b><small>{denied ? 'Explicitly denied for this group' : agent.secondary}</small></span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title"><ShieldCheck size={15} /><span><small>POLICY BINDINGS</small><b>Assigned composites</b></span></div>
        <div className="group-composite-grid">
          {data.composites.map(composite => {
            const checked = selected.has(composite.id);
            return (
              <label className={`group-composite-option${checked ? ' is-selected' : ''}`} key={composite.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setCompositeIds(current =>
                    current.includes(composite.id)
                      ? current.filter(id => id !== composite.id)
                      : [...current, composite.id],
                  )}
                />
                <span className="connection-check">{checked && <Check size={12} />}</span>
                <span>
                  <b>{composite.name}</b>
                  <small>{composite.bundleMode === 'all' ? 'All bundles' : `${composite.includedBundleIds.length} bundles`} · {composite.enabled ? 'enabled' : 'disabled'}</small>
                </span>
              </label>
            );
          })}
          {data.composites.length === 0 && <EmptyState title="No composites" description="Create a composite policy before binding this group." />}
        </div>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <Wrench size={15} />
          <span><small>FINAL OVERRIDES</small><b>Group tool rules</b></span>
          <button
            type="button"
            onClick={() => setRules(current => [...current, { toolPattern: '', effect: 'deny' as const, reason: null }])}
          >
            <Plus size={12} />Add rule
          </button>
        </div>
        <p className="policy-help">Group deny rules win over every composite allow. Use explicit allow rules only when the group needs an exception.</p>
        <div className="group-rule-list">
          {rules.map((rule, index) => (
            <div className={`group-rule-row effect-${rule.effect}`} key={rule.id ?? `new-${index}`}>
              <select
                value={rule.effect}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, effect: event.target.value as 'allow' | 'deny' } : item,
                ))}
              >
                <option value="deny">Deny</option>
                <option value="allow">Allow</option>
              </select>
              <input
                required
                value={rule.toolPattern}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, toolPattern: event.target.value } : item,
                ))}
                placeholder="*_delete"
              />
              <input
                value={rule.reason ?? ''}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, reason: event.target.value } : item,
                ))}
                placeholder="Reason"
              />
              <button type="button" aria-label="Remove rule" onClick={() => setRules(current => current.filter((_, itemIndex) => itemIndex !== index))}>
                <X size={13} />
              </button>
            </div>
          ))}
          {rules.length === 0 && <div className="policy-rule-empty">No final overrides. Composite patterns define the effective tool set.</div>}
        </div>
      </section>

      <div className="policy-scope-warning">
        <AlertTriangle size={14} />
        <span>Removing the last group policy can reactivate a user’s legacy bundle fallback. Review the Access Graph after saving.</span>
      </div>
      {error && <div className="access-manager-error" role="alert">{error}</div>}
      <footer className="policy-editor-footer">
        <span />
        <button className="button button-primary" type="submit" disabled={saving || !groupName.trim()}>
          <ShieldCheck size={14} />{saving ? 'Saving…' : group ? 'Save group policy' : 'Create group policy'}
        </button>
      </footer>
    </form>
  );
}

function localDateTimeValue(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function UserPolicyEditor({
  user,
  data,
  saving,
  error,
  onSave,
}: {
  user: AccessPolicyUser;
  data: AccessPolicyResponse;
  saving: boolean;
  error: string | null;
  onSave: (input: AccessPolicyUserMutation) => void;
}) {
  const [compositeIds, setCompositeIds] = useState<number[]>(user.compositeIds);
  const [agentIds, setAgentIds] = useState<number[]>(user.agentIds);
  const [rules, setRules] = useState(() => user.rules.map(rule => ({
    ...rule,
    expiresAt: localDateTimeValue(rule.expiresAt),
  })));
  const selectedComposites = useMemo(() => new Set(compositeIds), [compositeIds]);
  const selectedAgents = useMemo(() => new Set(agentIds), [agentIds]);
  const deniedAgents = useMemo(() => new Set(user.deniedAgentIds), [user.deniedAgentIds]);
  const agents = data.simulatorPrincipals.filter(principal => principal.kind === 'agent');
  const modernPolicyActive = compositeIds.length > 0 || rules.length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      userId: user.id,
      compositeIds,
      agentIds,
      rules: rules
        .filter(rule => rule.toolPattern.trim())
        .map(rule => ({
          toolPattern: rule.toolPattern.trim(),
          effect: rule.effect,
          reason: rule.reason?.trim() || null,
          expiresAt: rule.expiresAt ? new Date(rule.expiresAt).toISOString() : null,
        })),
    });
  };

  return (
    <form className="policy-editor user-policy-editor" onSubmit={submit}>
      <div className="policy-editor-heading">
        <span className="policy-editor-icon blue"><UserRound size={18} /></span>
        <div>
          <span className="eyebrow">DIRECT USER POLICY</span>
          <h2>{user.label}</h2>
          <p>{user.username} · {user.role} · {user.entraGroups.length} identity groups</p>
        </div>
        <span className={`user-policy-status${user.enabled ? '' : ' is-disabled'}`}>
          {user.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <ShieldCheck size={15} />
          <span><small>DIRECT ASSIGNMENTS</small><b>Composite policies</b></span>
        </div>
        <p className="policy-help">Direct composites are merged with inherited group composites. Deny patterns from either source always win.</p>
        <div className="group-composite-grid">
          {data.composites.map(composite => {
            const checked = selectedComposites.has(composite.id);
            return (
              <label className={`group-composite-option${checked ? ' is-selected' : ''}${composite.enabled ? '' : ' is-disabled'}`} key={composite.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!composite.enabled && !checked}
                  onChange={() => setCompositeIds(current =>
                    current.includes(composite.id)
                      ? current.filter(id => id !== composite.id)
                      : [...current, composite.id],
                  )}
                />
                <span className="connection-check">{checked && <Check size={12} />}</span>
                <span>
                  <b>{composite.name}</b>
                  <small>{composite.bundleMode === 'all' ? 'All bundles' : `${composite.includedBundleIds.length} bundles`} · {composite.toolDenyPatterns.length} deny patterns</small>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <Bot size={15} />
          <span><small>CHAT SURFACE</small><b>Visible agents</b></span>
          <em className="policy-selection-count">{agentIds.length === 0 ? 'All agents' : `${agentIds.length} selected`}</em>
        </div>
        <p className="policy-help">No selection keeps the backward-compatible unrestricted mode. Once selected, only these Agents remain visible; explicit deny rules stay locked.</p>
        <div className="user-agent-grid">
          {agents.map(agent => {
            const numericId = Number(agent.id);
            const denied = deniedAgents.has(numericId);
            const checked = selectedAgents.has(numericId);
            return (
              <label className={`user-agent-option${checked ? ' is-selected' : ''}${denied ? ' is-denied' : ''}`} key={agent.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={denied}
                  onChange={() => setAgentIds(current =>
                    current.includes(numericId)
                      ? current.filter(id => id !== numericId)
                      : [...current, numericId],
                  )}
                />
                <span className="connection-check">{checked && <Check size={12} />}</span>
                <span className="policy-list-icon violet"><Bot size={13} /></span>
                <span><b>{agent.label}</b><small>{denied ? 'Explicitly denied' : agent.secondary}</small></span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <Wrench size={15} />
          <span><small>PERSONAL OVERRIDES</small><b>User tool rules</b></span>
          <button
            type="button"
            onClick={() => setRules(current => [...current, {
              toolPattern: '',
              effect: 'deny' as const,
              reason: null,
              expiresAt: '',
            }])}
          >
            <Plus size={12} />Add rule
          </button>
        </div>
        <p className="policy-help">Temporary rules expire automatically. User denies override every allow path, including group and composite assignments.</p>
        <div className="user-rule-list">
          {rules.map((rule, index) => (
            <div className={`user-rule-row effect-${rule.effect}`} key={rule.id ?? `new-${index}`}>
              <select
                value={rule.effect}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, effect: event.target.value as 'allow' | 'deny' } : item,
                ))}
              >
                <option value="deny">Deny</option>
                <option value="allow">Allow</option>
              </select>
              <input
                required
                list="policy-user-rule-tools"
                value={rule.toolPattern}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, toolPattern: event.target.value } : item,
                ))}
                placeholder="*_delete"
              />
              <input
                value={rule.reason ?? ''}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, reason: event.target.value } : item,
                ))}
                placeholder="Reason"
              />
              <input
                type="datetime-local"
                value={rule.expiresAt}
                onChange={event => setRules(current => current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, expiresAt: event.target.value } : item,
                ))}
                aria-label="Rule expiry"
              />
              <button type="button" aria-label="Remove rule" onClick={() => setRules(current => current.filter((_, itemIndex) => itemIndex !== index))}>
                <X size={13} />
              </button>
            </div>
          ))}
          <datalist id="policy-user-rule-tools">
            {data.tools.map(tool => <option value={tool} key={tool} />)}
          </datalist>
          {rules.length === 0 && <div className="policy-rule-empty">No personal overrides. Composite and group policies define tool access.</div>}
        </div>
      </section>

      {user.allowedBundleIds !== null && (
        <div className={`policy-scope-warning${modernPolicyActive ? ' is-modern' : ''}`}>
          <AlertTriangle size={14} />
          <span>
            Legacy bundle fallback contains {user.allowedBundleIds.length} bundle{user.allowedBundleIds.length === 1 ? '' : 's'}.
            {modernPolicyActive
              ? ' It is currently inactive because a modern user policy exists.'
              : ' It remains active until a composite or explicit tool rule is assigned.'}
          </span>
        </div>
      )}
      {error && <div className="access-manager-error" role="alert">{error}</div>}
      <footer className="policy-editor-footer">
        <small className="policy-save-note">Saving replaces direct assignments atomically. Group inheritance is not changed.</small>
        <button className="button button-primary" type="submit" disabled={saving}>
          <ShieldCheck size={14} />{saving ? 'Saving…' : 'Save user policy'}
        </button>
      </footer>
    </form>
  );
}

function TechnicalIdentityEditor({
  identity,
  data,
  saving,
  error,
  onSave,
}: {
  identity: AccessPolicyTechnicalIdentity;
  data: AccessPolicyResponse;
  saving: boolean;
  error: string | null;
  onSave: (input: AccessPolicyTechnicalIdentityMutation) => void;
}) {
  const [compositeId, setCompositeId] = useState<number | null>(identity.compositeId);
  const [bundleMode, setBundleMode] = useState<'all' | 'selected'>(identity.allowedBundleIds == null ? 'all' : 'selected');
  const [bundleIds, setBundleIds] = useState<number[]>(identity.allowedBundleIds ?? []);
  const [toolMode, setToolMode] = useState<'all' | 'selected'>(identity.allowedTools == null ? 'all' : 'selected');
  const [allowedTools, setAllowedTools] = useState((identity.allowedTools ?? []).join('\n'));
  const [deniedTools, setDeniedTools] = useState((identity.deniedTools ?? []).join('\n'));
  const selectedBundles = useMemo(() => new Set(bundleIds), [bundleIds]);
  const isApiKey = identity.kind === 'api_key';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      kind: identity.kind,
      id: identity.id,
      compositeId,
      bundleMode: isApiKey ? bundleMode : 'all',
      allowedBundleIds: isApiKey ? bundleIds : [],
      toolMode: isApiKey ? toolMode : 'all',
      allowedTools: isApiKey ? patternLines(allowedTools) : [],
      deniedTools: isApiKey ? patternLines(deniedTools) : [],
    });
  };

  return (
    <form className="policy-editor technical-policy-editor" onSubmit={submit}>
      <div className="policy-editor-heading">
        <span className={`policy-editor-icon ${isApiKey ? 'amber' : 'violet'}`}>
          {isApiKey ? <KeyRound size={18} /> : <Bot size={18} />}
        </span>
        <div>
          <span className="eyebrow">{isApiKey ? 'MACHINE CREDENTIAL' : 'AGENT TOOL IDENTITY'}</span>
          <h2>{identity.label}</h2>
          <p>{identity.secondary}</p>
        </div>
        <span className={`user-policy-status${identity.enabled ? '' : ' is-disabled'}`}>
          {identity.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <section className="policy-editor-section">
        <div className="policy-section-title">
          <ShieldCheck size={15} />
          <span><small>POLICY BOUNDARY</small><b>Assigned composite</b></span>
        </div>
        <p className="policy-help">
          {isApiKey
            ? 'The composite adds a reusable bundle and tool boundary on top of this key’s own restrictions.'
            : 'The selected composite defines which bundle tools enter the Agent context. No assignment keeps the Agent unrestricted.'}
        </p>
        <div className="technical-composite-grid">
          <button type="button" className={compositeId == null ? 'is-selected' : ''} onClick={() => setCompositeId(null)}>
            <span className="policy-list-icon blue"><Boxes size={14} /></span>
            <span><b>No composite</b><small>{isApiKey ? 'Use key-level restrictions only' : 'Unrestricted Agent tool catalog'}</small></span>
            <span className="connection-check">{compositeId == null && <Check size={12} />}</span>
          </button>
          {data.composites.map(composite => {
            const selected = compositeId === composite.id;
            return (
              <button
                type="button"
                className={`${selected ? 'is-selected' : ''}${composite.enabled ? '' : ' is-disabled'}`}
                disabled={!composite.enabled && !selected}
                onClick={() => setCompositeId(composite.id)}
                key={composite.id}
              >
                <span className="policy-list-icon"><ShieldCheck size={14} /></span>
                <span><b>{composite.name}</b><small>{composite.bundleMode === 'all' ? 'All bundles' : `${composite.includedBundleIds.length} bundles`} · {composite.enabled ? 'enabled' : 'disabled'}</small></span>
                <span className="connection-check">{selected && <Check size={12} />}</span>
              </button>
            );
          })}
        </div>
      </section>

      {isApiKey && (
        <>
          <section className="policy-editor-section">
            <div className="policy-section-title"><Boxes size={15} /><span><small>KEY BOUNDARY</small><b>Allowed bundles</b></span></div>
            <div className="policy-mode-switch">
              <button type="button" className={bundleMode === 'all' ? 'is-active' : ''} onClick={() => setBundleMode('all')}>
                <Boxes size={14} /><span><b>All bundles</b><small>Includes bundles created later</small></span>
              </button>
              <button type="button" className={bundleMode === 'selected' ? 'is-active' : ''} onClick={() => setBundleMode('selected')}>
                <LockKeyhole size={14} /><span><b>Selected bundles</b><small>Explicit fail-closed scope</small></span>
              </button>
            </div>
            {bundleMode === 'all' ? (
              <div className="policy-scope-warning">
                <AlertTriangle size={14} /><span>This API key can reach tools from future bundles unless its composite or tool patterns reduce access.</span>
              </div>
            ) : (
              <div className="policy-bundle-grid technical-bundle-grid">
                {data.bundles.map(bundle => {
                  const checked = selectedBundles.has(bundle.id);
                  return (
                    <label className={`policy-bundle-option${checked ? ' is-selected' : ''}`} key={bundle.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setBundleIds(current =>
                          current.includes(bundle.id)
                            ? current.filter(id => id !== bundle.id)
                            : [...current, bundle.id],
                        )}
                      />
                      <span className="connection-check">{checked && <Check size={12} />}</span>
                      <span aria-hidden="true">{bundle.icon || '◈'}</span>
                      <span><b>{bundle.label}</b><small>{bundle.toolCount} tools</small></span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <section className="policy-editor-section">
            <div className="policy-section-title"><Wrench size={15} /><span><small>FINAL KEY FILTER</small><b>Tool patterns</b></span></div>
            <div className="policy-mode-switch technical-tool-mode">
              <button type="button" className={toolMode === 'all' ? 'is-active' : ''} onClick={() => setToolMode('all')}>
                <Wrench size={14} /><span><b>All scoped tools</b><small>No key-level allowlist</small></span>
              </button>
              <button type="button" className={toolMode === 'selected' ? 'is-active' : ''} onClick={() => setToolMode('selected')}>
                <LockKeyhole size={14} /><span><b>Pattern allowlist</b><small>Only matching tool names</small></span>
              </button>
            </div>
            <p className="policy-help technical-pattern-help">One glob per line. Deny is evaluated after allow and always wins.</p>
            <div className="policy-field-grid">
              <label className="editor-field">
                <span>Allowed tool patterns</span>
                <textarea
                  className="policy-pattern-textarea"
                  rows={6}
                  disabled={toolMode === 'all'}
                  value={allowedTools}
                  onChange={event => setAllowedTools(event.target.value)}
                  placeholder={'jira_*\nbitbucket_get_*'}
                />
              </label>
              <label className="editor-field">
                <span>Denied tool patterns</span>
                <textarea
                  className="policy-pattern-textarea is-deny"
                  rows={6}
                  value={deniedTools}
                  onChange={event => setDeniedTools(event.target.value)}
                  placeholder={'*_delete\n*_destroy'}
                />
              </label>
            </div>
          </section>
        </>
      )}

      {!isApiKey && compositeId == null && (
        <div className="policy-scope-warning">
          <AlertTriangle size={14} />
          <span>This Agent currently receives the unrestricted tool catalog. Assign a Composite for an explicit fail-closed boundary.</span>
        </div>
      )}
      {error && <div className="access-manager-error" role="alert">{error}</div>}
      <footer className="policy-editor-footer">
        <small className="policy-save-note">
          {isApiKey ? `Credential scope: ${identity.scope ?? 'both'} · cache refreshes immediately` : 'Takes effect on the next Agent execution'}
        </small>
        <button
          className="button button-primary"
          type="submit"
          disabled={saving || (isApiKey && bundleMode === 'selected' && bundleIds.length === 0) || (isApiKey && toolMode === 'selected' && patternLines(allowedTools).length === 0)}
        >
          <ShieldCheck size={14} />{saving ? 'Saving…' : 'Save technical policy'}
        </button>
      </footer>
    </form>
  );
}

const simulatorKindLabels: Record<AccessPolicySimulatorPrincipalKind, string> = {
  user: 'Users',
  agent: 'Agents',
  api_key: 'API keys',
  group: 'Groups',
  composite: 'Composites',
};

function PolicySimulator({ data }: { data: AccessPolicyResponse }) {
  const availableKinds = useMemo(
    () => (Object.keys(simulatorKindLabels) as AccessPolicySimulatorPrincipalKind[])
      .filter(kind => data.simulatorPrincipals.some(principal => principal.kind === kind)),
    [data.simulatorPrincipals],
  );
  const [principalKind, setPrincipalKind] = useState<AccessPolicySimulatorPrincipalKind>(availableKinds[0] ?? 'user');
  const principals = useMemo(
    () => data.simulatorPrincipals.filter(principal => principal.kind === principalKind),
    [data.simulatorPrincipals, principalKind],
  );
  const [principalId, setPrincipalId] = useState(principals[0]?.id ?? '');
  const [toolName, setToolName] = useState(data.tools[0] ?? '');
  const simulation = useMutation({
    mutationFn: simulateAccessPolicy,
  });

  useEffect(() => {
    if (!principals.some(principal => principal.id === principalId)) {
      setPrincipalId(principals[0]?.id ?? '');
      simulation.reset();
    }
  }, [principalId, principals]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    simulation.mutate({ principalKind, principalId, toolName: toolName.trim() });
  };
  const result: AccessPolicySimulation | undefined = simulation.data;

  return (
    <section className="policy-simulator">
      <form className="policy-simulator-controls" onSubmit={submit}>
        <div className="policy-editor-heading">
          <span className="policy-editor-icon blue"><FlaskConical size={18} /></span>
          <div>
            <span className="eyebrow">EFFECTIVE ACCESS</span>
            <h2>Policy Simulator</h2>
            <p>Test one principal against one tool using the same decision order as runtime enforcement.</p>
          </div>
          <span className="simulator-readonly"><LockKeyhole size={11} />Read only</span>
        </div>

        <div className="simulator-input-grid">
          <label className="editor-field">
            <span>Principal type</span>
            <select
              value={principalKind}
              onChange={event => {
                const kind = event.target.value as AccessPolicySimulatorPrincipalKind;
                setPrincipalKind(kind);
                setPrincipalId(data.simulatorPrincipals.find(principal => principal.kind === kind)?.id ?? '');
                simulation.reset();
              }}
            >
              {availableKinds.map(kind => <option value={kind} key={kind}>{simulatorKindLabels[kind]}</option>)}
            </select>
          </label>
          <label className="editor-field">
            <span>Principal</span>
            <select value={principalId} onChange={event => { setPrincipalId(event.target.value); simulation.reset(); }}>
              {principals.map(principal => (
                <option value={principal.id} key={`${principal.kind}-${principal.id}`}>
                  {principal.label}{principal.enabled ? '' : ' (disabled)'}
                </option>
              ))}
            </select>
          </label>
          <label className="editor-field simulator-tool-field">
            <span>Tool name</span>
            <div>
              <Wrench size={14} />
              <input
                required
                list="policy-simulator-tools"
                maxLength={256}
                value={toolName}
                onChange={event => { setToolName(event.target.value); simulation.reset(); }}
                placeholder="Select or enter an exact tool name"
              />
              <datalist id="policy-simulator-tools">
                {data.tools.map(tool => <option value={tool} key={tool} />)}
              </datalist>
            </div>
          </label>
          <button className="button button-primary simulator-run" type="submit" disabled={!principalId || !toolName.trim() || simulation.isPending}>
            <FlaskConical size={14} />{simulation.isPending ? 'Evaluating…' : 'Evaluate access'}
          </button>
        </div>
        <p className="policy-help simulator-help">
          Results reflect stored policies now. Runtime approvals, tool hooks and downstream system permissions can still reduce access later.
        </p>
      </form>

      {simulation.error && <div className="access-manager-error" role="alert">{simulation.error.message}</div>}

      {!result && !simulation.error && (
        <div className="simulator-empty">
          <span><FlaskConical size={22} /></span>
          <b>Ready to explain a decision</b>
          <p>Choose a principal and tool, then run the evaluation to inspect every policy layer.</p>
        </div>
      )}

      {result && (
        <div className={`simulator-result is-${result.decision}`} aria-live="polite">
          <header className="simulator-verdict">
            <span className="simulator-verdict-icon">
              {result.decision === 'allow' ? <CheckCircle2 size={25} /> : <XCircle size={25} />}
            </span>
            <div>
              <span className="eyebrow">EFFECTIVE DECISION</span>
              <h2>{result.decision === 'allow' ? 'Access allowed' : 'Access denied'}</h2>
              <p><b>{result.principal.label}</b> → <code>{result.toolName}</code></p>
            </div>
            <span className="simulator-mode">{result.policyMode ? 'Policy mode' : 'Fallback mode'}</span>
          </header>

          <section className="simulator-reason">
            <span>Final reason</span>
            <strong>{result.reason}</strong>
            {result.rawDecision === 'no_rule' && <small>No explicit deny matched; the request is blocked by default-deny.</small>}
          </section>

          <div className="simulator-layout">
            <section className="simulator-trace">
              <div className="policy-section-title"><ShieldCheck size={15} /><span><small>DECISION TRACE</small><b>Evaluation order</b></span></div>
              {result.steps.map((step, index) => (
                <article className={`simulator-step is-${step.outcome}`} key={`${step.key}-${index}`}>
                  <span className="simulator-step-index">{index + 1}</span>
                  <div>
                    <header><b>{step.label}</b><em>{step.outcome}</em></header>
                    <p>{step.detail}</p>
                    {step.source && <small>Source: {step.source}</small>}
                    {step.evidence.length > 0 && (
                      <div className="simulator-evidence">
                        {step.evidence.map(item => <code key={item}>{item}</code>)}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>

            <aside className="simulator-context">
              <div className="policy-section-title">
                {result.principal.kind === 'agent' ? <Bot size={15} /> : <KeyRound size={15} />}
                <span><small>CONTEXT</small><b>Resolved principal</b></span>
              </div>
              <dl>
                <div><dt>Type</dt><dd>{simulatorKindLabels[result.principal.kind].replace(/s$/, '')}</dd></div>
                <div><dt>Identity</dt><dd>{result.principal.label}</dd></div>
                <div><dt>Details</dt><dd>{result.principal.secondary}</dd></div>
                <div><dt>Status</dt><dd>{result.principal.enabled ? 'Enabled' : 'Disabled'}</dd></div>
              </dl>
              <div className="simulator-source-list">
                <span>Policy sources</span>
                {result.sources.length > 0
                  ? result.sources.map(source => <code key={source}>{source}</code>)
                  : <small>No assigned composite or group source.</small>}
              </div>
            </aside>
          </div>
        </div>
      )}
    </section>
  );
}

export function PoliciesPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['access-policies'], queryFn: getAccessPolicies, staleTime: 15_000 });
  const [tab, setTab] = useState<PolicyTab>(initialPolicyTab);
  const [search, setSearch] = useState('');
  const [selectedCompositeId, setSelectedCompositeId] = useState<number | 'new' | null>(null);
  const [selectedGroupName, setSelectedGroupName] = useState<string | 'new' | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(initialPolicyUserId);
  const [selectedTechnicalId, setSelectedTechnicalId] = useState<string | null>(null);

  useEffect(() => {
    if (!query.data) return;
    if (tab === 'composites' && selectedCompositeId == null) setSelectedCompositeId(query.data.composites[0]?.id ?? 'new');
    if (tab === 'groups' && selectedGroupName == null) setSelectedGroupName(query.data.groups[0]?.name ?? 'new');
    if (tab === 'users' && (selectedUserId == null || !query.data.users.some(user => user.id === selectedUserId))) {
      setSelectedUserId(query.data.users[0]?.id ?? null);
    }
    if (tab === 'technical' && selectedTechnicalId == null) {
      const first = query.data.technicalIdentities[0];
      setSelectedTechnicalId(first ? `${first.kind}:${first.id}` : null);
    }
  }, [query.data, selectedCompositeId, selectedGroupName, selectedTechnicalId, selectedUserId, tab]);

  const saveComposite = useMutation({
    mutationFn: ({ input, id }: { input: AccessPolicyCompositeMutation; id?: number }) =>
      saveAccessPolicyComposite(input, id),
    onSuccess: async result => {
      setSelectedCompositeId(result.composite.id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      ]);
    },
  });
  const deleteComposite = useMutation({
    mutationFn: deleteAccessPolicyComposite,
    onSuccess: async () => {
      setSelectedCompositeId('new');
      await queryClient.invalidateQueries({ queryKey: ['access-policies'] });
    },
  });
  const saveGroup = useMutation({
    mutationFn: saveAccessPolicyGroup,
    onSuccess: async result => {
      setSelectedGroupName(result.groupName);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      ]);
    },
  });
  const saveUser = useMutation({
    mutationFn: saveAccessPolicyUser,
    onSuccess: async result => {
      setSelectedUserId(result.userId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      ]);
    },
  });
  const saveTechnical = useMutation({
    mutationFn: saveAccessPolicyTechnicalIdentity,
    onSuccess: async result => {
      setSelectedTechnicalId(`${result.kind}:${result.id}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      ]);
    },
  });

  const normalized = search.trim().toLowerCase();
  const visibleComposites = (query.data?.composites ?? []).filter(policy =>
    !normalized || `${policy.name} ${policy.description} ${policy.groupNames.join(' ')}`.toLowerCase().includes(normalized),
  );
  const visibleGroups = (query.data?.groups ?? []).filter(group =>
    !normalized || group.name.toLowerCase().includes(normalized),
  );
  const visibleUsers = (query.data?.users ?? []).filter(user =>
    !normalized || `${user.label} ${user.username} ${user.role} ${user.entraGroups.join(' ')}`.toLowerCase().includes(normalized),
  );
  const visibleTechnical = (query.data?.technicalIdentities ?? []).filter(identity =>
    !normalized || `${identity.label} ${identity.secondary} ${identity.kind}`.toLowerCase().includes(normalized),
  );

  if (query.isLoading) return <LoadingState label="Loading access policies…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const selectedComposite = typeof selectedCompositeId === 'number'
    ? query.data.composites.find(policy => policy.id === selectedCompositeId) ?? null
    : null;
  const selectedGroup = selectedGroupName && selectedGroupName !== 'new'
    ? query.data.groups.find(group => group.name === selectedGroupName) ?? null
    : null;
  const selectedUser = selectedUserId != null
    ? query.data.users.find(user => user.id === selectedUserId) ?? null
    : null;
  const selectedTechnical = selectedTechnicalId
    ? query.data.technicalIdentities.find(identity => `${identity.kind}:${identity.id}` === selectedTechnicalId) ?? null
    : null;
  const stats = query.data.stats;
  const navigateToPostureTarget = (target: AccessPolicyPostureTarget) => {
    setSearch('');
    setTab(target.tab);
    if (target.tab === 'composites') setSelectedCompositeId(target.id === 'new' ? 'new' : Number(target.id));
    if (target.tab === 'groups') setSelectedGroupName(target.id);
    if (target.tab === 'users') setSelectedUserId(Number(target.id));
    if (target.tab === 'technical') setSelectedTechnicalId(target.id);
  };

  return (
    <>
      <PageHeader
        eyebrow="GOVERN · ACCESS"
        title="Access Policies"
        description="Compose bundle boundaries, filter capabilities and bind identity-provider groups."
        actions={<a className="button button-secondary" href="/mcp-fabric"><Boxes size={15} />Open MCP Fabric</a>}
      />

      <section className="metric-grid fabric-metrics" aria-label="Access policy summary">
        <article className="metric-card"><span className="metric-icon teal"><ShieldCheck size={17} /></span><div><span>Composites</span><strong>{stats.composites}</strong><small>{stats.enabled} enabled</small></div></article>
        <article className="metric-card"><span className="metric-icon violet"><Users size={17} /></span><div><span>Identity groups</span><strong>{stats.groups}</strong><small>known and configured</small></div></article>
        <article className="metric-card"><span className="metric-icon blue"><Boxes size={17} /></span><div><span>Bundles</span><strong>{query.data.bundles.length}</strong><small>available scopes</small></div></article>
        <article className="metric-card"><span className="metric-icon amber"><Wrench size={17} /></span><div><span>Group overrides</span><strong>{stats.rules}</strong><small>explicit tool rules</small></div></article>
      </section>

      <div className="policy-tabs" role="tablist">
        <button type="button" className={tab === 'posture' ? 'is-active' : ''} onClick={() => setTab('posture')}>
          <Gauge size={15} />Policy posture
        </button>
        <button type="button" className={tab === 'composites' ? 'is-active' : ''} onClick={() => setTab('composites')}>
          <ShieldCheck size={15} />Composite policies
        </button>
        <button type="button" className={tab === 'groups' ? 'is-active' : ''} onClick={() => setTab('groups')}>
          <Users size={15} />Group bindings
        </button>
        <button type="button" className={tab === 'users' ? 'is-active' : ''} onClick={() => setTab('users')}>
          <UserRound size={15} />User assignments
        </button>
        <button type="button" className={tab === 'technical' ? 'is-active' : ''} onClick={() => setTab('technical')}>
          <KeyRound size={15} />Technical identities
        </button>
        <button type="button" className={tab === 'simulator' ? 'is-active' : ''} onClick={() => setTab('simulator')}>
          <FlaskConical size={15} />Policy simulator
        </button>
      </div>

      {tab === 'posture'
        ? <PolicyPostureDashboard data={query.data} onNavigate={navigateToPostureTarget} />
        : tab === 'simulator' ? <PolicySimulator data={query.data} /> : <section className="policy-workbench">
        <aside className="policy-master">
          <div className="policy-master-toolbar">
            <label className="search-field"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${tab}`} /></label>
            {tab !== 'users' && tab !== 'technical' && (
              <button
                type="button"
                aria-label={tab === 'composites' ? 'New composite' : 'New group policy'}
                onClick={() => tab === 'composites' ? setSelectedCompositeId('new') : setSelectedGroupName('new')}
              >
                <Plus size={16} />
              </button>
            )}
          </div>
          <div className="policy-master-list">
            {tab === 'composites' ? visibleComposites.map(policy => (
              <button
                type="button"
                className={selectedCompositeId === policy.id ? 'is-selected' : ''}
                onClick={() => {
                  saveComposite.reset();
                  deleteComposite.reset();
                  setSelectedCompositeId(policy.id);
                }}
                key={policy.id}
              >
                <span className={`policy-list-icon${policy.enabled ? '' : ' is-disabled'}`}><ShieldCheck size={15} /></span>
                <span><b>{policy.name}</b><small>{policy.bundleMode === 'all' ? 'All bundles' : `${policy.includedBundleIds.length} bundles`} · {usageCount(policy)} assignments</small></span>
                <em>{policy.toolDenyPatterns.length > 0 ? `${policy.toolDenyPatterns.length} deny` : 'open'}</em>
              </button>
            )) : tab === 'groups' ? visibleGroups.map(group => (
              <button
                type="button"
                className={selectedGroupName === group.name ? 'is-selected' : ''}
                onClick={() => {
                  saveGroup.reset();
                  setSelectedGroupName(group.name);
                }}
                key={group.name}
              >
                <span className="policy-list-icon violet"><Users size={15} /></span>
                <span><b>{group.name}</b><small>{group.memberCount} members · {group.compositeIds.length} policies</small></span>
                <em>{group.rules.length} rules</em>
              </button>
            )) : tab === 'users' ? visibleUsers.map(user => (
              <button
                type="button"
                className={selectedUserId === user.id ? 'is-selected' : ''}
                onClick={() => {
                  saveUser.reset();
                  setSelectedUserId(user.id);
                }}
                key={user.id}
              >
                <span className={`policy-list-icon blue${user.enabled ? '' : ' is-disabled'}`}><UserRound size={15} /></span>
                <span><b>{user.label}</b><small>{user.username} · {user.role}</small></span>
                <em>{user.compositeIds.length} policies</em>
              </button>
            )) : visibleTechnical.map(identity => {
              const identityKey = `${identity.kind}:${identity.id}`;
              return (
                <button
                  type="button"
                  className={selectedTechnicalId === identityKey ? 'is-selected' : ''}
                  onClick={() => {
                    saveTechnical.reset();
                    setSelectedTechnicalId(identityKey);
                  }}
                  key={identityKey}
                >
                  <span className={`policy-list-icon ${identity.kind === 'agent' ? 'violet' : 'amber'}${identity.enabled ? '' : ' is-disabled'}`}>
                    {identity.kind === 'agent' ? <Bot size={15} /> : <KeyRound size={15} />}
                  </span>
                  <span><b>{identity.label}</b><small>{identity.secondary}</small></span>
                  <em>{identity.compositeId == null ? 'open' : 'composite'}</em>
                </button>
              );
            })}
            {(tab === 'composites'
              ? visibleComposites.length
              : tab === 'groups'
                ? visibleGroups.length
                : tab === 'users' ? visibleUsers.length : visibleTechnical.length) === 0 && (
              <div className="policy-master-empty">No matching {tab}.</div>
            )}
          </div>
        </aside>

        <div className="policy-detail">
          {tab === 'composites' ? (
            <CompositeEditor
              key={selectedCompositeId ?? 'new'}
              policy={selectedComposite}
              data={query.data}
              saving={saveComposite.isPending}
              deleting={deleteComposite.isPending}
              error={saveComposite.error?.message ?? deleteComposite.error?.message ?? null}
              onSave={input => saveComposite.mutate({
                input,
                ...(typeof selectedCompositeId === 'number' ? { id: selectedCompositeId } : {}),
              })}
              onDelete={selectedComposite ? () => deleteComposite.mutate(selectedComposite.id) : null}
            />
          ) : tab === 'groups' ? (
            <GroupPolicyEditor
              key={selectedGroupName ?? 'new'}
              group={selectedGroup}
              data={query.data}
              saving={saveGroup.isPending}
              error={saveGroup.error?.message ?? null}
              onSave={input => saveGroup.mutate(input)}
            />
          ) : tab === 'users' && selectedUser ? (
            <UserPolicyEditor
              key={selectedUser.id}
              user={selectedUser}
              data={query.data}
              saving={saveUser.isPending}
              error={saveUser.error?.message ?? null}
              onSave={input => saveUser.mutate(input)}
            />
          ) : tab === 'technical' && selectedTechnical ? (
            <TechnicalIdentityEditor
              key={`${selectedTechnical.kind}:${selectedTechnical.id}`}
              identity={selectedTechnical}
              data={query.data}
              saving={saveTechnical.isPending}
              error={saveTechnical.error?.message ?? null}
              onSave={input => saveTechnical.mutate(input)}
            />
          ) : (
            <EmptyState
              title={tab === 'technical' ? 'No technical identities' : 'No users'}
              description={tab === 'technical'
                ? 'Create an Agent or API key before assigning its policy boundary.'
                : 'Create a platform user before assigning direct policies.'}
            />
          )}
        </div>
      </section>}
    </>
  );
}

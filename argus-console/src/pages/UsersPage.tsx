import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  Building2,
  Check,
  CheckCircle2,
  Clock3,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import {
  changeAdminUserPassword,
  createAdminUser,
  deleteAdminUser,
  getAdminUsers,
  getFabric,
  getOverview,
  updateAdminUser,
} from '../api';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/Ui';
import type {
  AdminUser,
  AdminUserCreateMutation,
  AdminUserUpdateMutation,
  AdminWorkspaceScope,
  ArgusUserRole,
  FabricBundle,
} from '../types';

const ROLES: Array<{ value: ArgusUserRole; label: string; description: string }> = [
  { value: 'platform_admin', label: 'Platform admin', description: 'Full platform and identity administration' },
  { value: 'operations_admin', label: 'Operations admin', description: 'Operate agents, fabric and credentials' },
  { value: 'developer', label: 'Developer', description: 'Build and test agents and workflows' },
  { value: 'agent_operator', label: 'Agent operator', description: 'Run agents and handle approvals' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only dashboards and status' },
  { value: 'chat_user', label: 'Chat user', description: 'Chat-only minimum privilege' },
];

const WORKSPACE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const DEFAULT_WORKSPACE_SCOPE: AdminWorkspaceScope = {
  tenant_key: 'default', workspace_key: 'default', is_default: true,
};

function normalizedRole(role: AdminUser['role']): ArgusUserRole {
  if (role === 'admin') return 'platform_admin';
  if (role === 'editor') return 'developer';
  return role;
}

function roleLabel(role: AdminUser['role']): string {
  return ROLES.find(option => option.value === normalizedRole(role))?.label ?? role;
}

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}

function passwordError(password: string, username: string, confirmation: string): string | null {
  if (password !== confirmation) return 'Passwords do not match.';
  if (password.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Use an uppercase letter, a lowercase letter and a number.';
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain the username.';
  }
  return null;
}

function UserEditor({
  user,
  bundles,
  isSelf,
  saving,
  serverError,
  onClose,
  onSave,
}: {
  user: AdminUser | null;
  bundles: FabricBundle[];
  isSelf: boolean;
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (input: AdminUserCreateMutation | AdminUserUpdateMutation) => void;
}) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [role, setRole] = useState<ArgusUserRole>(user ? normalizedRole(user.role) : 'viewer');
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [bundleMode, setBundleMode] = useState<'all' | 'selected'>(user?.allowed_bundles == null && user ? 'all' : 'selected');
  const [bundleIds, setBundleIds] = useState<number[]>(user?.allowed_bundles ?? []);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [workspaceScopes, setWorkspaceScopes] = useState<AdminWorkspaceScope[]>(
    user?.workspace_scopes?.length ? user.workspace_scopes : [DEFAULT_WORKSPACE_SCOPE],
  );
  const [tenantKey, setTenantKey] = useState('');
  const [workspaceKey, setWorkspaceKey] = useState('');

  const addWorkspace = () => {
    const tenant = tenantKey.trim();
    const workspace = workspaceKey.trim();
    if (!WORKSPACE_KEY.test(tenant) || !WORKSPACE_KEY.test(workspace)) {
      setValidation('Tenant and workspace keys must start with a letter or number and use only . _ : @ / or -.');
      return;
    }
    if (workspaceScopes.some(scope => scope.tenant_key === tenant && scope.workspace_key === workspace)) {
      setValidation('This tenant and workspace membership already exists.');
      return;
    }
    if (workspaceScopes.length >= 32) {
      setValidation('A user can have at most 32 workspace memberships.');
      return;
    }
    setWorkspaceScopes(current => [...current, { tenant_key: tenant, workspace_key: workspace, is_default: false }]);
    setTenantKey('');
    setWorkspaceKey('');
    setValidation(null);
  };

  const removeWorkspace = (index: number) => {
    if (workspaceScopes.length === 1) {
      setValidation('Every user must retain at least one workspace membership.');
      return;
    }
    setWorkspaceScopes(current => {
      const removedDefault = current[index]?.is_default === true;
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      return removedDefault
        ? next.map((scope, itemIndex) => ({ ...scope, is_default: itemIndex === 0 }))
        : next;
    });
    setValidation(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setValidation(null);
    const cleanUsername = username.trim();
    const cleanDisplayName = displayName.trim();
    if (!cleanDisplayName || (!user && !cleanUsername)) {
      setValidation('Username and display name are required.');
      return;
    }
    if (!user) {
      const issue = passwordError(password, cleanUsername, confirmation);
      if (issue) { setValidation(issue); return; }
    }
    const common = {
      display_name: cleanDisplayName,
      role,
      enabled,
      allowed_bundles: bundleMode === 'all' ? null : bundleIds,
      workspace_scopes: workspaceScopes,
    };
    onSave(user ? common : { ...common, username: cleanUsername, password });
  };

  return (
    <div className="user-editor-layer" role="presentation">
      <form className="user-editor" role="dialog" aria-modal="true" aria-labelledby="user-editor-title" onSubmit={submit}>
        <header>
          <span className="user-editor-icon"><UserRound size={19} /></span>
          <div><span className="eyebrow">HUMAN IDENTITY</span><h2 id="user-editor-title">{user ? `Edit ${user.username}` : 'Create user'}</h2><p>Set the platform role and base resource boundary.</p></div>
          <button type="button" aria-label="Close user editor" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="user-editor-body">
          <section>
            <div className="user-section-title"><UserRound size={15} /><span><small>IDENTITY</small><b>Profile and status</b></span></div>
            <div className="policy-field-grid">
              <label className="editor-field"><span>Username <em>required</em></span><input required disabled={Boolean(user)} maxLength={128} autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="alex.morgan" /></label>
              <label className="editor-field"><span>Display name <em>required</em></span><input required maxLength={160} value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Alex Morgan" /></label>
              <label className="editor-field"><span>Platform role</span><select disabled={isSelf} value={role} onChange={event => setRole(event.target.value as ArgusUserRole)}>{ROLES.map(option => <option value={option.value} key={option.value}>{option.label} — {option.description}</option>)}</select></label>
            </div>
            <label className="policy-enabled-toggle user-enabled-toggle"><input type="checkbox" disabled={isSelf} checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>{enabled ? 'User enabled' : 'User disabled'}</span></label>
            {isSelf && <div className="user-safety-note"><ShieldCheck size={14} /><span>Your own role and active state are locked here to prevent accidental administrator lockout.</span></div>}
          </section>

          {!user && <section>
            <div className="user-section-title"><KeyRound size={15} /><span><small>LOCAL SIGN-IN</small><b>Initial password</b></span></div>
            <div className="policy-field-grid">
              <label className="editor-field"><span>Password <em>required</em></span><input required type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
              <label className="editor-field"><span>Confirm password <em>required</em></span><input required type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
            </div>
            <p className="policy-help">At least 10 characters with uppercase, lowercase and a number. Do not include the username.</p>
          </section>}

          <section>
            <div className="user-section-title"><Building2 size={15} /><span><small>TENANT BOUNDARY</small><b>Authorized workspaces</b></span></div>
            <p className="policy-help">Requests may select only these server-authorized scopes. The default is used when no scope is selected explicitly.</p>
            <div className="user-workspace-list">
              {workspaceScopes.map((scope, index) => (
                <div className={scope.is_default ? 'is-default' : ''} key={`${scope.tenant_key}/${scope.workspace_key}`}>
                  <label title="Use as the default workspace">
                    <input
                      type="radio"
                      name="default-workspace"
                      aria-label={`Use ${scope.tenant_key}/${scope.workspace_key} as default`}
                      checked={scope.is_default}
                      onChange={() => setWorkspaceScopes(current => current.map((item, itemIndex) => ({ ...item, is_default: itemIndex === index })))}
                    />
                    <Star size={13} />
                  </label>
                  <span><b>{scope.workspace_key}</b><small>{scope.tenant_key}</small></span>
                  {scope.is_default && <em>Default</em>}
                  <button type="button" aria-label={`Remove ${scope.tenant_key}/${scope.workspace_key}`} onClick={() => removeWorkspace(index)}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <div className="user-workspace-add">
              <label className="editor-field"><span>Tenant key</span><input value={tenantKey} onChange={event => setTenantKey(event.target.value)} placeholder="acme" maxLength={128} /></label>
              <label className="editor-field"><span>Workspace key</span><input value={workspaceKey} onChange={event => setWorkspaceKey(event.target.value)} placeholder="platform-team" maxLength={128} /></label>
              <button className="button button-secondary" type="button" onClick={addWorkspace}><Plus size={14} />Add workspace</button>
            </div>
          </section>

          <section>
            <div className="user-section-title"><Boxes size={15} /><span><small>BASE RESOURCE SCOPE</small><b>Allowed bundles</b></span></div>
            <div className="policy-mode-switch">
              <button type="button" className={bundleMode === 'selected' ? 'is-active' : ''} onClick={() => setBundleMode('selected')}><LockKeyhole size={14} /><span><b>Selected bundles</b><small>Least-privilege boundary</small></span></button>
              <button type="button" className={bundleMode === 'all' ? 'is-active' : ''} onClick={() => setBundleMode('all')}><Boxes size={14} /><span><b>All bundles</b><small>Includes future bundles</small></span></button>
            </div>
            {bundleMode === 'all' ? <div className="policy-scope-warning"><AlertTriangle size={14} /><span>This identity can reach current and future bundles before more specific policy rules are applied.</span></div> : (
              <div className="user-bundle-grid">
                {bundles.map(bundle => {
                  const checked = bundleIds.includes(bundle.id);
                  return <label className={checked ? 'is-selected' : ''} key={bundle.id}><input type="checkbox" checked={checked} onChange={() => setBundleIds(current => checked ? current.filter(id => id !== bundle.id) : [...current, bundle.id])} /><span className="connection-check">{checked && <Check size={12} />}</span><span aria-hidden="true">{bundle.icon || '◈'}</span><span><b>{bundle.label}</b><small>{bundle.toolCount} tools</small></span></label>;
                })}
                {bundles.length === 0 && <small>No bundles are currently available.</small>}
              </div>
            )}
          </section>
        </div>
        {(validation || serverError) && <div className="editor-error" role="alert"><AlertTriangle size={15} />{validation || serverError}</div>}
        <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : user ? 'Save user' : 'Create user'}</button></footer>
      </form>
    </div>
  );
}

function PasswordDialog({ user, saving, serverError, onClose, onSave }: {
  user: AdminUser;
  saving: boolean;
  serverError: string | null;
  onClose: () => void;
  onSave: (password: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = passwordError(password, user.username, confirmation);
    if (issue) { setValidation(issue); return; }
    onSave(password);
  };
  return <div className="user-editor-layer" role="presentation"><form className="user-password-dialog" role="dialog" aria-modal="true" aria-labelledby="user-password-title" onSubmit={submit}>
    <span className="user-password-icon"><KeyRound size={21} /></span><span className="eyebrow">LOCAL SIGN-IN</span><h2 id="user-password-title">Reset password for {user.username}</h2><p>The previous password stops working immediately. Argus never displays stored passwords.</p>
    <label className="editor-field"><span>New password</span><input required type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    <label className="editor-field"><span>Confirm password</span><input required type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
    {(validation || serverError) && <div className="editor-error" role="alert"><AlertTriangle size={15} />{validation || serverError}</div>}
    <footer><button className="button button-secondary" type="button" onClick={onClose}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Updating…' : 'Reset password'}</button></footer>
  </form></div>;
}

export function UsersPage() {
  const [editorTarget, setEditorTarget] = useState<'new' | number | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: getAdminUsers, staleTime: 10_000 });
  const fabricQuery = useQuery({ queryKey: ['mcp-fabric'], queryFn: getFabric, staleTime: 15_000 });
  const overviewQuery = useQuery({ queryKey: ['overview'], queryFn: getOverview, staleTime: 15_000 });
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
    queryClient.invalidateQueries({ queryKey: ['overview'] }),
  ]);
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: AdminUserCreateMutation | AdminUserUpdateMutation; id?: number }) =>
      id == null ? createAdminUser(input as AdminUserCreateMutation) : updateAdminUser(id, input as AdminUserUpdateMutation),
    onSuccess: async (user, variables) => { setEditorTarget(null); setNotice(`User “${user.username}” ${variables.id == null ? 'created' : 'updated'}.`); await refresh(); },
  });
  const passwordMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => changeAdminUserPassword(id, password),
    onSuccess: async () => { const user = usersQuery.data?.find(item => item.id === passwordTarget); setPasswordTarget(null); setNotice(`Password for “${user?.username ?? 'user'}” updated.`); await refresh(); },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteAdminUser(id),
    onSuccess: async () => { setDeleteTarget(null); setDeleteConfirmation(''); setNotice('User permanently deleted.'); await refresh(); },
  });

  if (usersQuery.isLoading || fabricQuery.isLoading || overviewQuery.isLoading) return <LoadingState label="Loading human identities…" />;
  if (usersQuery.error) return <ErrorState error={usersQuery.error} />;
  if (fabricQuery.error) return <ErrorState error={fabricQuery.error} />;
  if (overviewQuery.error) return <ErrorState error={overviewQuery.error} />;

  const users = usersQuery.data ?? [];
  const bundles = fabricQuery.data?.bundles ?? [];
  const currentUserId = overviewQuery.data?.user.id ?? -1;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleUsers = users.filter(user => !normalizedSearch || [user.username, user.display_name, roleLabel(user.role)].some(value => value.toLowerCase().includes(normalizedSearch)));
  const editorUser = typeof editorTarget === 'number' ? users.find(user => user.id === editorTarget) ?? null : null;
  const passwordUser = users.find(user => user.id === passwordTarget) ?? null;
  const active = users.filter(user => user.enabled).length;
  const admins = users.filter(user => normalizedRole(user.role) === 'platform_admin' && user.enabled).length;
  const neverLoggedIn = users.filter(user => !user.last_login).length;
  const bundleMap = new Map(bundles.map(bundle => [bundle.id, bundle]));
  const mutationError = saveMutation.error?.message ?? passwordMutation.error?.message ?? deleteMutation.error?.message ?? null;

  return <>
    <a className="back-link" href="/settings"><ArrowLeft size={14} />Back to settings</a>
    <PageHeader eyebrow="HUMAN IDENTITIES" title="Users & Roles" description="Manage local identities, platform responsibilities and base bundle access." actions={<button className="button button-primary" type="button" onClick={() => { saveMutation.reset(); setEditorTarget('new'); }}><Plus size={15} />Create user</button>} />
    {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {mutationError && !editorTarget && !passwordTarget && <div className="connection-notice is-error" role="alert"><AlertTriangle size={16} /><span>{mutationError}</span></div>}

    <section className="metric-grid user-metrics" aria-label="User summary">
      <article className="metric-card"><span className="metric-icon violet"><Users size={17} /></span><div><span>Users</span><strong>{users.length}</strong><small>managed identities</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><CheckCircle2 size={17} /></span><div><span>Active</span><strong>{active}</strong><small>can sign in</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><ShieldCheck size={17} /></span><div><span>Platform admins</span><strong>{admins}</strong><small>active custodians</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Clock3 size={17} /></span><div><span>Never signed in</span><strong>{neverLoggedIn}</strong><small>pending adoption</small></div></article>
    </section>

    <div className="user-toolbar"><label className="search-field"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search users, names or roles" aria-label="Search users" /></label><span>{visibleUsers.length} of {users.length} identities</span></div>

    {visibleUsers.length > 0 ? <section className="user-admin-grid" aria-label="Users">
      {visibleUsers.map(user => {
        const isSelf = user.id === currentUserId;
        const selectedBundles = user.allowed_bundles?.map(id => bundleMap.get(id)).filter((bundle): bundle is FabricBundle => Boolean(bundle)) ?? [];
        const confirmingDelete = deleteTarget === user.id;
        const workspaceScopes = user.workspace_scopes?.length ? user.workspace_scopes : [DEFAULT_WORKSPACE_SCOPE];
        return <article className={`user-admin-card${user.enabled ? '' : ' is-inactive'}`} key={user.id}>
          <header><span className="user-avatar">{(user.display_name || user.username).slice(0, 1).toUpperCase()}</span><span><small>@{user.username}</small><h2>{user.display_name}</h2></span><span className={`user-admin-state ${user.enabled ? 'is-active' : 'is-disabled'}`}>{user.enabled ? 'Active' : 'Disabled'}</span></header>
          <div className="user-admin-badges"><span className={`role-${normalizedRole(user.role)}`}><ShieldCheck size={10} />{roleLabel(user.role)}</span><span className={user.last_auth_method === 'oidc' || /^(?:entra|oidc):/.test(user.username) ? 'is-sso' : 'is-local'}><KeyRound size={10} />{user.last_auth_method === 'oidc' || /^(?:entra|oidc):/.test(user.username) ? 'SSO linked' : 'Local'}</span>{user.last_mfa_verified_at && <span className="is-mfa" title={`${user.last_mfa_method ?? 'MFA'} · ${formatDate(user.last_mfa_verified_at)}`}><LockKeyhole size={10} />MFA observed</span>}{isSelf && <span className="is-self">You</span>}</div>
          <div className="user-admin-facts"><span><small>Bundle scope</small><b>{user.allowed_bundles == null ? 'All bundles' : `${user.allowed_bundles.length} selected`}</b></span><span><small>Workspaces</small><b>{workspaceScopes.length} authorized</b></span><span><small>Last sign-in</small><b>{formatDate(user.last_login)}</b></span><span><small>Created</small><b>{formatDate(user.created_at)}</b></span></div>
          <div className="user-admin-scopes">{workspaceScopes.slice(0, 4).map(scope => <span className={scope.is_default ? 'is-default' : ''} key={`${scope.tenant_key}/${scope.workspace_key}`}>{scope.is_default && <Star size={10} />}{scope.tenant_key} / {scope.workspace_key}</span>)}{workspaceScopes.length > 4 && <span>+{workspaceScopes.length - 4}</span>}</div>
          <div className="user-admin-bundles">{user.allowed_bundles == null ? <span className="is-wide"><Boxes size={10} />All current and future bundles</span> : selectedBundles.slice(0, 4).map(bundle => <span key={bundle.id}>{bundle.icon || '◈'} {bundle.label}</span>)}{selectedBundles.length > 4 && <span>+{selectedBundles.length - 4}</span>}{user.allowed_bundles?.length === 0 && <span className="is-denied">No base bundle access</span>}</div>
          {confirmingDelete ? <div className="user-delete-confirm" role="alert"><AlertTriangle size={15} /><span><b>Delete {user.username} permanently?</b><small>Type the username to confirm. Sessions and identity bindings may stop working.</small><input value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} placeholder={user.username} aria-label={`Type ${user.username} to confirm deletion`} /></span><button type="button" onClick={() => { setDeleteTarget(null); setDeleteConfirmation(''); }}>Cancel</button><button className="is-danger" type="button" disabled={deleteConfirmation !== user.username || deleteMutation.isPending} onClick={() => deleteMutation.mutate(user.id)}>Confirm deletion</button></div> : <footer><a href={`/governance/policies?tab=users&user=${user.id}`}><ShieldCheck size={12} />Policies</a><button type="button" onClick={() => { saveMutation.reset(); setEditorTarget(user.id); }}><Pencil size={12} />Edit</button>{!(user.last_auth_method === 'oidc' || /^(?:entra|oidc):/.test(user.username)) && <button type="button" onClick={() => { passwordMutation.reset(); setPasswordTarget(user.id); }}><KeyRound size={12} />Password</button>}{!isSelf && <button className="is-danger" type="button" onClick={() => { deleteMutation.reset(); setDeleteConfirmation(''); setDeleteTarget(user.id); }}><Trash2 size={12} />Delete</button>}</footer>}
        </article>;
      })}
    </section> : <section className="panel"><EmptyState title={users.length ? 'No matching users' : 'No users'} description={users.length ? 'Try a different username, display name or role.' : 'Create a local identity to get started.'} /></section>}

    {editorTarget && <UserEditor key={String(editorTarget)} user={editorUser} bundles={bundles} isSelf={editorUser?.id === currentUserId} saving={saveMutation.isPending} serverError={saveMutation.error?.message ?? null} onClose={() => setEditorTarget(null)} onSave={input => saveMutation.mutate({ input, ...(typeof editorTarget === 'number' ? { id: editorTarget } : {}) })} />}
    {passwordUser && <PasswordDialog key={passwordUser.id} user={passwordUser} saving={passwordMutation.isPending} serverError={passwordMutation.error?.message ?? null} onClose={() => setPasswordTarget(null)} onSave={password => passwordMutation.mutate({ id: passwordUser.id, password })} />}
  </>;
}

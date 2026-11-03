import type { AuditReportCatalog } from '../../types';
import type {
  AiOpsGlobalReadiness,
  IdentitySecurityStatus,
  PlatformBackendHealthResponse,
  PlatformExecutionCertificateCatalog,
  SolutionPacksResponse,
} from '../../types';

export type PlatformReadinessState = 'ready' | 'attention' | 'blocked';
export type PlatformReadinessCheckState = 'pass' | 'warning' | 'fail' | 'unknown';
export type PlatformReadinessSource = 'backends' | 'identity' | 'aiops' | 'audit' | 'packs' | 'executionProofs';

export interface PlatformReadinessCheck {
  id: string;
  category: 'platform' | 'delivery' | 'observability' | 'identity' | 'evidence';
  title: string;
  detail: string;
  state: PlatformReadinessCheckState;
  required: boolean;
  href: string;
}

export interface PlatformReadinessSnapshot {
  schemaVersion: 1;
  kind: 'argus-platform-readiness-snapshot';
  profile: { id: 'pilot-demo'; label: 'Pilot & live demo' };
  generatedAt: string;
  state: PlatformReadinessState;
  score: number;
  summary: { passed: number; warnings: number; failed: number; unknown: number; total: number };
  checks: PlatformReadinessCheck[];
  backends: Array<{
    name: string;
    kind: 'mcp_backend' | 'internal';
    status: 'ok' | 'down' | 'unknown';
    latencyMs: number;
    error?: string;
  }>;
  unavailableSources: Array<{ source: PlatformReadinessSource; error: string }>;
  limitations: string[];
}

export interface PlatformReadinessSources {
  generatedAt: string;
  backends?: PlatformBackendHealthResponse;
  identity?: IdentitySecurityStatus;
  aiops?: AiOpsGlobalReadiness;
  audit?: AuditReportCatalog;
  packs?: SolutionPacksResponse;
  executionProofs?: PlatformExecutionCertificateCatalog;
  errors?: Partial<Record<PlatformReadinessSource, string>>;
}

const healthy = (value: { status: string } | undefined): boolean => value?.status === 'ok';

function unavailable(
  source: PlatformReadinessSource,
  title: string,
  href: string,
  required: boolean,
  message?: string,
): PlatformReadinessCheck {
  return {
    id: source,
    category: source === 'identity' ? 'identity' : source === 'audit' ? 'evidence' : 'platform',
    title,
    detail: message || 'The readiness source could not be loaded.',
    state: 'unknown',
    required,
    href,
  };
}

function findPack(packs: SolutionPacksResponse, term: RegExp) {
  return packs.packs.find(pack => term.test(`${pack.configuredId} ${pack.manifest?.metadata.id ?? ''} ${pack.manifest?.metadata.displayName ?? ''}`));
}

export function buildPlatformReadinessSnapshot(sources: PlatformReadinessSources): PlatformReadinessSnapshot {
  const checks: PlatformReadinessCheck[] = [];
  const errors = sources.errors ?? {};

  if (!sources.backends) {
    checks.push(unavailable('backends', 'Core platform & persistence', '/observe/health', true, errors.backends));
    checks.push({ ...unavailable('backends', 'Repository & CI delivery', '/mcp-fabric?view=backends', true, errors.backends), id: 'delivery-backends', category: 'delivery' });
  } else {
    const postgres = sources.backends.results.find(item => item.name.toLowerCase() === 'postgres');
    const self = sources.backends.results.find(item => item.name.toLowerCase() === 'argus-self');
    const coreReady = healthy(postgres) && healthy(self);
    checks.push({
      id: 'core', category: 'platform', title: 'Core platform & persistence', required: true,
      state: coreReady ? 'pass' : 'fail', href: '/observe/health',
      detail: coreReady
        ? `Argus and PostgreSQL respond successfully (${Math.max(postgres?.latency_ms ?? 0, self?.latency_ms ?? 0)} ms max).`
        : 'Argus Core or PostgreSQL is not ready. Governed runs must remain blocked.',
    });

    const sourceControl = sources.backends.results.filter(item => /(gitea|github|gitlab|bitbucket)/i.test(item.name));
    const ci = sources.backends.results.filter(item => /(jenkins|buildkite|circle|github.?actions|gitlab.?ci|\bci\b)/i.test(item.name));
    const scmReady = sourceControl.some(healthy);
    const ciReady = ci.some(healthy);
    checks.push({
      id: 'delivery-backends', category: 'delivery', title: 'Repository & CI delivery', required: true,
      state: scmReady && ciReady ? 'pass' : 'fail', href: '/mcp-fabric?view=backends',
      detail: scmReady && ciReady
        ? `${sourceControl.find(healthy)?.name ?? 'SCM'} and ${ci.find(healthy)?.name ?? 'CI'} are reachable for the Ticket-to-PR path.`
        : `${scmReady ? 'Repository ready' : 'No healthy repository backend'} · ${ciReady ? 'CI ready' : 'no healthy CI backend'}.`,
    });
  }

  if (!sources.packs) {
    checks.push(unavailable('packs', 'Argus Dev solution pack', '/solutions/argus.dev', true, errors.packs));
  } else {
    const dev = findPack(sources.packs, /argus[ ._-]*dev/i);
    checks.push({
      id: 'argus-dev', category: 'delivery', title: 'Argus Dev solution pack', required: true,
      state: dev?.state === 'ready' ? 'pass' : 'fail', href: '/solutions/argus.dev',
      detail: dev?.state === 'ready'
        ? `Pack ${dev.manifest?.metadata.version ?? 'version unknown'} is healthy and ready.`
        : dev ? `The configured pack is ${dev.state}.` : 'No Argus Dev pack is installed.',
    });
  }

  if (!sources.aiops) {
    checks.push(unavailable('aiops', 'AIOps evidence lanes', '/solutions/argus.aiops', true, errors.aiops));
  } else {
    const aiopsPass = sources.aiops.state === 'ready';
    const aiopsWarning = sources.aiops.state === 'degraded';
    checks.push({
      id: 'aiops', category: 'observability', title: 'AIOps evidence lanes', required: true,
      state: aiopsPass ? 'pass' : aiopsWarning ? 'warning' : 'fail', href: '/solutions/argus.aiops',
      detail: aiopsPass
        ? `${sources.aiops.availableLanes.length} governed evidence lanes and ${sources.aiops.profiles.ready} ready service profiles.`
        : sources.aiops.issues[0]?.message || `AIOps is ${sources.aiops.state}.`,
    });
  }

  if (!sources.identity) {
    checks.push(unavailable('identity', 'SSO & MFA assurance', '/settings/identity', true, errors.identity));
  } else {
    const linked = sources.identity.provider.enabled && sources.identity.session.ssoLinked;
    checks.push({
      id: 'identity', category: 'identity', title: 'SSO & MFA assurance', required: true,
      state: !linked ? 'fail' : sources.identity.session.mfaFresh ? 'pass' : 'warning', href: '/settings/identity',
      detail: !linked
        ? 'The current Argus user is not linked to the configured SSO provider.'
        : sources.identity.session.mfaFresh
          ? `${sources.identity.provider.name} SSO is linked and the MFA assertion is fresh.`
          : `${sources.identity.provider.name} SSO is linked; perform MFA step-up before protected exports.`,
    });
  }

  if (!sources.audit) {
    checks.push(unavailable('audit', 'Signed audit & evidence reports', '/observe/audit?tab=reports', true, errors.audit));
  } else {
    const ready = sources.audit.readiness.ready && sources.audit.readiness.signingConfigured;
    const details = [
      `${sources.audit.readiness.canonicalEventCount} canonical events`,
      `${sources.audit.readiness.checkpointCount} checkpoints`,
      sources.audit.externalAnchoring.enabled ? `${sources.audit.externalAnchoring.provider} anchor enabled` : 'external anchor not configured',
    ];
    checks.push({
      id: 'evidence', category: 'evidence', title: 'Signed audit & evidence reports', required: true,
      // Fresh MFA is evaluated once by the identity control above. Reusing it
      // here would count the same operator action twice and understate the
      // readiness of an otherwise healthy signing and anchoring pipeline.
      state: ready ? 'pass' : 'fail', href: '/observe/audit?tab=reports',
      detail: ready ? details.join(' · ') : 'The signing pipeline or canonical evidence baseline is not ready.',
    });
  }

  if (!sources.executionProofs) {
    checks.push({
      ...unavailable('executionProofs', 'Executed Dev & AIOps Golden Paths', '/settings/readiness', true, errors.executionProofs),
      id: 'execution-proof',
      category: 'delivery',
    });
  } else {
    const proof = sources.executionProofs.certificates[0];
    const generated = proof ? new Date(proof.generatedAt).getTime() : Number.NaN;
    const now = new Date(sources.generatedAt).getTime();
    const maxAgeMs = Math.max(1, sources.executionProofs.freshnessDays) * 86_400_000;
    const fresh = Number.isFinite(generated) && Number.isFinite(now) && now >= generated - 60_000 && now - generated <= maxAgeMs;
    checks.push({
      id: 'execution-proof', category: 'delivery', title: 'Executed Dev & AIOps Golden Paths', required: true,
      state: !proof ? 'fail' : fresh ? 'pass' : 'warning', href: '/settings/readiness#execution-proofs',
      detail: !proof
        ? 'No immutable combined execution proof has been imported for this workspace.'
        : fresh
          ? `Dev and AIOps passed in one digest-bound proof (${proof.payloadSha256.slice(0, 12)}…).`
          : `The latest passing execution proof is older than ${sources.executionProofs.freshnessDays} days; rerun verify-only before the demo.`,
    });
  }

  const passed = checks.filter(item => item.state === 'pass').length;
  const warnings = checks.filter(item => item.state === 'warning').length;
  const failed = checks.filter(item => item.state === 'fail').length;
  const unknown = checks.filter(item => item.state === 'unknown').length;
  const weighted = passed + warnings * 0.5;
  const score = Math.round((weighted / Math.max(1, checks.length)) * 100);
  const state: PlatformReadinessState = checks.some(item => item.required && (item.state === 'fail' || item.state === 'unknown'))
    ? 'blocked'
    : warnings || unknown ? 'attention' : 'ready';

  return {
    schemaVersion: 1,
    kind: 'argus-platform-readiness-snapshot',
    profile: { id: 'pilot-demo', label: 'Pilot & live demo' },
    generatedAt: sources.generatedAt,
    state,
    score,
    summary: { passed, warnings, failed, unknown, total: checks.length },
    checks,
    backends: (sources.backends?.results ?? []).map(item => ({
      name: item.name,
      kind: item.kind,
      status: item.status,
      latencyMs: item.latency_ms,
      ...(item.error ? { error: item.error } : {}),
    })),
    unavailableSources: (Object.entries(errors) as Array<[PlatformReadinessSource, string | undefined]>)
      .filter((entry): entry is [PlatformReadinessSource, string] => Boolean(entry[1]))
      .map(([source, error]) => ({ source, error })),
    limitations: [
      'This is a point-in-time operational readiness snapshot, not signed audit evidence or a compliance certification.',
      'Configuration checks do not execute work; the separate Golden Path proof verifies previously executed Dev and AIOps runs.',
      'Golden Path proofs are tenant-bound operational evidence, not an external legal or compliance certification.',
    ],
  };
}

export function readinessSnapshotMarkdown(snapshot: PlatformReadinessSnapshot): string {
  const lines = [
    '# Argus platform readiness',
    '',
    `- Profile: ${snapshot.profile.label}`,
    `- Generated: ${snapshot.generatedAt}`,
    `- State: ${snapshot.state}`,
    `- Score: ${snapshot.score}%`,
    '',
    '| Check | State | Required | Detail |',
    '| --- | --- | --- | --- |',
    ...snapshot.checks.map(item => `| ${item.title} | ${item.state} | ${item.required ? 'yes' : 'no'} | ${item.detail.replaceAll('|', '\\|')} |`),
    '',
    '## Limitations',
    '',
    ...snapshot.limitations.map(item => `- ${item}`),
    '',
  ];
  return lines.join('\n');
}

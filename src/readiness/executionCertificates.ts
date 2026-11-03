import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PlatformExecutionCertificateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'PLATFORM_EXECUTION_PROOF_INVALID',
  ) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;

export interface PlatformExecutionProofSummary {
  sourceSchema: 'argus.solution-showcase-golden-runs.v1';
  sourceMode: 'execute' | 'verify-only';
  generatedAt: string;
  payloadSha256: string;
  identity: {
    displayName: string | null;
    username: string | null;
    authMethod: string | null;
    mfaMethod: string | null;
  };
  dev: {
    taskId: string;
    rootTraceId: string;
    workflowId: string | null;
    verificationMode: 'tests-and-review' | 'review-only-image';
    testExecution: 'passed' | 'intentionally_skipped';
    ticketId: string | null;
    repository: string | null;
    branchName: string | null;
    commitSha: string | null;
    pullRequestUrl: string | null;
    changedFiles: string[];
    ci: {
      provider: string | null;
      status: string | null;
      runUrl: string | null;
      imageTag: string | null;
      imageId: string | null;
    };
  };
  aiops: {
    taskId: string;
    rootTraceId: string;
    state: string | null;
    profile: {
      displayName: string | null;
      service: string | null;
      environment: string | null;
      revision: number | null;
      sha256: string | null;
    };
    quality: string | null;
    evidenceLanes: Array<{ lane: string; status: string }>;
    providerToolNames: string[];
  };
}

export interface PlatformExecutionCertificate extends PlatformExecutionProofSummary {
  id: string;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  profileId: 'pilot-demo';
  recordedAt: string;
  recordedBy: string;
  passed: true;
  devPassed: true;
  aiopsPassed: true;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformExecutionCertificateError(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string, max = 2_048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new PlatformExecutionCertificateError(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, max = 2_048): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new PlatformExecutionCertificateError('Execution proof contains an invalid string');
  }
  return value;
}

function optionalHttpUrl(value: unknown): string | null {
  const parsed = optionalString(value, 2_048);
  if (!parsed) return null;
  let url: URL;
  try { url = new URL(parsed); } catch { throw new PlatformExecutionCertificateError('Execution proof contains an invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PlatformExecutionCertificateError('Execution proof URLs must use HTTP or HTTPS');
  }
  return parsed;
}

function uuid(value: unknown, label: string): string {
  const parsed = requiredString(value, label, 64);
  if (!UUID.test(parsed)) throw new PlatformExecutionCertificateError(`${label} must be a UUID`);
  return parsed;
}

function passedChecks(value: unknown, label: string): void {
  const checks = record(value, label);
  if (Object.keys(checks).length === 0 || Object.values(checks).some(check => check !== true)) {
    throw new PlatformExecutionCertificateError(`${label} must contain only passing checks`);
  }
}

function proofPayload(report: JsonRecord): JsonRecord {
  const payload: JsonRecord = {};
  for (const [key, value] of Object.entries(report)) {
    if (key !== 'payloadSha256' && key !== 'passed') payload[key] = value;
  }
  return payload;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    const object = current as JsonRecord;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
}

function digestPayload(report: JsonRecord): { canonical: string; legacy: string } {
  const payload = proofPayload(report);
  return {
    canonical: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    legacy: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

function strings(value: unknown, label: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string')) {
    throw new PlatformExecutionCertificateError(`${label} must be a bounded string array`);
  }
  return value as string[];
}

export function validatePlatformExecutionProof(input: unknown): {
  report: JsonRecord;
  summary: PlatformExecutionProofSummary;
} {
  const body = record(input, 'Request body');
  const report = record(body['report'], 'report');
  if (report['schema'] !== 'argus.solution-showcase-golden-runs.v1') {
    throw new PlatformExecutionCertificateError('Unsupported execution proof schema');
  }
  if (report['mode'] !== 'execute' && report['mode'] !== 'verify-only') {
    throw new PlatformExecutionCertificateError('Execution proof mode is invalid');
  }
  if (report['passed'] !== true) throw new PlatformExecutionCertificateError('Only passing execution proofs can be imported');
  const generatedAt = requiredString(report['generatedAt'], 'generatedAt', 64);
  if (!Number.isFinite(new Date(generatedAt).getTime())) {
    throw new PlatformExecutionCertificateError('generatedAt must be a valid timestamp');
  }
  const payloadSha256 = requiredString(report['payloadSha256'], 'payloadSha256', 64);
  const digests = digestPayload(report);
  if (!SHA256.test(payloadSha256) || (digests.canonical !== payloadSha256 && digests.legacy !== payloadSha256)) {
    throw new PlatformExecutionCertificateError('Execution proof digest verification failed', 409, 'PLATFORM_EXECUTION_PROOF_DIGEST_MISMATCH');
  }

  passedChecks(report['checks'], 'checks');
  const runs = record(report['runs'], 'runs');
  const dev = record(runs['dev'], 'runs.dev');
  const aiops = record(runs['aiops'], 'runs.aiops');
  if (dev['passed'] !== true || aiops['passed'] !== true) {
    throw new PlatformExecutionCertificateError('Both Dev and AIOps runs must pass');
  }
  passedChecks(dev['checks'], 'runs.dev.checks');
  passedChecks(aiops['checks'], 'runs.aiops.checks');

  const identity = record(report['identity'], 'identity');
  const ci = record(dev['ci'], 'runs.dev.ci');
  const profile = record(aiops['profile'], 'runs.aiops.profile');
  const rawLanes = aiops['evidenceLanes'];
  if (!Array.isArray(rawLanes) || rawLanes.length === 0 || rawLanes.length > 32) {
    throw new PlatformExecutionCertificateError('runs.aiops.evidenceLanes is invalid');
  }
  const evidenceLanes = rawLanes.map((value, index) => {
    const lane = record(value, `runs.aiops.evidenceLanes[${index}]`);
    return {
      lane: requiredString(lane['lane'], `evidence lane ${index}`, 128),
      status: requiredString(lane['status'], `evidence lane status ${index}`, 128),
    };
  });
  const verificationMode = requiredString(dev['verificationMode'], 'runs.dev.verificationMode', 64);
  const testExecution = requiredString(dev['testExecution'], 'runs.dev.testExecution', 64);
  if (!['tests-and-review', 'review-only-image'].includes(verificationMode)) {
    throw new PlatformExecutionCertificateError('runs.dev.verificationMode is invalid');
  }
  if (!['passed', 'intentionally_skipped'].includes(testExecution)) {
    throw new PlatformExecutionCertificateError('runs.dev.testExecution is invalid');
  }
  if ((verificationMode === 'tests-and-review') !== (testExecution === 'passed')) {
    throw new PlatformExecutionCertificateError('Dev verification mode and test execution evidence are inconsistent');
  }

  return {
    report,
    summary: {
      sourceSchema: 'argus.solution-showcase-golden-runs.v1',
      sourceMode: report['mode'],
      generatedAt: new Date(generatedAt).toISOString(),
      payloadSha256,
      identity: {
        displayName: optionalString(identity['displayName'], 240),
        username: optionalString(identity['username'], 512),
        authMethod: optionalString(identity['authMethod'], 64),
        mfaMethod: optionalString(identity['mfaMethod'], 128),
      },
      dev: {
        taskId: uuid(dev['taskId'], 'runs.dev.taskId'),
        rootTraceId: uuid(dev['rootTraceId'], 'runs.dev.rootTraceId'),
        workflowId: optionalString(dev['workflowId'], 240),
        verificationMode: verificationMode as 'tests-and-review' | 'review-only-image',
        testExecution: testExecution as 'passed' | 'intentionally_skipped',
        ticketId: optionalString(dev['ticketId'], 240),
        repository: optionalString(dev['repository'], 512),
        branchName: optionalString(dev['branchName'], 512),
        commitSha: optionalString(dev['commitSha'], 128),
        pullRequestUrl: optionalHttpUrl(dev['pullRequestUrl']),
        changedFiles: strings(dev['changedFiles'], 'runs.dev.changedFiles'),
        ci: {
          provider: optionalString(ci['provider'], 128),
          status: optionalString(ci['status'], 128),
          runUrl: optionalHttpUrl(ci['run_url'] ?? ci['runUrl']),
          imageTag: optionalString(ci['imageTag'], 512),
          imageId: optionalString(ci['imageId'], 512),
        },
      },
      aiops: {
        taskId: uuid(aiops['taskId'], 'runs.aiops.taskId'),
        rootTraceId: uuid(aiops['rootTraceId'], 'runs.aiops.rootTraceId'),
        state: optionalString(aiops['state'], 128),
        profile: {
          displayName: optionalString(profile['displayName'], 240),
          service: optionalString(profile['service'], 240),
          environment: optionalString(profile['environment'], 240),
          revision: Number.isSafeInteger(profile['revision']) ? profile['revision'] as number : null,
          sha256: optionalString(profile['sha256'], 64),
        },
        quality: optionalString(aiops['quality'], 128),
        evidenceLanes,
        providerToolNames: strings(aiops['providerToolNames'], 'runs.aiops.providerToolNames'),
      },
    },
  };
}

export function projectPlatformExecutionCertificate(row: {
  id: string;
  workspace_key: string;
  tenant_key: string;
  environment: string;
  profile_id: string;
  generated_at: string | Date;
  recorded_at: string | Date;
  recorded_by_username: string;
  passed: boolean;
  dev_passed: boolean;
  aiops_passed: boolean;
  evidence: unknown;
}): PlatformExecutionCertificate {
  const validated = validatePlatformExecutionProof({ report: row.evidence });
  if (new Date(row.generated_at).toISOString() !== validated.summary.generatedAt) {
    throw new PlatformExecutionCertificateError('Stored execution proof timestamp does not match its evidence', 500, 'PLATFORM_EXECUTION_PROOF_STORAGE_MISMATCH');
  }
  return {
    id: row.id,
    workspaceKey: row.workspace_key,
    tenantKey: row.tenant_key,
    environment: row.environment,
    profileId: 'pilot-demo',
    recordedAt: new Date(row.recorded_at).toISOString(),
    recordedBy: row.recorded_by_username,
    passed: true,
    devPassed: true,
    aiopsPassed: true,
    ...validated.summary,
  };
}

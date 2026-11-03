import type { GitCreds, WorkflowState } from './state.js';
import type { JenkinsConfig, JenkinsIntent } from './jenkinsDispatch.js';
import { isImageReviewDelivery } from './reviewOnlyDelivery.js';

export interface DevCiReference {
  version: 1; bundleId: number; backendId: number; job: string; apiOrigin: string;
  repository: string; branchPrefix: string; authMode: 'service-account';
  credentialSource: 'argus-dev-dispatcher'; binding: string;
}
type State = Pick<typeof WorkflowState.State, 'argus_execution_grant' | 'human_approved' | 'tests_passed' | 'review_passed' | 'jenkins_binding'>
  & { delivery_mode?: string };
export class DevCiAuthorizationError extends Error {}

export async function authorizeJenkinsBundle(state: State, trace: string, creds: GitCreds,
  config: JenkinsConfig, job: string, intent?: JenkinsIntent, fetcher: typeof fetch = fetch): Promise<DevCiReference> {
  const secret = process.env['WORKSPACE_SECRET'];
  if (!secret || !trace || !state.argus_execution_grant || !creds?.reference || creds.token !== null) {
    throw new DevCiAuthorizationError('Bundle-bound Jenkins requires a governed repository reference and active run grant.');
  }
  if (intent && (!state.jenkins_binding || !state.human_approved || (!state.tests_passed && !isImageReviewDelivery(state.delivery_mode)) || !state.review_passed)) {
    throw new DevCiAuthorizationError('Jenkins requires the frozen Bundle binding and human code approval. Configure a new attempt for legacy runs.');
  }
  const response = await fetcher(`${process.env['ARGUS_URL'] ?? 'http://mcp-server:3000'}/api/internal/dev-git/ci-authorization`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.argus_execution_grant}`,
      'x-argus-root-trace-id': trace, 'x-workspace-secret': secret },
    body: JSON.stringify({ reference: creds.reference, job, apiOrigin: config.apiOrigin, phase: intent ? 'dispatch' : 'prepare',
      ...(isImageReviewDelivery(state.delivery_mode) ? { verificationMode: 'review-only-image' } : {}),
      ...(intent ? { ciReference: state.jenkins_binding, branch: intent.branch, commitSha: intent.commit, baseSha: intent.base,
        codeApproved: true, reviewPassed: true,
        ...(!isImageReviewDelivery(state.delivery_mode) ? { testsPassed: true } : {}) } : {}) }),
  }).catch(() => { throw new DevCiAuthorizationError('Core CI authorization unavailable. No Jenkins call was made.'); });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof body?.code === 'string' && /^[a-z_]{1,80}$/.test(body.code) ? body.code : 'ci_authorization_unavailable';
    throw new DevCiAuthorizationError(`Jenkins Bundle authorization stopped (${code}, HTTP ${response.status}). Check the selected repository Bundle and exact CI job.`);
  }
  const body = await response.json().catch(() => { throw new DevCiAuthorizationError('Invalid Core CI authorization response.'); }) as { ciReference?: DevCiReference };
  const ref = body.ciReference;
  const repository = `${creds.project_key || creds.user_slug}/${creds.repo_slug}`;
  if (!ref || ref.version !== 1 || ref.bundleId !== creds.reference.bundleId || !Number.isSafeInteger(ref.backendId)
    || ref.backendId < 1 || ref.job !== job || ref.apiOrigin !== config.apiOrigin || ref.repository !== repository
    || ref.authMode !== 'service-account' || ref.credentialSource !== 'argus-dev-dispatcher'
    || !/^feature\/[A-Za-z0-9-]+-$/.test(ref.branchPrefix) || !/^[a-f0-9]{64}$/.test(ref.binding)
    || (intent && (Object.keys(ref) as Array<keyof DevCiReference>).some(key => ref[key] !== state.jenkins_binding?.[key]))) {
    throw new DevCiAuthorizationError('Invalid or changed Core CI binding. No Jenkins call was made.');
  }
  return ref;
}

import { createHash } from 'node:crypto';
import type { CiRun, GitCreds } from './state.js';
import { isImageReviewDelivery } from './reviewOnlyDelivery.js';

export interface JenkinsTarget { repository: string; gitOrigin: string; branchPrefix: string; job: string }
export interface JenkinsConfig { apiOrigin: string; publicOrigin: string; username: string; token: string; targets: JenkinsTarget[] }
export interface JenkinsIntent {
  key: string; repository: string; branch: string; commit: string; base: string; job: string;
}
export interface DispatchReceipt { state: 'intent' | 'accepted' | 'uncertain'; key: string; job: string; commit: string; queueId?: number; at: string }
type Json = Record<string, any>;

function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid Jenkins dispatch origin');
  return url.origin;
}

export function readJenkinsConfig(env = process.env): JenkinsConfig | null {
  const targets: JenkinsTarget[] = JSON.parse(env['ARGUS_JENKINS_DISPATCH_TARGETS'] || '[]');
  if (!Array.isArray(targets) || targets.length > 20) throw new Error('Invalid Jenkins dispatch targets');
  if (!targets.length) return null;
  const seen = new Set<string>();
  for (const target of targets) {
    if (!target || !/^[\w.-]+\/[\w.-]+$/.test(target.repository) || !/^[\w-]+$/.test(target.job)
      || !/^feature\/[A-Za-z0-9-]+-$/.test(target.branchPrefix)) throw new Error('Invalid Jenkins repository/job binding');
    target.gitOrigin = origin(target.gitOrigin);
    const key = `${target.gitOrigin}/${target.repository}/${target.job}`;
    if (seen.has(key)) throw new Error('Ambiguous Jenkins repository binding');
    seen.add(key);
  }
  const username = env['ARGUS_JENKINS_DISPATCH_USER'] || '';
  const token = env['ARGUS_JENKINS_DISPATCH_TOKEN'] || '';
  if (!username || !token || /[:\r\n]/.test(username) || /[\r\n]/.test(token)) throw new Error('Jenkins dispatch credential is missing or malformed');
  return { targets, username, token, apiOrigin: origin(env['ARGUS_JENKINS_API_ORIGIN'] || ''), publicOrigin: origin(env['ARGUS_JENKINS_PUBLIC_ORIGIN'] || '') };
}

export function jenkinsTarget(config: JenkinsConfig | null, creds: GitCreds | null | undefined, job = ''): JenkinsTarget | undefined {
  if (!config || !creds || creds.kind !== 'gitea') return;
  const candidates = config.targets.filter(target => target.repository === `${creds.project_key || creds.user_slug}/${creds.repo_slug}`
    && target.gitOrigin === creds.base_url.replace(/\/+$/, '') && (!job || target.job === job));
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function makeJenkinsIntent(config: JenkinsConfig, values: Json, base: string): JenkinsIntent | null {
  if (isImageReviewDelivery(values.delivery_mode) && (typeof values.ci_job !== 'string' || !values.ci_job)) return null;
  const target = jenkinsTarget(config, values.bitbucket_creds, values.ci_job || values.ci_run?.workflow || '');
  const ci = values.ci_run as CiRun | undefined;
  if (!target || values.ci_provider !== 'jenkins' || ci?.provider !== 'jenkins'
    || values.human_approved !== true || values.branch_pushed !== true
    || (values.tests_passed !== true && !isImageReviewDelivery(values.delivery_mode)) || values.review_passed !== true
    || values.pr_approved === true || values.pr_url || !['queued', 'unknown', 'running'].includes(ci.status)) return null;
  const branch = values.branch_name;
  const commit = values.commit_sha;
  if (typeof branch !== 'string' || !branch.startsWith(target.branchPrefix) || !/^feature\/[A-Za-z0-9-]+$/.test(branch)
    || !/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(base) || base === commit
    || ci.branch !== branch || ci.commit_sha !== commit) return null;
  const key = createHash('sha256').update(JSON.stringify([target.gitOrigin, target.repository, branch, commit, base, target.job])).digest('hex');
  return { key, repository: target.repository, branch, commit, base, job: target.job };
}

function parameters(intent: JenkinsIntent): Record<string, string> {
  return { REPOSITORY: intent.repository, BRANCH_NAME: intent.branch, COMMIT_SHA: intent.commit, BASE_SHA: intent.base };
}

/** A shared callback credential cannot substitute a different job/source. */
export function jenkinsCallbackMatches(config: JenkinsConfig | null, values: Json, incoming: CiRun): boolean {
  const target = jenkinsTarget(config, values.bitbucket_creds, values.ci_job || values.ci_run?.workflow || '');
  if (values.ci_provider !== 'jenkins') return true;
  if (!target) return !values.ci_job && !config;
  const expectedId = values.ci_run?.external_id;
  return incoming.provider === 'jenkins' && incoming.workflow === target.job
    && incoming.commit_sha === values.commit_sha && incoming.branch === values.branch_name
    && /^[1-9]\d*$/.test(incoming.external_id)
    && (!expectedId || incoming.external_id === expectedId);
}

function matches(item: Json, intent: JenkinsIntent): boolean {
  const actual = Object.fromEntries((item.actions ?? []).flatMap((action: Json) => action.parameters ?? []).map((p: Json) => [p.name, p.value]));
  return Object.entries(parameters(intent)).every(([key, value]) => actual[key] === value);
}

function evidence(config: JenkinsConfig, intent: JenkinsIntent, status: CiRun['status'], id = '', conclusion = ''): CiRun {
  return { provider: 'jenkins', external_id: id, workflow: intent.job, status, conclusion, branch: intent.branch,
    commit_sha: intent.commit, run_url: `${config.publicOrigin}/job/${intent.job}/${id ? `${id}/` : ''}`, updated_at: new Date().toISOString() };
}

/** No response bodies or credentials escape this adapter. Redirects never carry auth. */
export async function dispatchJenkins(
  config: JenkinsConfig, intent: JenkinsIntent,
  store: { claim(receipt: DispatchReceipt): Promise<boolean>; save(receipt: DispatchReceipt): Promise<void> },
  fetcher: typeof fetch = fetch,
  authorize: () => Promise<void> = async () => { throw new Error('Jenkins Bundle authorization is required.'); },
): Promise<CiRun> {
  const headers = { authorization: `Basic ${Buffer.from(`${config.username}:${config.token}`).toString('base64')}`, accept: 'application/json' };
  async function read(path: string): Promise<Json> {
    await authorize();
    const response = await fetcher(`${config.apiOrigin}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Jenkins lookup HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 2_000_000) throw new Error('Jenkins response exceeded limit');
    return JSON.parse(text);
  }
  // A previous process may have received no POST response. Reconcile by the
  // immutable source tuple; never blindly POST again after a durable intent.
  const job = await read(`/job/${intent.job}/api/json?tree=buildable,builds[number,building,result,actions[parameters[name,value]]]{0,100}`);
  const build = (job.builds ?? []).find((item: Json) => matches(item, intent));
  if (build) {
    if (!Number.isSafeInteger(build.number) || build.number < 1) throw new Error('Invalid Jenkins build identity');
    await store.claim({ state: 'accepted', key: intent.key, job: intent.job, commit: intent.commit, at: new Date().toISOString() });
    // An authenticated provider read may fail closed when the callback never
    // ran (for example, Jenkinsfile setup failed before its finally block).
    // SUCCESS still requires the signed callback before Argus can advance.
    const failed = build.building === false && ['FAILURE', 'UNSTABLE', 'NOT_BUILT'].includes(build.result);
    const canceled = build.building === false && build.result === 'ABORTED';
    return evidence(config, intent, failed ? 'failure' : canceled ? 'canceled' : build.building ? 'running' : 'unknown',
      String(build.number), failed || canceled ? `provider_api_reconciled: ${build.result}` : build.building ? '' : 'awaiting_provider_callback');
  }
  const queue = await read('/queue/api/json?tree=items[id,task[name],actions[parameters[name,value]]]');
  const queued = (queue.items ?? []).find((item: Json) => item.task?.name === intent.job && matches(item, intent));
  if (queued) {
    await store.claim({ state: 'accepted', key: intent.key, job: intent.job, commit: intent.commit, queueId: queued.id, at: new Date().toISOString() });
    return evidence(config, intent, 'queued');
  }
  if (job.buildable !== true) throw new Error('Jenkins job is not buildable');
  // Revalidate Bundle scope after reads and before reserving a write intent.
  // Authorization failure is not an uncertain provider write and must not
  // consume the durable intent or trigger a credential fallback.
  await authorize();
  const receipt: DispatchReceipt = { state: 'intent', key: intent.key, job: intent.job, commit: intent.commit, at: new Date().toISOString() };
  if (!await store.claim(receipt)) return evidence(config, intent, 'unknown', '', 'dispatch_uncertain_operator_review');
  try {
    const response = await fetcher(`${config.apiOrigin}/job/${intent.job}/buildWithParameters`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters(intent)), redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    const location = new URL(response.headers.get('location') || '/', config.apiOrigin);
    const queueId = /^\/queue\/item\/([1-9]\d*)\/?$/.exec(location.pathname)?.[1];
    if (response.status !== 201 || !queueId || ![config.apiOrigin, config.publicOrigin].includes(location.origin)) throw new Error('Jenkins dispatch not confirmed');
    await store.save({ ...receipt, state: 'accepted', queueId: Number(queueId) });
    return evidence(config, intent, 'queued');
  } catch {
    await store.save({ ...receipt, state: 'uncertain' });
    return evidence(config, intent, 'unknown', '', 'dispatch_uncertain_operator_review');
  }
}

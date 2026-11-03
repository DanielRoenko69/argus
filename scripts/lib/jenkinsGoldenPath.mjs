import { spawnSync } from 'node:child_process';

const LOCAL_DEMO_SERVICE_TOKEN = '11a64f0e733bfa5da9d8bb312839476a1d';

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function responseJson(response, label) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const detail = typeof body?.error === 'string' ? body.error
      : typeof body?.message === 'string' ? body.message
        : typeof body === 'string' ? body.slice(0, 300) : `HTTP ${response.status}`;
    throw new Error(`${label} failed (${response.status}): ${detail}`);
  }
  return body;
}

function headers(configuration) {
  const token = String(configuration.ARGUS_JENKINS_SERVICE_TOKEN ?? LOCAL_DEMO_SERVICE_TOKEN).trim();
  return {
    authorization: `Basic ${Buffer.from(`argus-service:${token}`, 'utf8').toString('base64')}`,
    accept: 'application/json',
  };
}

export async function latestJenkinsGoldenPathSource(configuration) {
  const port = String(configuration.ARGUS_JENKINS_PORT ?? '8081').trim();
  const origin = `http://127.0.0.1:${port}`;
  const build = await responseJson(await fetch(
    `${origin}/job/argus-dev-docker-golden-path/lastSuccessfulBuild/api/json?tree=actions[parameters[name,value]]`,
    { headers: headers(configuration), signal: AbortSignal.timeout(15_000) },
  ), 'latest successful Jenkins golden-path build');
  const parameters = (Array.isArray(build?.actions) ? build.actions : [])
    .flatMap(action => Array.isArray(action?.parameters) ? action.parameters : []);
  const values = Object.fromEntries(parameters
    .filter(parameter => typeof parameter?.name === 'string')
    .map(parameter => [parameter.name, parameter.value]));
  const branchName = String(values.BRANCH_NAME ?? '');
  const commitSha = String(values.COMMIT_SHA ?? '');
  if (!branchName || !commitSha) throw new Error('The latest successful Jenkins build has no immutable source parameters');
  return { branchName, commitSha };
}

export async function inspectLocalDockerImage(imageTag, timeoutMs = 30_000) {
  if (typeof imageTag !== 'string' || !imageTag.trim() || imageTag.length > 512) {
    throw new Error('Invalid Docker image tag');
  }
  const imageDeadline = Date.now() + timeoutMs;
  let imageId = '';
  do {
    const inspected = spawnSync('docker', ['image', 'inspect', imageTag.trim(), '--format', '{{.Id}}'], {
      encoding: 'utf8', windowsHide: true,
    });
    imageId = inspected.status === 0 ? String(inspected.stdout).trim() : '';
    if (imageId.startsWith('sha256:')) break;
    await delay(1_000);
  } while (Date.now() < imageDeadline);
  if (!imageId.startsWith('sha256:')) {
    throw new Error(`Docker image evidence is missing for ${imageTag.trim()}`);
  }
  return { imageTag: imageTag.trim(), imageId };
}

export async function inspectLocalJenkinsImage(buildNumber, timeoutMs = 30_000) {
  if (!Number.isInteger(Number(buildNumber)) || Number(buildNumber) < 1) throw new Error('Invalid Jenkins build number');
  return inspectLocalDockerImage(`argus-dev-sample:jenkins-${Number(buildNumber)}`, timeoutMs);
}

export async function triggerJenkinsGoldenPathBuild({
  configuration,
  repository = 'argus/argus-dev-sample',
  branchName,
  commitSha,
  timeoutMs = 8 * 60_000,
}) {
  if (!/^argus\/argus-dev-sample$/u.test(repository)) throw new Error('The Jenkins showcase accepts only argus/argus-dev-sample');
  if (!/^feature\/ARGUS-SHOWCASE-[A-Za-z0-9._-]+$/u.test(String(branchName ?? ''))) throw new Error('Invalid showcase branch');
  if (!/^[0-9a-f]{40}$/u.test(String(commitSha ?? ''))) throw new Error('Invalid immutable commit SHA');

  const port = String(configuration.ARGUS_JENKINS_PORT ?? '8081').trim();
  const origin = `http://127.0.0.1:${port}`;
  const job = 'argus-dev-docker-golden-path';
  const parameters = new URLSearchParams({ REPOSITORY: repository, BRANCH_NAME: branchName, COMMIT_SHA: commitSha });
  const trigger = await fetch(`${origin}/job/${job}/buildWithParameters?${parameters}`, {
    method: 'POST', headers: headers(configuration), signal: AbortSignal.timeout(15_000), redirect: 'manual',
  });
  if (![200, 201, 202, 302].includes(trigger.status)) {
    throw new Error(`Jenkins build trigger failed (${trigger.status}): ${(await trigger.text()).slice(0, 300)}`);
  }
  const queueLocation = trigger.headers.get('location');
  if (!queueLocation) throw new Error('Jenkins did not return a queue item location');

  const queueUrl = new URL(queueLocation, origin);
  const deadline = Date.now() + timeoutMs;
  let buildNumber = null;
  while (Date.now() < deadline && buildNumber == null) {
    const queued = await responseJson(await fetch(`${queueUrl.href.replace(/\/$/u, '')}/api/json`, {
      headers: headers(configuration), signal: AbortSignal.timeout(15_000),
    }), 'Jenkins queue item');
    if (queued?.cancelled === true) throw new Error('Jenkins canceled the queued golden-path build');
    if (Number.isInteger(queued?.executable?.number)) buildNumber = queued.executable.number;
    else await delay(1_500);
  }
  if (buildNumber == null) throw new Error('Jenkins did not start the queued golden-path build');

  const runUrl = `${origin}/job/${job}/${buildNumber}/`;
  let build = null;
  while (Date.now() < deadline) {
    build = await responseJson(await fetch(`${runUrl}api/json`, {
      headers: headers(configuration), signal: AbortSignal.timeout(15_000),
    }), 'Jenkins build');
    if (build?.building === false && build?.result) break;
    await delay(2_000);
  }
  if (String(build?.result ?? '').toUpperCase() !== 'SUCCESS') {
    throw new Error(`Jenkins Docker build completed with ${build?.result ?? 'unknown result'}`);
  }

  const image = await inspectLocalJenkinsImage(buildNumber, Math.max(1_000, Math.min(30_000, deadline - Date.now())));
  return {
    provider: 'jenkins',
    externalId: String(buildNumber),
    runUrl: runUrl.replace('127.0.0.1', 'localhost'),
    ...image,
    result: 'SUCCESS',
  };
}

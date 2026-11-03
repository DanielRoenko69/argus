import { describe, expect, it } from '@jest/globals';
import { normalizeCiStatus, normalizeCiWebhookEvent, toBrowserProviderUrl } from '../ciProviderAdapters.js';

describe('provider-neutral CI adapters', () => {
  it('normalizes provider status vocabularies', () => {
    expect(normalizeCiStatus('in_progress', '')).toBe('running');
    expect(normalizeCiStatus('completed', 'success')).toBe('success');
    expect(normalizeCiStatus('failed', '')).toBe('failure');
    expect(normalizeCiStatus('ABORTED', '')).toBe('canceled');
    expect(normalizeCiStatus('pending', '')).toBe('queued');
  });

  it.each([
    ['gitea', { workflow_run: { id: 1, name: 'checks', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'abc', html_url: 'http://gitea/actions/1' }, repository: { full_name: 'argus/core' } }],
    ['github', { workflow_run: { id: 2, name: 'checks', status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'def', html_url: 'https://github.com/argus/core/actions/runs/2' }, repository: { full_name: 'argus/core' } }],
    ['gitlab', { object_attributes: { id: 3, ref: 'main', sha: 'ghi', status: 'success', web_url: 'https://gitlab/argus/core/-/pipelines/3' }, project: { path_with_namespace: 'argus/core' } }],
    ['jenkins', { build: { number: 4, job_name: 'checks', result: 'SUCCESS', full_url: 'http://jenkins/job/checks/4' }, branch: 'main', scm: { commit: 'jkl' }, repository: { full_name: 'argus/core' } }],
  ])('normalizes %s into the Argus CI evidence shape', (provider, payload) => {
    const event = normalizeCiWebhookEvent(provider as 'gitea' | 'github' | 'gitlab' | 'jenkins', payload);
    expect(event.repository).toBe('argus/core');
    expect(event.branch).toBe('main');
    expect(event.ciRun).toMatchObject({ provider, status: 'success', branch: 'main' });
    expect(event.ciRun.external_id).toBeTruthy();
  });

  it('normalizes repository URLs from GitLab and Jenkins payloads', () => {
    const gitlab = normalizeCiWebhookEvent('gitlab', {
      object_attributes: { id: 5, ref: 'main', status: 'success', web_url: 'https://gitlab.example/argus/core/-/pipelines/5' },
      project: { web_url: 'https://gitlab.example/argus/core' },
    });
    const jenkins = normalizeCiWebhookEvent('jenkins', {
      build: { number: 6, result: 'SUCCESS', full_url: 'https://jenkins.example/job/core/6' },
      branch: 'main',
      repository: { url: 'https://git.example/argus/core.git' },
    });
    expect(gitlab.repository).toBe('argus/core');
    expect(jenkins.repository).toBe('argus/core');
  });

  it('maps internal provider URLs to configured browser URLs', () => {
    const previous = process.env['GITLAB_PUBLIC_URL'];
    process.env['GITLAB_PUBLIC_URL'] = 'https://gitlab.public.example';
    expect(toBrowserProviderUrl('gitlab', 'http://gitlab:8080/argus/core/-/pipelines/5'))
      .toBe('https://gitlab.public.example/argus/core/-/pipelines/5');
    if (previous === undefined) delete process.env['GITLAB_PUBLIC_URL'];
    else process.env['GITLAB_PUBLIC_URL'] = previous;
  });
});

import type { ServiceTemplate } from '../../serviceTemplates.js';
import { devCiPolicySchema } from '../../../workflows/devCiBinding.js';

export const jenkinsDevCiTemplate: ServiceTemplate = {
  id: 'jenkins-dev-ci', name: 'Jenkins · Argus.Dev CI binding', icon: '🎩', category: 'devops',
  description: 'Exact repository/job binding for the trusted Argus.Dev dispatcher. Uses its protected service identity, not personal OAuth. No direct MCP tools; human approvals remain required.',
  fields: [
    { name: 'base_url', label: 'Jenkins API origin', type: 'string', required: true },
    { name: 'git_origin', label: 'Repository Git origin', type: 'string', required: true },
    { name: 'repository', label: 'Repository (owner/name)', type: 'string', required: true },
    { name: 'job', label: 'Exact Jenkins job', type: 'string', required: true },
    { name: 'branch_prefix', label: 'Allowed feature branch prefix', type: 'string', required: true },
    { name: 'verification_mode', label: 'Verification policy', type: 'select', required: false,
      options: ['automated-tests', 'review-only-image'] },
  ],
  tools: [],
  buildBaseUrl: fields => {
    devCiPolicySchema.parse({ kind:'jenkins', dev_ci:{ version:1, credential_source:'argus-dev-dispatcher',
      repository:fields.repository, git_origin:fields.git_origin, job:fields.job, branch_prefix:fields.branch_prefix } });
    const url = new URL(fields.base_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== fields.base_url) throw new Error('Exact Jenkins origin required.');
    return url.origin;
  },
  // This connection is a policy binding, not a credentialless Jenkins transport.
  // Only the trusted Dev dispatcher uses its already configured protected identity.
  buildAuthType: () => 'none',
  buildHealthPath: () => '/login',
  buildConfig: fields => devCiPolicySchema.parse({ kind: 'jenkins', dev_ci: {
    version: 1, credential_source: 'argus-dev-dispatcher', repository: fields.repository,
    git_origin: fields.git_origin, job: fields.job, branch_prefix: fields.branch_prefix,
    ...(fields.verification_mode === 'review-only-image' ? { verification_mode: 'review-only-image' } : {}),
  } }),
};

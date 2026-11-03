import type { ServiceTemplate, ToolParameter } from '../../serviceTemplates.js';

const repoParameters: ToolParameter[] = [
  { name: 'owner', type: 'string', description: 'Gitea owner or organization', required: true },
  { name: 'repo', type: 'string', description: 'Repository name', required: true },
];

export const giteaTemplate: ServiceTemplate = {
  id: 'gitea',
  name: 'Gitea',
  description: 'Self-hosted repositories, branches, commits, pull requests, issues and Actions exposed as governed MCP tools.',
  icon: 'git-branch',
  category: 'devops',
  tags: ['gitea', 'git', 'self-hosted', 'ci', 'actions', 'pull-requests'],
  docsUrl: 'https://docs.gitea.com/api/1.27/',

  fields: [
    {
      name: 'public_base_url', label: 'Browser Base URL', type: 'string', required: false,
      placeholder: 'https://git.example.eu',
    },
    {
      name: 'base_url',
      label: 'Gitea Base URL',
      type: 'string',
      required: true,
      placeholder: 'https://git.example.eu',
    },
    {
      name: 'token',
      label: 'Access Token',
      type: 'password',
      required: true,
    },
    {
      name: 'owner',
      label: 'Default Owner / Organization',
      type: 'string',
      required: true,
      placeholder: 'argus',
    },
    {
      name: 'repo',
      label: 'Default Repository',
      type: 'string',
      required: true,
      placeholder: 'argus-dev-sample',
    },
    {
      name: 'default_branch',
      label: 'Default Target Branch',
      type: 'string',
      required: false,
      default: 'main',
    },
  ],

  tools: [
    {
      nameSuffix: 'get_repo',
      description: 'Get repository metadata from Gitea',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}',
      parameters: repoParameters,
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_branches',
      description: 'List branches of a Gitea repository',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/branches?limit={{limit}}&page={{page}}',
      parameters: [
        ...repoParameters,
        { name: 'limit', type: 'number', description: 'Results per page', required: false, default: '30' },
        { name: 'page', type: 'number', description: 'Page number', required: false, default: '1' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_commits',
      description: 'List commits on a branch of a Gitea repository',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/commits?sha={{sha}}&limit={{limit}}',
      parameters: [
        ...repoParameters,
        { name: 'sha', type: 'string', description: 'Branch, tag or commit SHA', required: false, default: 'main' },
        { name: 'limit', type: 'number', description: 'Maximum commits', required: false, default: '20' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_pulls',
      description: 'List pull requests of a Gitea repository',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/pulls?state={{state}}&limit={{limit}}',
      parameters: [
        ...repoParameters,
        { name: 'state', type: 'string', description: 'open, closed or all', required: false, default: 'open' },
        { name: 'limit', type: 'number', description: 'Maximum pull requests', required: false, default: '20' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_pull',
      description: 'Get one Gitea pull request',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/pulls/{{index}}',
      parameters: [
        ...repoParameters,
        { name: 'index', type: 'number', description: 'Pull request number', required: true },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'create_pull',
      description: 'Create a governed pull request in Gitea',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v1/repos/{{owner}}/{{repo}}/pulls\nContent-Type: application/json\n\n{"title":"{{title}}","body":"{{body}}","head":"{{head}}","base":"{{base}}"}',
      parameters: [
        ...repoParameters,
        { name: 'title', type: 'string', description: 'Pull request title', required: true },
        { name: 'body', type: 'string', description: 'Pull request description', required: false, default: '' },
        { name: 'head', type: 'string', description: 'Source branch', required: true },
        { name: 'base', type: 'string', description: 'Target branch', required: false, default: 'main' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_issue',
      description: 'Read one Gitea issue for a version-bound development workflow',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/issues/{{index}}',
      parameters: [...repoParameters, { name: 'index', type: 'number', description: 'Issue number', required: true }],
      category: 'DevOps',
      readOnly: true,
    },
    {
      nameSuffix: 'list_issues',
      description: 'List issues of a Gitea repository',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/issues?state={{state}}&limit={{limit}}',
      parameters: [
        ...repoParameters,
        { name: 'state', type: 'string', description: 'open, closed or all', required: false, default: 'open' },
        { name: 'limit', type: 'number', description: 'Maximum issues', required: false, default: '20' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'create_issue',
      description: 'Create a governed issue in Gitea',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /api/v1/repos/{{owner}}/{{repo}}/issues\nContent-Type: application/json\n\n{"title":"{{title}}","body":"{{body}}"}',
      parameters: [
        ...repoParameters,
        { name: 'title', type: 'string', description: 'Issue title', required: true },
        { name: 'body', type: 'string', description: 'Issue description', required: false, default: '' },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_action_runs',
      description: 'List Gitea Actions runs for a repository',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/repos/{{owner}}/{{repo}}/actions/runs?limit={{limit}}',
      parameters: [
        ...repoParameters,
        { name: 'limit', type: 'number', description: 'Maximum workflow runs', required: false, default: '20' },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: fields => fields.base_url.replace(/\/+$/, ''),
  buildAuthType: () => 'bearer',
  buildAuthValue: fields => fields.token,
  buildDefaultHeaders: () => ({ Accept: 'application/json' }),
  buildHealthPath: () => '/api/healthz',
  buildConfig: fields => ({
    kind: 'gitea',
    ...(fields.public_base_url ? { public_base_url: fields.public_base_url.replace(/\/+$/, '') } : {}),
    owner: fields.owner,
    repo_slug: fields.repo,
    default_target_branch: fields.default_branch || 'main',
  }),
};

export type McpCatalogCategory =
  | 'SCM'
  | 'CI/CD'
  | 'Monitoring'
  | 'Logs'
  | 'Infrastructure'
  | 'Cloud'
  | 'ITSM'
  | 'Storage'
  | 'Orchestration'
  | 'AI/LLM'
  | 'Automation'
  | 'Communication'
  | 'Testing'
  | 'Finance'
  | 'Security'
  | 'Data';

export interface McpCatalogItem {
  id: string;
  name: string;
  icon: string;
  category: McpCatalogCategory;
  publisher: string;
  publisherKind: 'vendor' | 'community' | 'reference';
  description: string;
  tags: string[];
  suggestedUrl: string;
  repository: string;
  launchHint: string;
  tools: string[];
}

type CatalogDefinition = Omit<McpCatalogItem, 'publisherKind' | 'tools'> & {
  legacyOfficial: boolean;
};

const definitions: CatalogDefinition[] = [
  { id: 'github', name: 'GitHub', icon: '🐙', category: 'SCM', legacyOfficial: true, publisher: 'GitHub', description: 'Repositories, issues, pull requests, Actions and code search.', tags: ['git', 'vcs'], suggestedUrl: 'http://github-mcp:8000', repository: 'github.com/github/github-mcp-server', launchHint: 'docker run -e GITHUB_PERSONAL_ACCESS_TOKEN=<token> ghcr.io/github/github-mcp-server' },
  { id: 'gitlab', name: 'GitLab', icon: '🦊', category: 'SCM', legacyOfficial: true, publisher: 'GitLab', description: 'Projects, merge requests, pipelines, issues and container registry.', tags: ['git', 'ci/cd'], suggestedUrl: 'https://gitlab.com/api/v4/mcp', repository: 'gitlab.com/gitlab-org/editor-extensions/gitlab-mcp-server', launchHint: 'Remote: https://gitlab.com/api/v4/mcp with a GitLab bearer token.' },
  { id: 'bitbucket', name: 'Bitbucket', icon: '🪣', category: 'SCM', legacyOfficial: false, publisher: 'Community · aashari', description: 'Bitbucket Cloud repositories, pull requests and pipelines.', tags: ['git', 'ci/cd'], suggestedUrl: 'http://bitbucket-mcp:3000', repository: 'github.com/aashari/mcp-server-atlassian-bitbucket', launchHint: 'npx -y @aashari/mcp-server-atlassian-bitbucket' },
  { id: 'ref-git', name: 'Git', icon: '🌿', category: 'SCM', legacyOfficial: true, publisher: 'MCP reference', description: 'Local repository status, diffs, history, commits and branches.', tags: ['git', 'local'], suggestedUrl: 'http://git-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/git', launchHint: 'Deploy the reference server with an explicitly mounted repository.' },
  { id: 'jenkins', name: 'Jenkins', icon: '🔧', category: 'CI/CD', legacyOfficial: false, publisher: 'Community', description: 'Trigger build jobs and inspect queues, builds and logs.', tags: ['build', 'ci/cd'], suggestedUrl: 'http://host.docker.internal:9887', repository: 'github.com/abhiz123/mcp-jenkins', launchHint: 'npx -y mcp-jenkins' },
  { id: 'argocd', name: 'Argo CD', icon: '⛵', category: 'CI/CD', legacyOfficial: false, publisher: 'Community · Akuity', description: 'GitOps applications, synchronization, resources and rollback workflows.', tags: ['gitops', 'k8s'], suggestedUrl: 'http://argocd-mcp:3000/mcp', repository: 'github.com/akuity/mcp-server-argocd', launchHint: 'Run the server in stateless HTTP mode and provide an Argo CD API token.' },
  { id: 'circleci', name: 'CircleCI', icon: '🟢', category: 'CI/CD', legacyOfficial: true, publisher: 'CircleCI', description: 'Pipelines, build failures, flaky tests, reruns and rollbacks.', tags: ['cicd', 'pipelines'], suggestedUrl: 'http://circleci-mcp:3000', repository: 'github.com/CircleCI-Public/mcp-server-circleci', launchHint: 'npx -y @circleci/mcp-server-circleci@latest' },
  { id: 'buildkite', name: 'Buildkite', icon: '🪁', category: 'CI/CD', legacyOfficial: true, publisher: 'Buildkite', description: 'Pipelines, builds, jobs, logs, artifacts and test-engine data.', tags: ['cicd', 'pipelines'], suggestedUrl: 'http://buildkite-mcp:3000', repository: 'github.com/buildkite/buildkite-mcp-server', launchHint: 'Provide a Buildkite API token to the server process.' },
  { id: 'grafana', name: 'Grafana', icon: '📊', category: 'Monitoring', legacyOfficial: true, publisher: 'Grafana Labs', description: 'Dashboards, alerting, data sources, incidents, Loki and OnCall.', tags: ['metrics', 'dashboards'], suggestedUrl: 'http://host.docker.internal:3200', repository: 'github.com/grafana/mcp-grafana', launchHint: 'Run mcp-grafana with GRAFANA_URL and a scoped service-account token.' },
  { id: 'prometheus', name: 'Prometheus', icon: '🔥', category: 'Monitoring', legacyOfficial: false, publisher: 'Community', description: 'PromQL queries, metric discovery, alert rules and targets.', tags: ['metrics', 'scraping'], suggestedUrl: 'http://prometheus-mcp:3000', repository: 'github.com/giantswarm/mcp-prometheus', launchHint: 'go run github.com/giantswarm/mcp-prometheus@latest' },
  { id: 'datadog', name: 'Datadog', icon: '🐕', category: 'Monitoring', legacyOfficial: true, publisher: 'Datadog', description: 'Monitors, dashboards, incidents, logs, metrics and on-call data.', tags: ['monitoring', 'apm'], suggestedUrl: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp', repository: 'github.com/DataDog/datadog-mcp-server', launchHint: 'Remote server; configure the required Datadog authentication headers.' },
  { id: 'sentry', name: 'Sentry', icon: '🐛', category: 'Monitoring', legacyOfficial: true, publisher: 'Sentry', description: 'Errors, issues, releases, events and performance monitoring.', tags: ['errors', 'apm'], suggestedUrl: 'http://sentry-mcp:3000', repository: 'github.com/getsentry/sentry-mcp', launchHint: 'npx -y @sentry/mcp-server --auth-token=<token>' },
  { id: 'pagerduty', name: 'PagerDuty', icon: '🚨', category: 'Monitoring', legacyOfficial: true, publisher: 'PagerDuty', description: 'Incidents, on-call schedules, services and escalation policies.', tags: ['alerting', 'oncall'], suggestedUrl: 'http://pagerduty-mcp:3000', repository: 'github.com/PagerDuty/mcp-server-pagerduty', launchHint: 'Run with a scoped PagerDuty user API key.' },
  { id: 'new-relic', name: 'New Relic', icon: '📶', category: 'Monitoring', legacyOfficial: true, publisher: 'New Relic', description: 'NRQL, alerts, incidents, entity performance and impact reports.', tags: ['apm', 'observability'], suggestedUrl: 'http://newrelic-mcp:3000', repository: 'github.com/newrelic/mcp-server', launchHint: 'Review the publisher repository for the current transport command.' },
  { id: 'dynatrace', name: 'Dynatrace', icon: '🔷', category: 'Monitoring', legacyOfficial: true, publisher: 'Dynatrace', description: 'Problems, vulnerabilities, DQL queries and Kubernetes events.', tags: ['apm', 'observability'], suggestedUrl: 'http://dynatrace-mcp:3000', repository: 'github.com/dynatrace-oss/dynatrace-mcp', launchHint: 'npx -y @dynatrace-oss/dynatrace-mcp-server' },
  { id: 'honeycomb', name: 'Honeycomb', icon: '🍯', category: 'Monitoring', legacyOfficial: true, publisher: 'Honeycomb', description: 'Telemetry queries, BubbleUp analysis and distributed traces.', tags: ['tracing', 'observability'], suggestedUrl: 'http://honeycomb-mcp:3000', repository: 'github.com/honeycombio/honeycomb-mcp', launchHint: 'npx -y @honeycombio/honeycomb-mcp' },
  { id: 'opensearch', name: 'OpenSearch', icon: '🔍', category: 'Logs', legacyOfficial: true, publisher: 'OpenSearch Project', description: 'Search, index operations, cluster health and node metrics.', tags: ['logs', 'search'], suggestedUrl: 'http://opensearch-mcp:9200', repository: 'github.com/opensearch-project/opensearch-mcp-server-py', launchHint: 'uvx opensearch-mcp-server' },
  { id: 'elasticsearch', name: 'Elasticsearch', icon: '📈', category: 'Logs', legacyOfficial: false, publisher: 'Community · cr7258', description: 'Elasticsearch and OpenSearch queries, indices and cluster operations.', tags: ['logs', 'search', 'elk'], suggestedUrl: 'http://es-mcp:3000', repository: 'github.com/cr7258/elasticsearch-mcp-server', launchHint: 'uvx elasticsearch-mcp-server' },
  { id: 'splunk', name: 'Splunk', icon: '🟧', category: 'Logs', legacyOfficial: true, publisher: 'Splunk · Cisco', description: 'SPL searches, validation, indices and saved searches.', tags: ['siem', 'logs'], suggestedUrl: 'http://splunk-mcp:8089', repository: 'github.com/CiscoDevNet/Splunk-MCP-Server-official', launchHint: 'Review the publisher repository for the current transport command.' },
  { id: 'kubernetes', name: 'Kubernetes', icon: '🎡', category: 'Infrastructure', legacyOfficial: false, publisher: 'Community', description: 'Pods, deployments, services, logs, events and namespaces.', tags: ['k8s', 'containers'], suggestedUrl: 'http://k8s-mcp:3000', repository: 'github.com/strowk/mcp-k8s-go', launchHint: 'npx -y mcp-server-kubernetes' },
  { id: 'docker', name: 'Docker', icon: '🐳', category: 'Infrastructure', legacyOfficial: true, publisher: 'Docker', description: 'Containers, images, volumes, Compose and MCP gateway operations.', tags: ['containers', 'hub'], suggestedUrl: 'http://docker-mcp:8080/mcp', repository: 'github.com/docker/mcp-servers', launchHint: 'Run docker/mcp-gateway with streaming transport on a dedicated port.' },
  { id: 'terraform', name: 'Terraform', icon: '🏗', category: 'Infrastructure', legacyOfficial: true, publisher: 'HashiCorp', description: 'Registry providers, modules, schemas and plan analysis.', tags: ['iac', 'cloud'], suggestedUrl: 'http://terraform-mcp:8080', repository: 'github.com/hashicorp/terraform-mcp-server', launchHint: 'Run the server in streamable-http mode.' },
  { id: 'consul', name: 'Consul', icon: '🧭', category: 'Infrastructure', legacyOfficial: false, publisher: 'Community · 3loka', description: 'Service discovery, health checks, KV and catalog operations.', tags: ['mesh', 'discovery'], suggestedUrl: 'http://consul-mcp:3000', repository: 'github.com/3loka/consul-mcp-server', launchHint: 'npx -y consul-mcp-server' },
  { id: 'cloudflare', name: 'Cloudflare', icon: '🌐', category: 'Infrastructure', legacyOfficial: true, publisher: 'Cloudflare', description: 'Workers, KV, D1, R2, DNS and Durable Objects.', tags: ['cloud', 'edge'], suggestedUrl: 'http://cloudflare-mcp:3000', repository: 'github.com/cloudflare/mcp-server-cloudflare', launchHint: 'npx -y @cloudflare/mcp-server-cloudflare' },
  { id: 'pulumi', name: 'Pulumi', icon: '🟣', category: 'Infrastructure', legacyOfficial: true, publisher: 'Pulumi', description: 'Preview and deploy stacks, inspect registry types and stack outputs.', tags: ['iac', 'deploy'], suggestedUrl: 'http://pulumi-mcp:3000', repository: 'github.com/pulumi/mcp-server', launchHint: 'Deploy a remote transport wrapper around @pulumi/mcp-server.' },
  { id: 'commvault', name: 'Commvault', icon: '💾', category: 'Infrastructure', legacyOfficial: true, publisher: 'Commvault', description: 'Backup jobs, storage, clients, plans, SLA and schedules.', tags: ['backup', 'dr', 'data-protection'], suggestedUrl: 'http://commvault-mcp:9090', repository: 'github.com/Commvault/commvault-mcp-server', launchHint: 'Run the server with a dedicated environment file and restricted credentials.' },
  { id: 'proxmox', name: 'Proxmox VE', icon: '🖥', category: 'Infrastructure', legacyOfficial: false, publisher: 'Community · gilby125', description: 'Nodes, virtual machines, containers, storage and cluster status.', tags: ['virtualization', 'vm', 'hypervisor'], suggestedUrl: 'http://proxmox-mcp:3000', repository: 'github.com/gilby125/mcp-proxmox', launchHint: 'Review the community repository before deploying.' },
  { id: 'vsphere', name: 'VMware vSphere', icon: '🔶', category: 'Infrastructure', legacyOfficial: false, publisher: 'Community · giuliolibrando', description: 'vCenter VMs, hosts, datastores, networks and snapshots.', tags: ['vmware', 'virtualization', 'vcenter'], suggestedUrl: 'http://vsphere-mcp:8000', repository: 'github.com/giuliolibrando/vmware-vsphere-mcp-server', launchHint: 'Review the community repository before deploying.' },
  { id: 'azure-devops', name: 'Azure DevOps', icon: '☁', category: 'Cloud', legacyOfficial: false, publisher: 'Community · Microsoft', description: 'Work items, repositories, pipelines, boards and Wiki.', tags: ['azure', 'devops'], suggestedUrl: 'http://azdo-mcp:3000', repository: 'github.com/microsoft/azure-devops-mcp', launchHint: 'npx -y @azure-devops/mcp <organization>' },
  { id: 'azure-mssql', name: 'Azure SQL / MSSQL', icon: '🗄', category: 'Cloud', legacyOfficial: true, publisher: 'Microsoft', description: 'Queries, schemas, stored procedures and query plans.', tags: ['sql', 'azure', 'db'], suggestedUrl: 'http://azure-sql-mcp:3000', repository: 'github.com/microsoft/mssql-mcp', launchHint: 'Deploy the Microsoft server with a least-privilege database identity.' },
  { id: 'azure-mcp', name: 'Azure MCP', icon: '☁', category: 'Cloud', legacyOfficial: true, publisher: 'Microsoft', description: 'Azure services including AKS, Storage, Key Vault, Monitor and SQL.', tags: ['azure', 'aks', 'cloud'], suggestedUrl: 'http://azure-mcp:3000', repository: 'github.com/microsoft/mcp', launchHint: 'npx -y @azure/mcp@latest server start' },
  { id: 'aws', name: 'AWS', icon: '🟠', category: 'Cloud', legacyOfficial: true, publisher: 'AWS Labs', description: 'AWS service APIs including S3, EC2, Lambda and CloudWatch.', tags: ['aws', 'cloud'], suggestedUrl: 'http://aws-mcp:3000', repository: 'github.com/awslabs/mcp', launchHint: 'uvx awslabs.aws-mcp-server' },
  { id: 'gcp', name: 'GCP / Vertex AI', icon: '🔵', category: 'Cloud', legacyOfficial: false, publisher: 'Community', description: 'Google Cloud resources, Vertex AI and BigQuery.', tags: ['gcp', 'cloud', 'ai'], suggestedUrl: 'http://gcp-mcp:3000', repository: 'github.com/eniuane/gcp-mcp-server', launchHint: 'Review the community repository before deploying.' },
  { id: 'atlassian', name: 'Jira & Confluence', icon: '🎯', category: 'ITSM', legacyOfficial: false, publisher: 'Community · sooperset', description: 'Jira issues, boards and sprints plus Confluence pages and search.', tags: ['jira', 'confluence'], suggestedUrl: 'http://atlassian-mcp:3000', repository: 'github.com/sooperset/mcp-atlassian', launchHint: 'uvx mcp-atlassian with scoped Jira and Confluence credentials.' },
  { id: 'servicenow', name: 'ServiceNow', icon: '🎫', category: 'ITSM', legacyOfficial: false, publisher: 'Community', description: 'Incidents, changes, CMDB records and ServiceNow tables.', tags: ['itsm', 'cmdb'], suggestedUrl: 'http://servicenow-mcp:3000', repository: 'github.com/lspinheiro/servicenow-mcp', launchHint: 'npx -y servicenow-mcp-server' },
  { id: 'linear', name: 'Linear', icon: '📐', category: 'ITSM', legacyOfficial: true, publisher: 'Linear', description: 'Issues, projects, teams, labels and cycles.', tags: ['issues', 'agile'], suggestedUrl: 'https://mcp.linear.app/mcp', repository: 'github.com/linear/linear-mcp-server', launchHint: 'Remote server using the publisher OAuth flow.' },
  { id: 'ref-postgres', name: 'PostgreSQL', icon: '🐘', category: 'Storage', legacyOfficial: true, publisher: 'MCP reference · archived', description: 'SQL queries and schema inspection. The original reference package is archived.', tags: ['sql', 'db'], suggestedUrl: 'http://postgres-mcp:3000', repository: 'github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres', launchHint: 'Prefer an actively maintained server and use a read-only database role.' },
  { id: 'redis', name: 'Redis', icon: '🔴', category: 'Storage', legacyOfficial: true, publisher: 'Redis', description: 'Keys, hashes, lists, sets, streams, JSON and Pub/Sub.', tags: ['cache', 'db'], suggestedUrl: 'http://redis-mcp:3000', repository: 'github.com/redis/mcp-redis', launchHint: 'Run with a dedicated Redis account and restricted command permissions.' },
  { id: 'mongodb', name: 'MongoDB', icon: '🍃', category: 'Storage', legacyOfficial: true, publisher: 'MongoDB', description: 'CRUD, aggregation, collections and index management.', tags: ['nosql', 'db'], suggestedUrl: 'http://mongodb-mcp:3000', repository: 'github.com/mongodb-js/mongodb-mcp-server', launchHint: 'npx -y mongodb-mcp-server --connectionString=<uri>' },
  { id: 'ref-filesystem', name: 'Filesystem', icon: '📂', category: 'Storage', legacyOfficial: true, publisher: 'MCP reference', description: 'File operations restricted to explicitly allowed directories.', tags: ['files', 'local'], suggestedUrl: 'http://filesystem-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/filesystem', launchHint: 'Mount only the directories the server must access.' },
  { id: 'langgraph', name: 'LangGraph', icon: '🕸', category: 'Orchestration', legacyOfficial: true, publisher: 'LangChain', description: 'Multi-agent workflow orchestration, status and human approval.', tags: ['agents', 'workflow', 'ai'], suggestedUrl: 'http://langgraph:2025', repository: 'github.com/langchain-ai/langgraph', launchHint: 'Run the LangGraph API in an isolated environment.' },
  { id: 'langfuse', name: 'Langfuse', icon: '🔭', category: 'AI/LLM', legacyOfficial: true, publisher: 'Langfuse', description: 'Traces, sessions, observations, prompts, datasets and scores.', tags: ['llm', 'traces'], suggestedUrl: 'http://host.docker.internal:3100', repository: 'github.com/langfuse/mcp-server-langfuse', launchHint: 'Review the publisher repository for the current transport command.' },
  { id: 'ref-memory', name: 'Memory', icon: '🧠', category: 'AI/LLM', legacyOfficial: true, publisher: 'MCP reference', description: 'Persistent knowledge-graph memory for agents.', tags: ['memory', 'ai'], suggestedUrl: 'http://memory-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/memory', launchHint: 'Deploy with an explicit persistence and retention policy.' },
  { id: 'ref-brave', name: 'Brave Search', icon: '🔎', category: 'AI/LLM', legacyOfficial: true, publisher: 'MCP reference · archived', description: 'Web and local search. The original reference package was archived.', tags: ['search', 'web'], suggestedUrl: 'http://brave-mcp:3000', repository: 'github.com/modelcontextprotocol/servers-archived/tree/main/src/brave-search', launchHint: 'Prefer the currently maintained publisher server.' },
  { id: 'ref-sequential-thinking', name: 'Sequential Thinking', icon: '🧩', category: 'AI/LLM', legacyOfficial: true, publisher: 'MCP reference', description: 'Structured, reflective multi-step problem solving.', tags: ['reasoning', 'planning'], suggestedUrl: 'http://seqthinking-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking', launchHint: 'Deploy behind a remote transport wrapper.' },
  { id: 'ref-time', name: 'Time', icon: '🕐', category: 'AI/LLM', legacyOfficial: true, publisher: 'MCP reference', description: 'Current time and IANA timezone conversion.', tags: ['time', 'utility'], suggestedUrl: 'http://time-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/time', launchHint: 'uvx mcp-server-time behind a remote transport wrapper.' },
  { id: 'n8n', name: 'n8n', icon: '🔄', category: 'Automation', legacyOfficial: true, publisher: 'n8n ecosystem', description: 'Workflow automation, integrations and execution history.', tags: ['workflow', 'events'], suggestedUrl: 'http://n8n-mcp:3000/mcp', repository: 'github.com/nicepkg/mcp-server-n8n', launchHint: 'Run in HTTP mode with an authentication token.' },
  { id: 'ref-fetch', name: 'Fetch', icon: '🌐', category: 'Automation', legacyOfficial: true, publisher: 'MCP reference', description: 'Fetch web content and convert HTML into model-friendly text.', tags: ['http', 'web'], suggestedUrl: 'http://fetch-mcp:3000', repository: 'github.com/modelcontextprotocol/servers/tree/main/src/fetch', launchHint: 'Deploy with a strict egress policy to reduce SSRF risk.' },
  { id: 'ansible', name: 'Ansible Automation Platform', icon: '🅰', category: 'Automation', legacyOfficial: true, publisher: 'Red Hat · Ansible', description: 'Job templates, jobs, inventories, projects and hosts.', tags: ['ansible', 'automation', 'config'], suggestedUrl: 'http://ansible-mcp:8000', repository: 'github.com/ansible/aap-mcp-server', launchHint: 'Review the publisher repository for the current transport command.' },
  { id: 'ref-slack', name: 'Slack', icon: '💬', category: 'Communication', legacyOfficial: true, publisher: 'MCP reference · archived', description: 'Channels, messages, users, reactions and threads.', tags: ['chat', 'notify'], suggestedUrl: 'http://slack-mcp:3000', repository: 'github.com/modelcontextprotocol/servers-archived/tree/main/src/slack', launchHint: 'The original reference package is archived; review maintained alternatives.' },
  { id: 'notion', name: 'Notion', icon: '📓', category: 'Communication', legacyOfficial: true, publisher: 'Notion', description: 'Pages, databases, comments and workspace search.', tags: ['docs', 'wiki'], suggestedUrl: 'http://notion-mcp:3000', repository: 'github.com/makenotion/notion-mcp-server', launchHint: 'npx -y @notionhq/notion-mcp-server' },
  { id: 'ref-gdrive', name: 'Google Drive', icon: '📁', category: 'Communication', legacyOfficial: true, publisher: 'MCP reference · archived', description: 'Search and read files in Google Drive.', tags: ['google', 'files'], suggestedUrl: 'http://gdrive-mcp:3000', repository: 'github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive', launchHint: 'The original reference package is archived; review maintained alternatives.' },
  { id: 'twilio', name: 'Twilio', icon: '📱', category: 'Communication', legacyOfficial: true, publisher: 'Twilio Labs', description: 'SMS, voice calls, Verify and phone-number operations.', tags: ['sms', 'telephony'], suggestedUrl: 'http://twilio-mcp:3000', repository: 'github.com/twilio-labs/mcp', launchHint: 'Use a restricted Twilio key and explicit spend limits.' },
  { id: 'microsoft-teams', name: 'Microsoft Teams', icon: '👥', category: 'Communication', legacyOfficial: false, publisher: 'Community · floriscornel', description: 'Graph-backed chats, channel messages, teams, channels and users.', tags: ['teams', 'microsoft'], suggestedUrl: 'http://teams-mcp:3000', repository: 'github.com/floriscornel/teams-mcp', launchHint: 'npx -y @floriscornel/teams-mcp@latest' },
  { id: 'playwright', name: 'Playwright', icon: '🎭', category: 'Testing', legacyOfficial: true, publisher: 'Microsoft', description: 'Browser navigation, snapshots, screenshots and form interaction.', tags: ['test', 'browser'], suggestedUrl: 'http://playwright-mcp:3000', repository: 'github.com/microsoft/playwright-mcp', launchHint: 'npx -y @playwright/mcp@latest' },
  { id: 'stripe', name: 'Stripe', icon: '💳', category: 'Finance', legacyOfficial: true, publisher: 'Stripe', description: 'Customers, payments, subscriptions, invoices and refunds.', tags: ['payments', 'api'], suggestedUrl: 'http://stripe-mcp:3000', repository: 'github.com/stripe/agent-toolkit', launchHint: 'Use restricted mode and a least-privilege Stripe key.' },
  { id: 'hashicorp-vault', name: 'HashiCorp Vault', icon: '🔐', category: 'Security', legacyOfficial: true, publisher: 'HashiCorp', description: 'Secret engines, mounts and KV v1/v2 operations.', tags: ['vault', 'secrets'], suggestedUrl: 'http://vault-mcp:3000', repository: 'github.com/hashicorp/vault-mcp-server', launchHint: 'Run with a tightly scoped Vault policy and short-lived token.' },
  { id: 'snyk', name: 'Snyk', icon: '🛡', category: 'Security', legacyOfficial: false, publisher: 'Community · sammcj', description: 'Project, dependency and container security scanning.', tags: ['security', 'vuln', 'scanning'], suggestedUrl: 'http://snyk-mcp:3000', repository: 'github.com/sammcj/mcp-snyk', launchHint: 'Alpha community integration; review code and permissions before use.' },
  { id: 'clickhouse', name: 'ClickHouse', icon: '🟡', category: 'Data', legacyOfficial: true, publisher: 'ClickHouse', description: 'Read-only SQL, database and table discovery and chDB queries.', tags: ['sql', 'analytics'], suggestedUrl: 'http://clickhouse-mcp:3000', repository: 'github.com/ClickHouse/mcp-clickhouse', launchHint: 'uvx mcp-clickhouse with a read-only database user.' },
  { id: 'snowflake', name: 'Snowflake', icon: '❄', category: 'Data', legacyOfficial: true, publisher: 'Snowflake', description: 'Governed SQL, Cortex Search, Cortex Analyst and Cortex Agents through Snowflake-managed MCP.', tags: ['warehouse', 'cortex', 'rag', 'agents'], suggestedUrl: 'https://org-account.snowflakecomputing.com/api/v2/databases/database/schemas/schema/mcp-servers/server', repository: 'docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp', launchHint: 'Create a least-privileged Snowflake MCP SERVER, then replace the sample account, database, schema and server names with its managed endpoint. Prefer OAuth and read-only tools first.' },
  { id: 'supabase', name: 'Supabase', icon: '🟩', category: 'Data', legacyOfficial: false, publisher: 'Community · Supabase', description: 'SQL, migrations, branches, logs and Edge Functions.', tags: ['postgres', 'backend'], suggestedUrl: 'http://supabase-mcp:3000', repository: 'github.com/supabase-community/supabase-mcp', launchHint: 'npx -y @supabase/mcp-server-supabase@latest --access-token <token>' },
  { id: 'neon', name: 'Neon', icon: '🐘', category: 'Data', legacyOfficial: true, publisher: 'Neon', description: 'Serverless Postgres projects, branches, migrations and query tuning.', tags: ['postgres', 'serverless'], suggestedUrl: 'http://neon-mcp:3000', repository: 'github.com/neondatabase-labs/mcp-server-neon', launchHint: 'npx -y @neondatabase/mcp-server-neon start <api-key>' },
];

const catalogTools: Record<string, string[]> = {
  github: ['create_or_update_file', 'search_repositories', 'get_file_contents', 'create_issue', 'create_pull_request', 'search_code', 'list_issues', 'merge_pull_request'],
  gitlab: ['create_issue', 'create_merge_request', 'list_merge_requests', 'list_pipelines', 'list_projects', 'create_branch'],
  bitbucket: ['list_repositories', 'create_pull_request', 'list_pull_requests', 'list_branches', 'list_pipelines'],
  'ref-git': ['git_status', 'git_diff_unstaged', 'git_commit', 'git_log', 'git_create_branch', 'git_checkout'],
  jenkins: ['list_jobs', 'trigger_build', 'get_build', 'get_build_log', 'list_queue', 'cancel_build'],
  argocd: ['list_applications', 'get_application', 'sync_application', 'get_application_resource_tree', 'list_clusters'],
  circleci: ['get_build_failure_logs', 'find_flaky_tests', 'run_pipeline', 'rerun_workflow', 'list_artifacts'],
  buildkite: ['list_pipelines', 'create_build', 'get_build', 'get_job_logs', 'list_artifacts'],
  grafana: ['search_dashboards', 'get_dashboard_by_uid', 'query_prometheus', 'list_alert_rules', 'query_loki_logs'],
  prometheus: ['query', 'query_range', 'list_metrics', 'get_targets', 'get_alerts', 'get_rules'],
  datadog: ['list_monitors', 'list_incidents', 'list_dashboards', 'query_metrics', 'list_logs'],
  sentry: ['list_projects', 'list_issues', 'get_issue', 'list_events', 'list_releases'],
  pagerduty: ['list_incidents', 'create_incident', 'list_services', 'list_oncalls', 'list_schedules'],
  'new-relic': ['execute_nrql_query', 'get_entity', 'list_dashboards', 'list_alert_conditions', 'analyze_golden_metrics'],
  dynatrace: ['list_problems', 'list_vulnerabilities', 'get_kubernetes_events', 'execute_dql'],
  honeycomb: ['run_query', 'run_bubbleup', 'find_columns', 'get_trace', 'list_datasets'],
  opensearch: ['search_documents', 'index_document', 'list_indices', 'get_cluster_health', 'get_mappings'],
  elasticsearch: ['search', 'get_document', 'index_document', 'list_indices', 'get_cluster_health'],
  splunk: ['validate_spl', 'search_oneshot', 'search_export', 'get_indexes', 'get_saved_searches'],
  kubernetes: ['list_pods', 'get_pod', 'list_deployments', 'list_services', 'get_pod_logs', 'list_events'],
  docker: ['docker_list_containers', 'docker_run_container', 'docker_stop_container', 'docker_list_images', 'docker_compose_up'],
  terraform: ['resolveRegistryModuleId', 'getModuleDetails', 'lookupProviderPackage', 'getProviderDetails', 'searchModules'],
  consul: ['list_services', 'get_service_health', 'get_kv', 'put_kv', 'list_nodes'],
  cloudflare: ['workers_list', 'worker_get', 'kv_list_namespaces', 'd1_query', 'dns_list_records'],
  pulumi: ['pulumi-cli-preview', 'pulumi-cli-up', 'get-type', 'list-resources', 'stack-output'],
  commvault: ['list_jobs', 'get_job_details', 'get_sla_status', 'list_clients', 'list_storage_pools'],
  proxmox: ['list_nodes', 'list_vms', 'start_vm', 'stop_vm', 'list_containers', 'list_storage'],
  vsphere: ['list_vms', 'power_on_vm', 'power_off_vm', 'list_hosts', 'list_datastores', 'create_snapshot'],
  'azure-devops': ['get_work_item', 'create_work_item', 'list_repositories', 'list_pipelines', 'run_pipeline'],
  'azure-mssql': ['query', 'get_schema', 'list_tables', 'describe_table', 'execute_stored_procedure'],
  'azure-mcp': ['aks', 'storage', 'keyvault', 'monitor', 'cosmos', 'postgres', 'sql'],
  aws: ['s3_list_buckets', 'ec2_describe_instances', 'lambda_invoke', 'cloudwatch_get_metrics', 'sts_get_caller_identity'],
  gcp: ['list_projects', 'list_instances', 'list_buckets', 'query_bigquery', 'list_cloud_run_services'],
  atlassian: ['jira_get_issue', 'jira_search', 'jira_create_issue', 'confluence_get_page', 'confluence_search'],
  servicenow: ['list_records', 'get_record', 'create_record', 'update_record', 'execute_query'],
  linear: ['list_issues', 'create_issue', 'update_issue', 'list_projects', 'list_teams'],
  'ref-postgres': ['query', 'list_tables', 'describe_table', 'list_schemas', 'get_table_stats'],
  redis: ['set', 'get', 'delete', 'hash_getall', 'list_range', 'stream_read', 'json_get'],
  mongodb: ['find', 'aggregate', 'insertOne', 'updateOne', 'listDatabases', 'listCollections'],
  'ref-filesystem': ['read_text_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'list_allowed_directories'],
  langgraph: ['langgraph_create_thread', 'langgraph_start_coding_workflow', 'langgraph_get_workflow_status', 'langgraph_resume_workflow'],
  langfuse: ['langfuse_get_trace', 'langfuse_get_observations', 'langfuse_get_sessions', 'langfuse_get_prompts', 'langfuse_create_score'],
  'ref-memory': ['create_entities', 'create_relations', 'add_observations', 'read_graph', 'search_nodes'],
  'ref-brave': ['brave_web_search', 'brave_local_search'],
  'ref-sequential-thinking': ['sequentialthinking'],
  'ref-time': ['get_current_time', 'convert_time'],
  n8n: ['list_workflows', 'get_workflow', 'create_workflow', 'activate_workflow', 'execute_workflow'],
  'ref-fetch': ['fetch'],
  ansible: ['list_job_templates', 'launch_job', 'get_job_status', 'list_inventories', 'sync_project'],
  'ref-slack': ['slack_list_channels', 'slack_post_message', 'slack_reply_to_thread', 'slack_search_messages'],
  notion: ['notion_query_database', 'notion_get_page', 'notion_create_page', 'notion_search', 'notion_create_comment'],
  'ref-gdrive': ['search', 'read_file', 'list_files'],
  twilio: ['send_message', 'list_messages', 'make_call', 'create_verification', 'check_verification'],
  'microsoft-teams': ['send_channel_message', 'send_chat_message', 'list_teams', 'list_channels', 'search_messages'],
  playwright: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_evaluate'],
  stripe: ['create_customer', 'create_payment_link', 'create_invoice', 'create_subscription', 'create_refund'],
  'hashicorp-vault': ['list_mounts', 'read_secret', 'write_secret', 'list_secrets', 'delete_secret'],
  snyk: ['scan_project', 'test_dependencies', 'list_issues', 'monitor_project', 'test_container_image'],
  clickhouse: ['run_query', 'list_databases', 'list_tables', 'run_chdb_select_query'],
  snowflake: ['run_sql_query', 'list_objects', 'describe_object', 'cortex_search', 'cortex_analyst'],
  supabase: ['execute_sql', 'apply_migration', 'list_tables', 'create_branch', 'deploy_edge_function'],
  neon: ['list_projects', 'run_sql', 'create_branch', 'prepare_database_migration', 'list_slow_queries'],
};

function publisherKind(definition: CatalogDefinition): McpCatalogItem['publisherKind'] {
  if (definition.publisher.toLowerCase().includes('reference')) return 'reference';
  return definition.legacyOfficial ? 'vendor' : 'community';
}

export const MCP_CATALOG: McpCatalogItem[] = definitions.map(({ legacyOfficial, ...definition }) => ({
  ...definition,
  publisherKind: publisherKind({ ...definition, legacyOfficial }),
  tools: catalogTools[definition.id] ?? [],
}));

export const MCP_CATALOG_CATEGORIES = [
  ...new Set(MCP_CATALOG.map(item => item.category)),
].sort((left, right) => left.localeCompare(right));


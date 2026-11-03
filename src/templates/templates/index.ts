import type { ServiceTemplate } from '../serviceTemplates.js';

// ── API ──────────────────────────────────────────────────────
import { graphqlTemplate } from './api/graphql.js';
import { remoteMcpTemplate } from './api/remoteMcp.js';
import { restApiTemplate } from './api/restApi.js';

// ── Cloud ────────────────────────────────────────────────────
import { consulTemplate } from './cloud/consul.js';
import { kubernetesApiTemplate } from './cloud/kubernetes-api.js';
import { portainerTemplate } from './cloud/portainer.js';
import { rancherTemplate } from './cloud/rancher.js';
import { terraformCloudTemplate } from './cloud/terraform.js';
import { vaultTemplate } from './cloud/vault.js';

// ── Communication ────────────────────────────────────────────
import { discordWebhookTemplate } from './communication/discord.js';
import { mattermostTemplate } from './communication/mattermost.js';
import { slackTemplate } from './communication/slack.js';
import { teamsWebhookTemplate } from './communication/teams.js';

// ── Database ─────────────────────────────────────────────────
import { clickhouseTemplate } from './database/clickhouse.js';
import { elasticsearchTemplate } from './database/elasticsearch.js';
import { influxdbTemplate } from './database/influxdb.js';
import { mongodbTemplate } from './database/mongodb.js';
import { mssqlTemplate } from './database/mssql.js';
import { mysqlTemplate } from './database/mysql.js';
import { postgresqlTemplate } from './database/postgresql.js';
import { redisTemplate } from './database/redis.js';

// ── DevOps ───────────────────────────────────────────────────
import { argocdTemplate } from './devops/argocd.js';
import { droneTemplate } from './devops/drone.js';
import { giteaTemplate } from './devops/gitea.js';
import { githubTemplate } from './devops/github.js';
import { gitlabTemplate } from './devops/gitlab.js';
import { harborTemplate } from './devops/harbor.js';
import { jenkinsTemplate } from './devops/jenkins.js';
import { jenkinsDevCiTemplate } from './devops/jenkinsDevCi.js';
import { langgraphTemplate } from './devops/langgraph.js';
import { sonarqubeTemplate } from './devops/sonarqube.js';
import { tektonTemplate } from './devops/tekton.js';

// ── Monitoring ───────────────────────────────────────────────
import { datadogTemplate } from './monitoring/datadog.js';
import { grafanaTemplate } from './monitoring/grafana.js';
import { newrelicTemplate } from './monitoring/newrelic.js';
import { opsgenieTemplate } from './monitoring/opsgenie.js';
import { pagerdutyTemplate } from './monitoring/pagerduty.js';
import { prometheusTemplate } from './monitoring/prometheus.js';
import { sentryTemplate } from './monitoring/sentry.js';
import { signozTemplate } from './monitoring/signoz.js';
import { uptimekumaTemplate } from './monitoring/uptimekuma.js';

// ── Project Management ───────────────────────────────────────
import { asanaTemplate } from './projectmanagement/asana.js';
import { azureDevopsTemplate } from './projectmanagement/azure-devops.js';
import { confluenceTemplate } from './projectmanagement/confluence.js';
import { jiraTemplate } from './projectmanagement/jira.js';
import { linearTemplate } from './projectmanagement/linear.js';
import { notionTemplate } from './projectmanagement/notion.js';
import { trelloTemplate } from './projectmanagement/trello.js';

// ── Security ─────────────────────────────────────────────────
import { falcoTemplate } from './security/falco.js';
import { keycloakTemplate } from './security/keycloak.js';
import { trivyTemplate } from './security/trivy.js';

// ── All Templates ────────────────────────────────────────────

export const ALL_TEMPLATES: ServiceTemplate[] = [
  // API
  graphqlTemplate,
  remoteMcpTemplate,
  restApiTemplate,

  // Cloud
  consulTemplate,
  kubernetesApiTemplate,
  portainerTemplate,
  rancherTemplate,
  terraformCloudTemplate,
  vaultTemplate,

  // Communication
  discordWebhookTemplate,
  mattermostTemplate,
  slackTemplate,
  teamsWebhookTemplate,

  // Database
  clickhouseTemplate,
  elasticsearchTemplate,
  influxdbTemplate,
  mongodbTemplate,
  mssqlTemplate,
  mysqlTemplate,
  postgresqlTemplate,
  redisTemplate,

  // DevOps
  argocdTemplate,
  droneTemplate,
  giteaTemplate,
  githubTemplate,
  gitlabTemplate,
  harborTemplate,
  jenkinsTemplate,
  jenkinsDevCiTemplate,
  langgraphTemplate,
  sonarqubeTemplate,
  tektonTemplate,

  // Monitoring
  datadogTemplate,
  grafanaTemplate,
  newrelicTemplate,
  opsgenieTemplate,
  pagerdutyTemplate,
  prometheusTemplate,
  sentryTemplate,
  signozTemplate,
  uptimekumaTemplate,

  // Project Management
  asanaTemplate,
  azureDevopsTemplate,
  confluenceTemplate,
  jiraTemplate,
  linearTemplate,
  notionTemplate,
  trelloTemplate,

  // Security
  falcoTemplate,
  keycloakTemplate,
  trivyTemplate,

];

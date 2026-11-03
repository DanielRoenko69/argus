import { Box, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

const LOCAL_BRAND_ASSETS = new Set([
  'ansible', 'argocd', 'atlassian', 'bitbucket', 'buildkite', 'circleci',
  'clickhouse', 'cloudflare', 'consul', 'datadog', 'docker', 'dynatrace',
  'elasticsearch', 'gcp', 'github', 'gitlab', 'grafana', 'hashicorp-vault',
  'jenkins', 'kubernetes', 'langgraph', 'linear', 'mongodb', 'n8n', 'neon',
  'new-relic', 'notion', 'opensearch', 'pagerduty', 'prometheus', 'proxmox',
  'pulumi', 'redis', 'ref-brave', 'ref-gdrive', 'ref-git', 'ref-postgres',
  'sentry', 'slack', 'snowflake', 'snyk', 'splunk', 'stripe', 'supabase', 'terraform',
  'vsphere',
]);

const BACKEND_BRAND_MATCHERS: Array<[brand: string, patterns: RegExp[]]> = [
  ['github', [/github/i, /api\.github\.com/i]],
  ['gitlab', [/gitlab/i]],
  ['bitbucket', [/bitbucket/i]],
  ['ref-postgres', [/postgres(?:ql)?/i, /\bpg(?:sql)?\b/i]],
  ['slack', [/slack/i]],
  ['redis', [/redis/i]],
  ['kubernetes', [/kubernetes/i, /\bk8s\b/i, /openshift/i, /\baks\b/i, /\beks\b/i, /\bgke\b/i]],
  ['elasticsearch', [/elasticsearch/i, /elastic\.co/i]],
  ['opensearch', [/opensearch/i]],
  ['prometheus', [/prometheus/i]],
  ['grafana', [/grafana/i, /\bloki\b/i]],
  ['langgraph', [/langgraph/i]],
  ['atlassian', [/atlassian/i, /\bjira\b/i, /confluence/i]],
  ['pagerduty', [/pagerduty/i]],
  ['datadog', [/datadog/i]],
  ['dynatrace', [/dynatrace/i]],
  ['new-relic', [/new[\s._-]?relic/i]],
  ['sentry', [/sentry/i]],
  ['splunk', [/splunk/i]],
  ['docker', [/docker/i]],
  ['jenkins', [/jenkins/i]],
  ['circleci', [/circleci/i]],
  ['buildkite', [/buildkite/i]],
  ['argocd', [/argo[\s._-]?cd/i]],
  ['terraform', [/terraform/i]],
  ['ansible', [/ansible/i]],
  ['cloudflare', [/cloudflare/i]],
  ['mongodb', [/mongodb/i, /\bmongo\b/i]],
  ['clickhouse', [/clickhouse/i]],
  ['snowflake', [/snowflake/i]],
  ['supabase', [/supabase/i]],
  ['neon', [/\bneon\b/i]],
  ['n8n', [/\bn8n\b/i]],
  ['linear', [/\blinear\b/i]],
  ['notion', [/notion/i]],
  ['stripe', [/stripe/i]],
  ['gcp', [/google[\s._-]?cloud/i, /\bgcp\b/i]],
  ['hashicorp-vault', [/vault/i]],
];

export interface BrandIconProps {
  brand: string;
  label: string;
  className?: string;
  fallback?: LucideIcon;
}

/**
 * Renders a locally bundled vendor mark. Unsupported brands deliberately use
 * a neutral product glyph instead of an emoji or a third-party runtime URL.
 */
export function BrandIcon({ brand, label, className = '', fallback: Fallback = Box }: BrandIconProps) {
  const [failed, setFailed] = useState(false);
  const supported = LOCAL_BRAND_ASSETS.has(brand);

  return (
    <span className={`brand-icon ${className}`.trim()} aria-label={`${label} logo`} role="img">
      {supported && !failed
        ? <img src={`/console-assets/brand/${brand}.svg`} alt="" onError={() => setFailed(true)} />
        : <Fallback aria-hidden="true" />}
    </span>
  );
}

export function hasLocalBrandAsset(brand: string): boolean {
  return LOCAL_BRAND_ASSETS.has(brand);
}

/**
 * Resolves a governed backend to a bundled provider mark without requiring a
 * new database field. Name, endpoint and description are intentionally treated
 * as hints only; unknown systems keep the neutral server glyph.
 */
export function resolveBackendBrand(...hints: Array<string | null | undefined>): string | null {
  const candidate = hints.filter(Boolean).join(' ');
  if (!candidate) return null;
  return BACKEND_BRAND_MATCHERS.find(([, patterns]) => patterns.some(pattern => pattern.test(candidate)))?.[0] ?? null;
}

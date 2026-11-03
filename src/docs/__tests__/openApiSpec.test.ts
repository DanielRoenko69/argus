import { describe, expect, it } from '@jest/globals';
import { buildOpenApiSpec, buildSwaggerHtml } from '../openApiSpec.js';

type Operation = {
  operationId?: string;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
  security?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

function operations(spec: Record<string, unknown>): Operation[] {
  const paths = spec['paths'] as Record<string, Record<string, Operation>>;
  return Object.values(paths).flatMap(path =>
    Object.entries(path).filter(([method]) => methods.has(method)).map(([, operation]) => operation),
  );
}

describe('OpenAPI platform contract', () => {
  it('documents immutable Skill drafts, exclusive comparison references and MFA pin releases',()=>{
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    const draft=paths['/api/admin/evaluations/agents/{id}/skill-revisions']!;
    expect(JSON.stringify(draft['post']!['requestBody'])).toContain('skill_id');
    for (const suffix of ['','/preflight']) expect(JSON.stringify(paths['/api/admin/evaluations/comparisons'+suffix]!['post']!['requestBody'])).toContain('skill_revision_id');
    for (const path of ['/comparisons/{id}/skill-release','/skill-releases/{id}/rollback']) {
      const op=paths['/api/admin/evaluations'+path]!['post']!;
      expect(op['responses']).toHaveProperty('428');expect(op['description']).toContain('Other Agents');
      expect(op.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',required:true }));
    }
  });
  it('documents immutable prompt drafts and MFA-bound release without implied model calls',()=>{
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    const draft=paths['/api/admin/evaluations/agents/{id}/prompt-revisions']!;
    expect(draft['get']!['description']).toContain('latest 25');
    expect(draft['post']!.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',required:true }));
    expect(JSON.stringify(draft['post']!['requestBody'])).toContain('source_head_sha256');
    for (const suffix of ['','/preflight']) {
      expect(JSON.stringify(paths['/api/admin/evaluations/comparisons'+suffix]!['post']!['requestBody'])).toContain('prompt_revision_id');
    }
    for (const path of ['/comparisons/{id}/prompt-release','/prompt-releases/{id}/rollback']) {
      const op=paths['/api/admin/evaluations'+path]!['post']!;
      expect(op.security).toEqual([{ SessionCookie:[] }]);
      expect(op['responses']).toHaveProperty('428');
      expect(op['description']).toContain('No model calls');
      expect(op['description']).toContain('audit/outbox');
    }
  });
  it('documents bounded Quality Inbox reads and audited, drift-bound human review writes',() => {
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    const list=paths['/api/admin/evaluations/review-queue']!['get']!;
    expect(list.security).toEqual([{ SessionCookie:[] }]);
    expect(list['description']).toContain('500');
    expect(list['description']).toContain('No model calls');
    const detail=paths['/api/admin/evaluations/review-queue/{traceId}']!;
    expect(detail['get']!['description']).toContain('Private no-store');
    const save=detail['post']!;
    expect(save.security).toEqual([{ SessionCookie:[] }]);
    expect(save.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',required:true }));
    expect(save['description']).toContain('QUALITY_REVIEW_STALE');
    expect(save['description']).toContain('commit atomically');
    expect(JSON.stringify(save['requestBody'])).toContain('previous_review_id');
    expect(save['responses']).toHaveProperty('201');
    expect(save['responses']).toHaveProperty('409');
  });
  it('documents reviewed curation without execution or ground-truth claims',() => {
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    expect(paths['/api/admin/evaluations/starter-sets']!['get']!['description']).toContain('synthetic');
    const preview=paths['/api/admin/evaluations/trace-preview']!['post']!;
    expect(preview.security).toEqual([{ SessionCookie:[] }]);
    expect(preview['description']).toContain('No expected output is inferred');
    for (const path of ['/api/admin/evaluations/starter-sets/{key}/import','/api/admin/evaluations/datasets/{id}/from-trace']) {
      const op=paths[path]!['post']!;
      expect(op.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',required:true }));
      expect(JSON.stringify(op['requestBody'])).toContain('reviewed');
      expect(op['responses']).toHaveProperty('201');
      expect(op['responses']).toHaveProperty('409');
      expect(op['description']).toContain('No model calls');
    }
  });
  it('documents protected artifact downloads without promising signed compliance evidence',() => {
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    for(const suffix of ['','/content']) {
      const op=paths['/api/admin/evaluations/comparisons/{id}/export'+suffix]!['get']!;
      expect(op.security).toEqual([{ SessionCookie:[] }]);
      expect(op.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',required:true }));
      expect(op.parameters).toContainEqual(expect.objectContaining({ name:'format',schema:{ type:'string',enum:['json','csv','pdf'] } }));
      expect(op.parameters).toContainEqual(expect.objectContaining({ name:'format',required:true }));
      expect(op['responses']).toHaveProperty('428');expect(op['responses']).toHaveProperty('413');
      expect(op['description']).toContain('No signature, WORM');
    }
  });
  it('documents isolated execution and blocked runtime boundaries truthfully', () => {
    const spec=buildOpenApiSpec('http://localhost:3000');
    const paths=spec['paths'] as Record<string,Record<string,Operation>>;
    const run=paths['/api/admin/evaluations/experiments/{id}/run']!['post']!;
    expect(run.security).toEqual([{ SessionCookie:[] }]);
    expect(run['description']).toContain('EVALUATION_EXECUTOR_NOT_READY');
    expect(run['responses']).toHaveProperty('409');
    expect(run['responses']).toHaveProperty('202');
    expect(paths['/api/admin/evaluations/datasets/{id}/cases']).toBeDefined();
    expect(paths['/api/admin/evaluations/experiments/{id}/regression']).toBeDefined();
    expect(paths['/api/admin/evaluations/experiments/{id}/cancel']!['post']!['responses']).toHaveProperty('202');
    const retry=paths['/api/admin/evaluations/experiments/{id}/retry']!['post']!;
    expect(retry['description']).toContain('Idempotency-Key required');
    expect(JSON.stringify(retry['requestBody'])).toContain('acknowledge_possible_duplicate_cost');
  });
  it('documents the modern Argus product surface without an LLM proxy API', () => {
    const spec = buildOpenApiSpec('http://localhost:3000');
    const paths = spec['paths'] as Record<string, unknown>;
    const tags = spec['tags'] as Array<{ name: string }>;
    const components = spec['components'] as { securitySchemes: Record<string, unknown> };
    const metadata = spec['x-argus-documentation'] as Record<string, unknown>;

    expect(Object.keys(paths).some(path => path.startsWith('/v1/'))).toBe(false);
    expect(tags.some(tag => tag.name === 'LLM Gateway')).toBe(false);
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(100);
    expect(operations(spec).length).toBeGreaterThanOrEqual(120);

    expect(paths['/mcp']).toBeDefined();
    expect(paths['/api/me']).toBeDefined();
    expect(paths['/api/connections']).toBeDefined();
    expect(paths['/api/ui/mcp-fabric/connections/{id}/sso-launch']).toBeDefined();
    expect(paths['/api/agents/{id}/chat']).toBeDefined();
    expect(paths['/api/workflows/{id}/execute']).toBeDefined();
    expect(paths['/api/hermes-dev/runtime/runs']).toBeDefined();
    expect(paths['/api/ui/knowledge/repository-snapshots/{id}/full-graph']).toBeDefined();
    expect(paths['/api/observability/aiops/provider-signals/{provider}']).toBeDefined();
    expect(paths['/api/ui/runs/v2']).toBeDefined();
    expect(paths['/api/ui/audit/report-runs/v1']).toBeDefined();
    expect(paths['/api/ui/compliance/ai-systems']).toBeDefined();

    expect(components.securitySchemes['SessionCookie']).toBeDefined();
    expect(components.securitySchemes['ApiKeyHeader']).toBeDefined();
    expect(components.securitySchemes['BearerAuth']).toBeDefined();
    expect(components.securitySchemes['AiOpsWebhookHmac']).toBeDefined();
    expect(metadata['complianceClaim']).toContain('not a legal certification');
  });

  it('documents paired cost acknowledgement and usable idempotency headers',() => {
    const paths=buildOpenApiSpec('http://localhost:3000')['paths'] as Record<string,Record<string,Operation>>;
    const create=paths['/api/admin/evaluations/comparisons']!['post']!;
    expect(JSON.stringify(create['requestBody'])).toContain('repetitions');
    expect(JSON.stringify(create['requestBody'])).toContain('reviewed_preflight_sha256');
    const preflight=paths['/api/admin/evaluations/comparisons/preflight']!['post']!;
    expect(preflight.security).toEqual([{ SessionCookie:[] }]);
    expect(JSON.stringify(preflight['requestBody'])).toContain('model_ref');
    expect(JSON.stringify(preflight['responses'])).toContain('preflight_sha256');
    expect(paths['/api/admin/evaluations/targets']!['get']!.parameters).toContainEqual(expect.objectContaining({ name:'agent_id',in:'query',required:true }));
    expect(create['responses']).toHaveProperty('201');
    for (const path of ['/api/admin/evaluations/comparisons','/api/admin/evaluations/comparisons/{id}/run','/api/admin/evaluations/comparisons/{id}/cancel']) {
      const operation=paths[path]!['post']!;
      expect(operation.parameters).toContainEqual(expect.objectContaining({ name:'Idempotency-Key',in:'header',required:true }));
      expect(operation.security).toEqual([{ SessionCookie:[] }]);
    }
    expect(JSON.stringify(paths['/api/admin/evaluations/comparisons/{id}/run']!['post']!['requestBody'])).toContain('acknowledge_cost');
  });

  it('uses unique operation IDs and declares every path parameter', () => {
    const spec = buildOpenApiSpec('http://localhost:3000');
    const paths = spec['paths'] as Record<string, Record<string, Operation>>;
    const ids = operations(spec).map(operation => operation.operationId);

    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    for (const [path, item] of Object.entries(paths)) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
      for (const [method, operation] of Object.entries(item)) {
        if (!methods.has(method)) continue;
        const actual = (operation.parameters ?? [])
          .filter(parameter => parameter.in === 'path' && parameter.required)
          .map(parameter => parameter.name);
        expect(actual.sort()).toEqual(expected.sort());
      }
    }
  });

  it('only references schemas that exist in the document', () => {
    const spec = buildOpenApiSpec('http://localhost:3000');
    const components = spec['components'] as { schemas: Record<string, unknown> };
    const serialized = JSON.stringify(spec);
    const references = [...serialized.matchAll(/#\/components\/schemas\/([^"\\]+)/g)].map(match => match[1]);

    expect(references.length).toBeGreaterThan(20);
    for (const reference of references) expect(components.schemas[reference]).toBeDefined();
  });

  it('serves a branded, searchable and interactive explorer shell', () => {
    const html = buildSwaggerHtml();

    expect(html).toContain('<title>Argus API Explorer</title>');
    expect(html).toContain('Build against Argus with confidence.');
    expect(html).toContain("url:'/openapi.json'");
    expect(html).toContain('filter:true');
    expect(html).toContain('persistAuthorization:true');
    expect(html).toContain('displayRequestDuration:true');
    expect(html).toContain('Download JSON');
    expect(html).not.toContain('switchDocTab');
    expect(html).not.toContain('Betriebskonzept');
  });
});

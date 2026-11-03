import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  getNativeServiceTemplateCatalog,
  installNativeServiceTemplate,
  normalizeServiceTemplateInstall,
} from '../serviceTemplateCatalog.js';
import { classifyTemplateQueryRisk } from '../../templates/applyTemplate.js';
import { jenkinsDevCiTemplate } from '../../templates/templates/devops/jenkinsDevCi.js';

describe('native service template catalog', () => {
  it('requires an explicit build-only CI policy for the review-only image job', () => {
    const fields = { base_url:'http://jenkins:8080', git_origin:'http://gitea:3000', repository:'alex/demo',
      job:'demo-image', branch_prefix:'feature/DEMO-' };
    expect(jenkinsDevCiTemplate.buildConfig?.(fields)).toMatchObject({dev_ci:{job:'demo-image'}});
    expect(jenkinsDevCiTemplate.buildConfig?.(fields)).not.toHaveProperty('dev_ci.verification_mode');
    expect(jenkinsDevCiTemplate.buildConfig?.({...fields,verification_mode:'review-only-image'}))
      .toHaveProperty('dev_ci.verification_mode','review-only-image');
  });
  it('projects safe metadata and keeps the unsafe PostgreSQL legacy template blocked', () => {
    const catalog = getNativeServiceTemplateCatalog();
    expect(catalog.templates).toHaveLength(51);
    expect(catalog.templates.find(template => template.id === 'jenkins-dev-ci')).toMatchObject({ installable:true, tools:[] });
    const github = catalog.templates.find(template => template.id === 'github');
    const gitea = catalog.templates.find(template => template.id === 'gitea');
    const langgraph = catalog.templates.find(template => template.id === 'langgraph');
    const postgres = catalog.templates.find(template => template.id === 'postgresql');
    const mongodb = catalog.templates.find(template => template.id === 'mongodb');
    expect(github?.fields.find(field => field.name === 'token')).not.toHaveProperty('default');
    expect(JSON.stringify(github)).not.toContain('github-secret');
    expect(gitea).toMatchObject({ name: 'Gitea', installable: true, backendType: 'http' });
    expect(gitea?.tools.map(tool => tool.nameSuffix)).toContain('list_action_runs');
    expect(langgraph).toMatchObject({ name: 'LangGraph', installable: true, backendType: 'http' });
    expect(langgraph?.tools.map(tool => tool.nameSuffix)).toEqual([
      'list_workflows', 'list_threads', 'get_thread',
    ]);
    expect(langgraph?.tools.every(tool => tool.riskLevel === 'low' && tool.isWrite === false)).toBe(true);
    expect(postgres).toMatchObject({ installable: false });
    expect(postgres?.unavailableReason).toMatch(/credential-safe/i);
    expect(mongodb?.name).toBe('MongoDB Atlas');
  });

  it('requires a governed bundle and validates only template-declared fields', () => {
    expect(() => normalizeServiceTemplateInstall('github', {
      prefix: 'github_prod', fields: { token: 'secret', injected: 'ignored' }, bundleId: null,
    })).toThrow(/access bundle/i);
    expect(normalizeServiceTemplateInstall('github', {
      prefix: 'github_prod', fields: { token: 'secret', injected: 'ignored' }, bundleId: 7,
    })).toEqual({ templateId: 'github', prefix: 'github_prod', fields: { token: 'secret' }, bundleId: 7 });
  });

  it('normalizes a self-hosted Gitea connection without exposing its token', () => {
    const normalized = normalizeServiceTemplateInstall('gitea', {
      prefix: 'gitea_local',
      fields: {
        base_url: 'http://gitea:3000/',
        token: 'gitea-secret',
        owner: 'argus',
        repo: 'argus-dev-sample',
      },
      bundleId: 9,
    });
    expect(normalized).toEqual({
      templateId: 'gitea',
      prefix: 'gitea_local',
      fields: {
        base_url: 'http://gitea:3000/',
        token: 'gitea-secret',
        owner: 'argus',
        repo: 'argus-dev-sample',
        default_branch: 'main',
        public_base_url: '',
      },
      bundleId: 9,
    });
  });

  it('rejects embedded URL credentials and blocked template installation', () => {
    expect(() => normalizeServiceTemplateInstall('rest-api', {
      prefix: 'unsafe_api', fields: { base_url: 'https://user:password@example.com', auth_type: 'none' }, bundleId: 2,
    })).toThrow(/embedded credentials/i);
    expect(() => normalizeServiceTemplateInstall('postgresql', {
      prefix: 'postgres_prod', fields: {}, bundleId: 2,
    })).toThrow(/credential-safe/i);
  });

  it('encrypts credentials and stages the connection disabled inside its bundle', async () => {
    const originalKey = process.env['DB_ENCRYPTION_KEY'];
    process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
    const captured: Array<{ sql: string; params: unknown[] }> = [];
    let toolId = 20;
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        captured.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (sql.includes('INSERT INTO mcp_backends')) return { rows: [{ id: 12, name: 'github_prod' }] };
        if (sql.includes('INSERT INTO mcp_tools')) return { rows: [{ id: ++toolId, name: `tool_${toolId}` }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = {
      query: jest.fn(async () => ({ rows: [{ id: 4 }] })),
      connect: jest.fn(async () => client),
    } as unknown as pg.Pool;
    try {
      const installed = await installNativeServiceTemplate(pool, 'github', {
        prefix: 'github_prod', fields: { token: 'super-secret' }, bundleId: 4,
      });
      expect(installed.result.tools).toHaveLength(5);
      const backendInsert = captured.find(entry => entry.sql.startsWith('INSERT INTO mcp_backends'))!;
      expect(backendInsert.params[4]).toMatch(/^enc:v1:/);
      expect(backendInsert.params[4]).not.toBe('super-secret');
      expect(backendInsert.params[9]).toBe(false);
      const toolInserts = captured.filter(entry => entry.sql.startsWith('INSERT INTO mcp_tools'));
      expect(toolInserts).toHaveLength(5);
      expect(toolInserts.every(entry => entry.params[7] === false && entry.params[8] === 'low')).toBe(true);
      expect(captured.some(entry => entry.sql === 'COMMIT')).toBe(true);
    } finally {
      if (originalKey === undefined) delete process.env['DB_ENCRYPTION_KEY'];
      else process.env['DB_ENCRYPTION_KEY'] = originalKey;
    }
  });
});

describe('service template capability governance', () => {
  it('marks reads low-risk and mutating HTTP operations as governed writes', () => {
    expect(classifyTemplateQueryRisk('GET /projects')).toEqual({ isWrite: false, riskLevel: 'low' });
    expect(classifyTemplateQueryRisk('SELECT * FROM projects')).toEqual({ isWrite: false, riskLevel: 'low' });
    expect(classifyTemplateQueryRisk('POST /projects')).toEqual({ isWrite: true, riskLevel: 'medium' });
    expect(classifyTemplateQueryRisk('PATCH /projects/1')).toEqual({ isWrite: true, riskLevel: 'high' });
    expect(classifyTemplateQueryRisk('DELETE /projects/1')).toEqual({ isWrite: true, riskLevel: 'high' });
  });
});

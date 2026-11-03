import { jest } from '@jest/globals';
import type pg from 'pg';
import { assertResourceExists, createWorkspaceTag, replaceResourceTags } from '../store.js';

describe('workspace tag store boundaries', () => {
  it('uses the closed resource registry rather than interpolating a submitted table name', async () => {
    const query = jest.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ label: 'Workflow' }] }));
    await expect(assertResourceExists({ query } as unknown as pg.Pool, 'workflow', '42')).resolves.toBe('Workflow');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM mcp_workflows'),
      ['42'],
    );
    expect(query.mock.calls[0]?.[0]).not.toContain('42');
  });

  it('resolves AIOps profiles through the closed resource registry', async () => {
    const query = jest.fn(async () => ({ rows: [{ label: 'Checkout API · production' }] }));
    await expect(assertResourceExists(
      { query } as unknown as pg.Pool,
      'aiops_service_profile',
      '41',
    )).resolves.toBe('Checkout API · production');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM mcp_observability_aiops_service_profiles'),
      ['41'],
    );
  });

  it('resolves AI systems through the closed resource registry', async () => {
    const query = jest.fn(async () => ({ rows: [{ label: 'Governed coding assistant' }] }));
    await expect(assertResourceExists(
      { query } as unknown as pg.Pool,
      'ai_system',
      '10000000-0000-4000-8000-000000000001',
    )).resolves.toBe('Governed coding assistant');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM mcp_ai_systems'),
      ['10000000-0000-4000-8000-000000000001'],
    );
  });

  it('serializes workspace tag creation and commits the bounded insert', async () => {
    const now = new Date('2026-09-07T12:00:00.000Z');
    const query = jest.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('count(*)::text')) return { rows: [{ count: '2' }] };
      if (sql.includes('INSERT INTO mcp_workspace_tags')) return { rows: [{
        id: 3,
        slug: 'platform',
        label: 'Platform',
        color: '#7c3aed',
        description: '',
        usage_count: 0,
        created_at: now,
        updated_at: now,
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = jest.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    await expect(createWorkspaceTag(pool, {
      slug: 'platform', label: 'Platform', color: '#7c3aed', description: '',
    }, 17)).resolves.toMatchObject({ id: '3', usageCount: 0 });
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalled();
  });

  it('rolls back assignment replacement when a submitted tag does not exist', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT name AS label FROM mcp_workflows')) return { rows: [{ label: 'Workflow' }] };
      if (sql.includes('SELECT id FROM mcp_workspace_tags')) return { rows: [{ id: 1 }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = jest.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    await expect(replaceResourceTags(pool, 'workflow', '42', ['1', '2'], 17)).rejects.toThrow('not found');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalled();
    expect(query.mock.calls.some(call => String(call[0]).includes('DELETE FROM mcp_resource_tag_assignments'))).toBe(false);
  });
});

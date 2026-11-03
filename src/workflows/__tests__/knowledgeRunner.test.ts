import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { Config } from '../../config/env.js';
import type { ToolRunner } from '../types.js';

jest.mock('../../agents/agentRunner.js', () => ({ runAgentChatSync: jest.fn() }));
jest.mock('../../agents/skillStore.js', () => ({ getSkill: jest.fn() }));
jest.mock('../../agents/memory.js', () => ({ retrieveMemories: jest.fn(), storeMemory: jest.fn() }));
jest.mock('../../agents/ragSearch.js', () => ({ searchRagIndex: jest.fn() }));
jest.mock('../../agents/ragClient.js', () => ({ formatRagContext: jest.fn() }));

import { searchRagIndex } from '../../agents/ragSearch.js';
import { formatRagContext } from '../../agents/ragClient.js';
import { buildRealRunners } from '../executeRoutes.js';

const noopToolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: '' }] });

function sourceRow() {
  return {
    id: 17,
    name: 'platform-runbooks',
    label: 'Platform Runbooks',
    description: 'Operational knowledge',
    provider: 'pgvector',
    endpoint: '',
    index_name: '',
    api_key: null,
    semantic_config: null,
    top_k: 8,
    enabled: true,
    created_at: '',
    updated_at: '',
    vector_field: null,
    adapter_config: { text_field: 'content' },
    hyde_enabled: false,
  };
}

describe('buildRealRunners — unified Knowledge provider path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses searchRagIndex with the DB pool so pgvector and external adapters share one path', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [sourceRow()] })),
    } as unknown as pg.Pool;
    const results = [{ id: 'chunk-1', score: 0.91, content: 'restart the deployment', source: 'runbook.md' }];
    jest.mocked(searchRagIndex).mockResolvedValue(results);
    jest.mocked(formatRagContext).mockReturnValue('formatted context');

    const runners = buildRealRunners(pool, {} as Config, noopToolRunner);
    const output = await runners.ragRunner!(' platform-runbooks ', 'How do I recover?', 3);

    expect(output).toBe('formatted context');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('adapter_config'),
      ['platform-runbooks'],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('enabled = true'),
      ['platform-runbooks'],
    );
    expect(searchRagIndex).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'platform-runbooks', provider: 'pgvector', top_k: 3 }),
      'How do I recover?',
      pool,
    );
    expect(formatRagContext).toHaveBeenCalledWith(results, 'Platform Runbooks');
  });

  it('rejects empty queries before calling a provider', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const runners = buildRealRunners(pool, {} as Config, noopToolRunner);

    await expect(runners.ragRunner!('platform-runbooks', '   ', 5)).rejects.toThrow(
      'argus.knowledge requires a query',
    );
    expect(pool.query).not.toHaveBeenCalled();
    expect(searchRagIndex).not.toHaveBeenCalled();
  });

  it('does not execute missing or disabled sources', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [] })),
    } as unknown as pg.Pool;
    const runners = buildRealRunners(pool, {} as Config, noopToolRunner);

    await expect(runners.ragRunner!('disabled-kb', 'query', 5)).rejects.toThrow(
      "rag index 'disabled-kb' not found or disabled",
    );
    expect(searchRagIndex).not.toHaveBeenCalled();
  });
});

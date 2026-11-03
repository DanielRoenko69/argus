import { describe,expect,it,jest } from '@jest/globals';
import type pg from 'pg';
import { planModelRetirement,retirementNames,retireModels } from '../modelRetirement.js';

describe('explicit model retirement', () => {
  it('requires exact named targets and normalizes order', () => {
    expect(retirementNames(['b','a','a'])).toEqual(['a','b']);
    for (const input of [[],[''],[' a'],['a\n'],Array(11).fill('a')]) {
      expect(() => retirementNames(input)).toThrow();
    }
  });
  function fixture(blocking=false) {
    const models=[{ id:1,model_name:'old',updated_at:'2026-09-23' }];
    const query=jest.fn(async (sql:string) => ({ rows:sql.includes('FROM mcp_models') ? models
      : sql.includes('FROM mcp_agents') ? [{ id:7,name:'coder',api_dependency:blocking,runtime_model:'current' }]
        : [{ database:'fixture_cert',operator:'test' }] }));
    return { models,query,client:{ query } as unknown as pg.PoolClient };
  }
  it('is read-only, stable and detects drift without reading credentials or prompts', async () => {
    const f=fixture(),scope={ environment:'test' };
    const a=await planModelRetirement(f.client,['old'],scope);
    expect(a.removable).toBe(true);
    expect((await planModelRetirement(f.client,['old'],scope)).sha256).toBe(a.sha256);
    f.models[0]!.updated_at='changed';
    expect((await planModelRetirement(f.client,['old'],scope)).sha256).not.toBe(a.sha256);
    for (const [sql] of f.query.mock.calls) {
      expect(sql).toMatch(/^SELECT/);
      expect(sql).not.toMatch(/api_key|system_prompt|password|secret/i);
    }
  });
  it('reports API blockers and absent aliases without accepting a partial batch', async () => {
    const f=fixture(true);
    const p=await planModelRetirement(f.client,['old','missing'],{ environment:'test' });
    expect(p.removable).toBe(false);
    expect(p.missing).toEqual(['missing']);
    expect(p.blocking_agent_ids).toEqual([7]);
  });
  it('rejects apply without a reviewed hash before connecting', async () => {
    await expect(retireModels({} as pg.Pool,['old'],'',{ environment:'test' })).rejects.toThrow('SHA-256');
  });
});

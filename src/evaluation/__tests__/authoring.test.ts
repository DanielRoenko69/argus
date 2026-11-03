import type pg from 'pg';
import { assertEvaluationAgent } from '../snapshots.js';
import { getAgentRuntimeAssignment } from '../../agents/runtimeProfiles.js';
import { listEvaluationTargets } from '../authoring.js';
import type { EvaluationContext } from '../context.js';

jest.mock('../snapshots.js',() => ({ assertEvaluationAgent:jest.fn() }));
jest.mock('../../agents/runtimeProfiles.js',() => ({ getAgentRuntimeAssignment:jest.fn() }));
const agent=jest.mocked(assertEvaluationAgent),assignment=jest.mocked(getAgentRuntimeAssignment);
const context={ tenantKey:'default',workspaceKey:'default' } as EvaluationContext;
beforeEach(() => {
  agent.mockReset();assignment.mockReset();
  agent.mockResolvedValue({ id:1,name:'coder',label:'Coder',runtime_profile_id:2,model:'old-api-model' } as never);
});
describe('evaluation target discovery',() => {
  it.each(['codex','claude-code','hermes'])('shows only the real %s target, blocked until certified',async type => {
    assignment.mockResolvedValue({ profile_id:2,runtime_type:type,profile_label:'Actual runtime',
      model:'actual-model',profile_enabled:true,auth_ref:'protected-reference' } as never);
    const query=jest.fn(async () => ({ rows:[] })),release=jest.fn();
    const targets=await listEvaluationTargets({ connect:async () => ({ query,release }) } as unknown as pg.Pool,1,context);
    expect(targets.agent.default_model).toBe('actual-model');
    expect(targets.targets).toEqual([expect.objectContaining({ id:2,kind:'runtime_profile',
      model_ref:'actual-model',effective_model:'actual-model',selectable:false })]);
    expect(targets.blocker).toMatch(/no verified isolated evaluation mode/);
    expect(JSON.stringify(targets)).not.toMatch(/old-api-model|protected-reference/);
    expect(query.mock.calls).toEqual([['BEGIN'],['ROLLBACK']]);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('does not invent a model for an incomplete or disabled runtime',async () => {
    assignment.mockResolvedValue({ profile_id:2,runtime_type:'codex',model:null,profile_enabled:false } as never);
    const query=jest.fn(async () => ({ rows:[] }));
    const targets=await listEvaluationTargets({ connect:async () => ({ query,release:jest.fn() }) } as unknown as pg.Pool,1,context);
    expect(targets.targets).toEqual([]);expect(targets.blocker).toMatch(/disabled/);
  });
  it('preserves native API target discovery and dependency checks',async () => {
    agent.mockResolvedValue({ id:1,name:'api',model:'alias',runtime_profile_id:null } as never);
    assignment.mockResolvedValue(null);
    const query=jest.fn(async (sql:string) => ({ rows:sql.includes('FROM mcp_models')
      ? [{ id:7,model_name:'alias',upstream_model_name:'effective',enabled:true,provider_enabled:true,aliases:1 }]:[] }));
    const targets=await listEvaluationTargets({ connect:async () => ({ query,release:jest.fn() }) } as unknown as pg.Pool,1,context);
    expect(targets.blocker).toBeNull();expect(targets.targets).toEqual([expect.objectContaining({ kind:'api_model',selectable:true,effective_model:'effective' })]);
  });
});

import { it, expect } from 'vitest';
import { activityRole, logActivityRole, ACTIVITY_LABELS } from './codingActivityRoles';
import { bindCodingActivity } from './codingActivityPresentation';
import type { DistributedTraceRun } from '../types';
const run=(id:string):DistributedTraceRun=>({id,kind:'agent',title:'reviewer',taskType:'review',subtitle:'codex · fixture',status:'completed',startedAt:'2026-09-30T10:00:00Z',endedAt:null,durationMs:null,parentTraceId:null,parentSpanId:null});
it('six Reviewer calls are one generator plan and five environment attempts, never six code reviews',()=>{
  const steps=['generation_plan',...Array(5).fill('stack_environment')];
  const runs=steps.map((_,i)=>run('trace-'+i));
  const bound=bindCodingActivity(runs,steps.map((step,i)=>({step,traceId:'trace-'+i,summary:'Plan ready'})),{});
  expect(bound.map(activityRole)).toEqual(['generator-plan',...Array(5).fill('environment')]);
  expect(bound.filter(x=>activityRole(x)==='review')).toHaveLength(0);
  expect(new Set(bound.map(x=>ACTIVITY_LABELS[activityRole(x)!])).size).toBe(2);
});
it.each([
  ['test_design','qa-design'],['qa_author','qa-tests'],['qa_execute','qa-execution'],
  ['qa_environment_repair','environment-repair'],['reviewer','review'],['code_generation','generator'],
  ['generation_plan','generator-plan'],['code_generation_repair','generator-repair'],
])('bound %s keeps its purpose despite using Reviewer', (step,role)=>{
  expect(activityRole({...run('x'),workflowStepId:step})).toBe(role);expect(logActivityRole(step)).toBe(role);
});
it('unbound and unknown reviewer calls do not invent a code-review phase or verdict',()=>{
  expect(activityRole(run('unknown'))).toBe('agent-task');
  expect(activityRole({...run('unknown'),workflowStepId:'future_helper'})).toBe('agent-task');
});
it('active environment calls and retained deterministic generation remain distinct',()=>{
  const bound=bindCodingActivity([{...run('active'),status:'running'}],[],{currentStage:'stack_environment'});
  expect(activityRole(bound[0]!)).toBe('environment');
  expect(activityRole({...run('retained'),taskType:'generator',title:ACTIVITY_LABELS.generator})).toBe('generator');
});

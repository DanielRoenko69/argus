import type { DistributedTraceRun } from '../types';
export type ActivityRole = 'plan' | 'technical-investigation' | 'knowledge' | 'qa-design' | 'qa-tests' | 'qa-execution'
  | 'code' | 'test' | 'review' | 'environment' | 'environment-repair' | 'generator-plan' | 'generator-repair' | 'generator' | 'agent-task';
export const ACTIVITY_LABELS: Record<ActivityRole,string> = {
  plan:'Plan', 'technical-investigation':'Technical investigation', knowledge:'Knowledge',
  'qa-design':'QA · Test planning', 'qa-tests':'QA · Test authoring', 'qa-execution':'QA · Test execution',
  code:'Coder', test:'Project tests', review:'Code review', environment:'Test environment · Planning & repair',
  'environment-repair':'QA · Dependency repair', 'generator-plan':'Generator planning',
  'generator-repair':'Generator repair', generator:'Client / artifact generation', 'agent-task':'Agent task · Phase unconfirmed',
};
export function logActivityRole(step:string):ActivityRole|null {
  return ({planner:'plan', technical_investigation:'technical-investigation', technical_experiment_review:'technical-investigation',
    knowledge:'knowledge', test_design:'qa-design', qa_author:'qa-tests', qa_environment_repair:'environment-repair', qa_execute:'qa-execution',
    coder:'code', tests:'test', reviewer:'review', research_backlog:'knowledge', decompose_backlog:'plan', review_backlog:'review',
    review_pull_request:'review', stack_environment:'environment', generation_plan:'generator-plan',
    code_generation_repair:'generator-repair', code_generation:'generator'} as Record<string,ActivityRole>)[step]??null;
}
export function activityRole(execution:Pick<DistributedTraceRun,'taskType'|'title'|'workflowStepId'>):ActivityRole|null {
  const bound=execution.workflowStepId&&logActivityRole(execution.workflowStepId);
  if(bound)return bound;
  if(execution.workflowStepId)return 'agent-task'; // Unknown helpers are not code review.
  if(execution.taskType==='qa-tests')return 'qa-tests';
  if(execution.taskType==='qa-execution')return 'qa-execution';
  if(execution.taskType==='qa-design')return 'qa-design';
  // Retained activity carries its already-bound role, not a guessed title.
  if(execution.taskType && execution.taskType in ACTIVITY_LABELS && execution.title===ACTIVITY_LABELS[execution.taskType as ActivityRole]) return execution.taskType as ActivityRole;
  const value=`${execution.taskType??''} ${execution.title}`.toLowerCase();
  if(/(?:plan|planner)/.test(value))return 'plan';
  if(/(?:knowledge|research)/.test(value))return 'knowledge';
  if(/(?:test|verify|verification)/.test(value))return 'test';
  if(/(?:review|critic)/.test(value))return 'agent-task';
  if(/(?:code|coder|implement|fix|remediat)/.test(value))return 'code';
  return null;
}

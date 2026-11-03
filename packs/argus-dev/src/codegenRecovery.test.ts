import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isCodegenImportRecovery } from './codegenRecovery.js';
import { checkpointRetryNode, type RetryState } from './checkpointRetry.js';
export function fixture(): RetryState {
  const summary='[codegen_source_changed] recorded stop';
  return {thread_id:randomUUID(),graph_id:'coding_workflow',status:'interrupted',error:null,next:['requirements_input'],checkpoint_id:randomUUID(),interrupts:[{}],
    metadata:{source:'a2a',execution_principal:'user:3',execution_grant_id:'old'},
    values:{argus_execution_grant:'old',workspace_dir:'/workspace/FIXTURE',argus_workspace_root:'/workspace/FIXTURE',base_commit_sha:'a'.repeat(40),repository_scope_policy:'development-v1',
      qa_acceptance_policy_version:1,qa_environment_policy_version:3,code_generation_policy_version:1,
      qa_artifact:null,qa_receipt:null,stack_result:null,stack_plan:null,plan:'saved',context:'saved',qa_test_plan:'saved',code:'saved',
      log:['setup_workspace','planner','knowledge','test_design','generation_plan','coder','code_generation'].map(step=>({step,traceId:randomUUID(),...(step==='code_generation'?{summary}:{})})),
      workflow_blockers:[summary],qa_history:[{phase:'generation_plan'},{phase:'code_generation_rejected',code:'codegen_source_changed'}]}};
}
test('only the first unapplied source-integrity import can recover before tests/delivery',()=>{
  const s=fixture();assert.ok(isCodegenImportRecovery(s));assert.equal(checkpointRetryNode(s),'code_generation');
  for(const delta of [{code_generation_recovery_count:1},{qa_artifact:{}},{qa_receipt:{}},{stack_result:{}},{stack_plan:{}},
    {code_generation_receipt:{}},{code_generation_failure:{}},{code_generation_repair_count:1},{code_generation_repair_pending:true},
    {qa_environment_policy_version:2},{workflow_blockers:[]},{qa_history:[]},{code:''},{qa_test_plan:''},
    ...['tests_passed','review_passed','retry_count','human_approved','pr_approved','branch_pushed','commit_sha','ci_run','pr_url'].map(k=>({[k]:true}))])
    assert.throws(()=>checkpointRetryNode({...s,values:{...s.values,...delta}}));
  for(const status of ['failed','running','queued','completed','canceled'])assert.throws(()=>checkpointRetryNode({...s,status}));
  assert.throws(()=>checkpointRetryNode({...s,error:'unknown execution'}));
  assert.throws(()=>checkpointRetryNode({...s,metadata:{}}));
});

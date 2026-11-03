import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type pg from 'pg';
import type { ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';
import type { GitOperation } from '../devGitBroker.js';

const events=new Map<string,unknown>();
let row:Record<string,unknown>|undefined;
let failResult=false;
const query=jest.fn(async(sql:string,values:unknown[])=>{
  if(sql.includes('INSERT INTO argus_dev_git_operations')) { row={request_sha256:values[5],principal_id:values[7],status:'started',receipt:null};return{rows:[],rowCount:1}; }
  if(sql.includes('SELECT request_sha256')) return{rows:row?[row]:[]};
  if(sql.includes('UPDATE argus_dev_git_operations')) { row!.status='completed';row!.receipt=JSON.parse(String(values[5]));return{rows:[],rowCount:1}; }
  throw Error('unexpected query');
});
jest.mock('../../audit/canonicalAuditStore.js',()=>({executeCanonicalAuditedMutation:async(_pool:unknown,producer:{eventId:string},_scope:unknown,mutate:(c:unknown)=>Promise<unknown>,eventFor:(v:unknown)=>unknown)=>{
  if(events.has(producer.eventId))return{replayed:true,result:null};
  if(failResult&&producer.eventId.endsWith(':result'))throw Error('audit unavailable');
  const result=await mutate({query});events.set(producer.eventId,eventFor(result));return{replayed:false,result};
}}));
import { executeGitWriteOnce } from '../devGitOperations.js';
const pool={query} as unknown as pg.Pool;
const grant={rootTraceId:'506eadfe-cf34-41da-88e5-110cf3f2b171',principalKind:'user',principalId:'3'} as ExecutionGrantClaims;
const input={reference:{version:1,bundleId:50,backendId:5,binding:'a'.repeat(64)},operation:'pull-request',branch:'feature/D',commitSha:'b'.repeat(40),
  codeApproved:true,testsPassed:true,reviewPassed:true,prApproved:true,ciPassed:true,title:'Title',description:'Private text'} as GitOperation;
const identity={mode:'user-oauth' as const,backendId:5,userId:3};
describe('durable Git write intent contract',()=>{
  beforeEach(()=>{events.clear();row=undefined;failResult=false;query.mockClear();});
  it('commits intent/audit before provider invocation and reuses terminal receipts',async()=>{
    const perform=jest.fn(async()=>{expect(row?.status).toBe('started');expect(events.size).toBe(1);return{ok:true,commitSha:input.commitSha,prUrl:'http://gitea/pulls/1'};});
    const result=await executeGitWriteOnce(pool,grant,input,identity,perform);
    expect(await executeGitWriteOnce(pool,grant,input,identity,perform)).toEqual(result);expect(perform).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...events.values()])).not.toContain('Private text');expect(JSON.stringify(row)).not.toContain('Private text');
  });
  it('never replays an ambiguous provider operation',async()=>{
    const perform=jest.fn(async()=>{throw Error('lost response');});
    await expect(executeGitWriteOnce(pool,grant,input,identity,perform)).rejects.toThrow('lost');
    await expect(executeGitWriteOnce(pool,grant,input,identity,perform)).rejects.toThrow('no terminal receipt');
    expect(perform).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a write when terminal audit fails',async()=>{
    failResult=true;const perform=jest.fn(async()=>({ok:true}));
    await expect(executeGitWriteOnce(pool,grant,input,identity,perform)).rejects.toThrow('audit');
    failResult=false;await expect(executeGitWriteOnce(pool,grant,input,identity,perform)).rejects.toThrow('no terminal receipt');
    expect(perform).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed body for the same branch/commit operation',async()=>{
    const perform=jest.fn(async()=>({ok:true}));await executeGitWriteOnce(pool,grant,input,identity,perform);
    await expect(executeGitWriteOnce(pool,grant,{...input,title:'Changed'},identity,perform)).rejects.toThrow('different frozen request');
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

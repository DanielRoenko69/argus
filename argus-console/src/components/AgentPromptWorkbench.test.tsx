import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { AgentPromptWorkbench } from './AgentPromptWorkbench';
import { PromptReleasePanel } from './PromptReleasePanel';
import type { AgentSummary } from '../types';
const api=vi.hoisted(()=>({ getAgentPromptState:vi.fn(),createAgentPromptRevision:vi.fn(),getPromptReleases:vi.fn(),previewPromptChange:vi.fn(),confirmPromptChange:vi.fn() }));
vi.mock('../api',()=>api);
const source={ agent_id:7,label:'Reviewer',system_prompt:'Active instructions',source_head_sha256:'a'.repeat(64),active_revision_id:null,editable:true,model_ref:'same',revisions:[] };
const draft={ id:3,agent_id:7,title:'Improved',system_prompt:'Improved instructions',source_prompt:source.system_prompt,source_head_sha256:source.source_head_sha256,created_at:new Date().toISOString(),created_by_user_id:2 };
const clients:QueryClient[]=[];
function mount(child:React.ReactNode) { const client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } });clients.push(client);render(<QueryClientProvider client={client}>{child}</QueryClientProvider>); }
beforeEach(()=>{ api.getAgentPromptState.mockResolvedValue(source);api.getPromptReleases.mockResolvedValue({ releases:[] }); });
afterEach(()=>{ cleanup();clients.splice(0).forEach(c=>c.clear());vi.resetAllMocks(); });
describe('prompt workbench and release',()=>{
  it('saves an immutable draft without applying or running it',async()=>{
    const compare=vi.fn();api.createAgentPromptRevision.mockResolvedValue({ revision:draft });
    mount(<AgentPromptWorkbench agents={[{ id:7,label:'Reviewer' } as AgentSummary]} onCompare={compare} />);
    fireEvent.change(screen.getByLabelText('Agent for prompt draft'),{ target:{ value:'7' } });
    fireEvent.click(await screen.findByRole('button',{ name:'New prompt draft' }));
    expect(screen.getByRole('button',{ name:'Save prompt draft' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Candidate system prompt'),{ target:{ value:draft.system_prompt } });
    fireEvent.click(screen.getByRole('button',{ name:'Save prompt draft' }));
    await waitFor(()=>expect(api.createAgentPromptRevision).toHaveBeenCalledWith(expect.objectContaining({ id:7,input:{ title:'Prompt improvement',system_prompt:draft.system_prompt,source_head_sha256:source.source_head_sha256 },requestId:expect.any(String) }),expect.anything()));
    expect(compare).not.toHaveBeenCalled();expect(api.confirmPromptChange).not.toHaveBeenCalled();
    expect(await screen.findByText('Prompt draft saved. The active Agent was not changed.')).toBeInTheDocument();
  });
  it('uses a saved revision with the same Agent/model and blocks stale drafts',async()=>{
    const compare=vi.fn();api.getAgentPromptState.mockResolvedValue({ ...source,revisions:[draft,{ ...draft,id:4,source_head_sha256:'b'.repeat(64) }] });
    mount(<AgentPromptWorkbench agents={[{ id:7,label:'Reviewer' } as AgentSummary]} onCompare={compare} />);
    fireEvent.change(screen.getByLabelText('Agent for prompt draft'),{ target:{ value:'7' } });
    fireEvent.click(await screen.findByRole('button',{ name:'Compare prompt #3' }));
    expect(compare).toHaveBeenCalledWith({ agentId:7,modelRef:'same',revision:draft });
    expect(screen.getByRole('button',{ name:'Compare prompt #4' })).toBeDisabled();
  });
  it('requires reviewed reason, acknowledgement and MFA; preserves ambiguous retry identity',async()=>{
    api.previewPromptChange.mockResolvedValue({ agent_id:7,revision_id:3,before_prompt:source.system_prompt,after_prompt:draft.system_prompt,preview_sha256:'c'.repeat(64),limitation:'System prompt only' });
    api.confirmPromptChange.mockRejectedValue(Object.assign(new Error('Fresh MFA required'),{ code:'MFA_STEP_UP_REQUIRED' }));
    mount(<PromptReleasePanel id={5} passed />);expect(api.confirmPromptChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{ name:'Review prompt release' }));
    const confirm=await screen.findByRole('button',{ name:'Confirm prompt release with MFA' });expect(confirm).toBeDisabled();
    expect(screen.getByText(draft.system_prompt)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Prompt decision reason/),{ target:{ value:'Reviewed same-model passing tests' } });fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(confirm);
    expect(await screen.findByRole('link',{ name:'Confirm MFA and return to comparison' })).toHaveAttribute('href','/auth/oidc/step-up?returnTo=%2Fbuild%2Fevaluations%3Fcomparison%3D5');
    fireEvent.click(confirm);await waitFor(()=>expect(api.confirmPromptChange).toHaveBeenCalledTimes(2));
    expect(api.confirmPromptChange.mock.calls[0][0].requestId).toBe(api.confirmPromptChange.mock.calls[1][0].requestId);
  });
  it('does not offer release for a nonpassing gate',()=>{ mount(<PromptReleasePanel id={5} passed={false} />);expect(screen.getByRole('button',{ name:'Review prompt release' })).toBeDisabled(); });
});

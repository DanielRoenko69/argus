import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { AgentSkillWorkbench } from './AgentSkillWorkbench';
import { SkillReleasePanel } from './SkillReleasePanel';
import type { AgentSummary } from '../types';
const api=vi.hoisted(()=>({ getAgentSkillState:vi.fn(),createAgentSkillRevision:vi.fn(),getSkillReleases:vi.fn(),previewSkillChange:vi.fn(),confirmSkillChange:vi.fn() }));
vi.mock('../api',()=>api);
const active={ id:3,skill_id:2,title:'Catalog',content:'Review carefully',content_sha256:'old',origin:'catalog',source_head_sha256:null,editable:true,created_at:new Date().toISOString() };
const draft={ ...active,id:4,title:'Improved',content:'Return only supported facts',content_sha256:'new',origin:'draft',source_head_sha256:'a'.repeat(64) };
const source={ agent_id:7,label:'Reviewer',source_head_sha256:'a'.repeat(64),model_ref:'same',skills:[{ id:2,name:'review',active,revisions:[active,draft,{ ...draft,id:5,source_head_sha256:'b'.repeat(64) }] }] };
const clients:QueryClient[]=[];
function mount(child:React.ReactNode) { const client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } });clients.push(client);render(<QueryClientProvider client={client}>{child}</QueryClientProvider>); }
beforeEach(()=>{ api.getAgentSkillState.mockResolvedValue(source);api.getSkillReleases.mockResolvedValue({ releases:[] }); });
afterEach(()=>{ cleanup();clients.splice(0).forEach(c=>c.clear());vi.resetAllMocks(); });
describe('Skill workbench',()=>{
  it('saves a source-bound draft without applying or running it',async()=>{
    api.createAgentSkillRevision.mockResolvedValue({ revision:draft });const compare=vi.fn();
    mount(<AgentSkillWorkbench agents={[{ id:7,label:'Reviewer' } as AgentSummary]} onCompare={compare} />);
    fireEvent.change(screen.getByLabelText('Agent for Skill draft'),{ target:{ value:'7' } });
    fireEvent.change(await screen.findByLabelText('Attached Skill'),{ target:{ value:'2' } });
    fireEvent.click(screen.getByRole('button',{ name:'New Skill draft' }));expect(screen.getByRole('button',{ name:'Save Skill draft' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Candidate Skill instructions'),{ target:{ value:draft.content } });
    fireEvent.click(screen.getByRole('button',{ name:'Save Skill draft' }));
    await waitFor(()=>expect(api.createAgentSkillRevision).toHaveBeenCalledWith(expect.objectContaining({ id:7,input:{ skill_id:2,title:'Skill improvement',content:draft.content,source_head_sha256:source.source_head_sha256 } }),expect.anything()));
    expect(compare).not.toHaveBeenCalled();expect(api.confirmSkillChange).not.toHaveBeenCalled();
  });
  it('compares exact versions with the same model and blocks stale or unchanged versions',async()=>{
    const compare=vi.fn();mount(<AgentSkillWorkbench agents={[{ id:7,label:'Reviewer' } as AgentSummary]} onCompare={compare} />);
    fireEvent.change(screen.getByLabelText('Agent for Skill draft'),{ target:{ value:'7' } });fireEvent.change(await screen.findByLabelText('Attached Skill'),{ target:{ value:'2' } });
    expect(screen.getByRole('button',{ name:'Compare Skill #3' })).toBeDisabled();expect(screen.getByRole('button',{ name:'Compare Skill #5' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{ name:'Compare Skill #4' }));expect(compare).toHaveBeenCalledWith({ agentId:7,modelRef:'same',revision:draft,before:active.content });
  });
  it('requires explicit review and retains retry identity after MFA errors',async()=>{
    api.previewSkillChange.mockResolvedValue({ agent_id:7,skill_id:2,revision_id:4,previous_revision_id:3,before_content:active.content,after_content:draft.content,preview_sha256:'c'.repeat(64),limitation:'One Agent only' });
    api.confirmSkillChange.mockRejectedValue(Object.assign(new Error('Fresh MFA required'),{ code:'MFA_STEP_UP_REQUIRED' }));
    mount(<SkillReleasePanel id={5} passed />);fireEvent.click(screen.getByRole('button',{ name:'Review Skill release' }));
    const confirm=await screen.findByRole('button',{ name:'Confirm Skill release with MFA' });expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Skill decision reason/),{ target:{ value:'Reviewed all evidence' } });fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(confirm);
    expect(await screen.findByRole('link',{ name:'Confirm MFA and return to comparison' })).toHaveAttribute('href','/auth/oidc/step-up?returnTo=%2Fbuild%2Fevaluations%3Fcomparison%3D5');
    fireEvent.click(confirm);await waitFor(()=>expect(api.confirmSkillChange).toHaveBeenCalledTimes(2));expect(api.confirmSkillChange.mock.calls[0][0].requestId).toBe(api.confirmSkillChange.mock.calls[1][0].requestId);
  });
  it('disables release without a passing gate',()=>{ mount(<SkillReleasePanel id={5} passed={false} />);expect(screen.getByRole('button',{ name:'Review Skill release' })).toBeDisabled(); });
});

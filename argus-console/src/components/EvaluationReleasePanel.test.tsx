import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { EvaluationReleasePanel } from './EvaluationReleasePanel';
const api=vi.hoisted(()=>({ getExecutionReleases:vi.fn(),previewExecutionChange:vi.fn(),confirmExecutionChange:vi.fn() }));
vi.mock('../api',()=>api);
const preview={ agent_id:9,before_settings:{ model:'A',runtime_profile_id:null },after_settings:{ model:'B',runtime_profile_id:null },preview_sha256:'a'.repeat(64),limitation:'Answer-only, not production certification.' };
const clients:QueryClient[]=[];
function mount(passed=true) { const client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } });clients.push(client);render(<QueryClientProvider client={client}><EvaluationReleasePanel id={2} passed={passed} /></QueryClientProvider>); }
beforeEach(()=>{ api.getExecutionReleases.mockResolvedValue({ releases:[] });api.previewExecutionChange.mockResolvedValue(preview); });
afterEach(()=>{ cleanup();clients.splice(0).forEach(c=>c.clear());vi.resetAllMocks(); });
describe('execution release UI',()=>{
  it('does not promote just because the gate passed; requires preview, reason and explicit acknowledgement',async()=>{
    api.confirmExecutionChange.mockResolvedValue({ release:{ id:1 } });mount();
    expect(api.confirmExecutionChange).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{ name:'Review execution release' }));
    const confirm=await screen.findByRole('button',{ name:'Confirm release with MFA' });expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Decision reason/),{ target:{ value:'Reviewed matching regression cases' } });expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(confirm);
    await waitFor(()=>expect(api.confirmExecutionChange).toHaveBeenCalledWith(expect.objectContaining({ id:2,rollback:false,requestId:expect.any(String),input:{ preview_sha256:preview.preview_sha256,reason:'Reviewed matching regression cases',confirm:true } }),expect.anything()));
    expect(await screen.findByRole('status')).toHaveTextContent('Decision saved');
  });
  it('keeps an ambiguous retry key and shows an MFA return link',async()=>{
    api.confirmExecutionChange.mockRejectedValue(Object.assign(new Error('Fresh MFA required'),{ code:'MFA_STEP_UP_REQUIRED' }));mount();
    fireEvent.click(screen.getByRole('button',{ name:'Review execution release' }));await screen.findByRole('button',{ name:'Confirm release with MFA' });
    fireEvent.change(screen.getByLabelText(/Decision reason/),{ target:{ value:'Reviewed before switching' } });fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button',{ name:'Confirm release with MFA' }));
    expect(await screen.findByRole('link',{ name:'Confirm MFA and return to comparison' })).toHaveAttribute('href','/auth/oidc/step-up?returnTo=%2Fbuild%2Fevaluations%3Fcomparison%3D2');
    fireEvent.click(screen.getByRole('button',{ name:'Confirm release with MFA' }));await waitFor(()=>expect(api.confirmExecutionChange).toHaveBeenCalledTimes(2));
    expect(api.confirmExecutionChange.mock.calls[0][0].requestId).toBe(api.confirmExecutionChange.mock.calls[1][0].requestId);
  });
  it('shows no-op or stale blockers and never offers confirmation',async()=>{
    api.previewExecutionChange.mockRejectedValue(new Error('Nothing to release'));mount();fireEvent.click(screen.getByRole('button',{ name:'Review execution release' }));
    expect(await screen.findByText('Nothing to release')).toBeInTheDocument();expect(screen.queryByRole('button',{ name:'Confirm release with MFA' })).not.toBeInTheDocument();
  });
  it('blocks incomplete gates but preserves rollback history',async()=>{
    api.getExecutionReleases.mockResolvedValue({ releases:[{ id:11,agent_id:9,action:'applied',before_settings:preview.before_settings,after_settings:preview.after_settings,reason:'Approved after review',actor_user_id:7,created_at:new Date().toISOString() }] });mount(false);
    expect(screen.getByRole('button',{ name:'Review execution release' })).toBeDisabled();fireEvent.click(await screen.findByRole('button',{ name:'Review rollback #11' }));
    await waitFor(()=>expect(api.previewExecutionChange).toHaveBeenCalledWith(11,true));expect(await screen.findByRole('button',{ name:'Confirm rollback with MFA' })).toBeDisabled();
  });
});

import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { EvaluationComparisonPanel } from './EvaluationComparisonPanel';
import type { EvaluationComparisonDetail,EvaluationComparison,EvaluationDataset } from '../types';

const api=vi.hoisted(() => Object.fromEntries(['createEvaluationComparison','getEvaluationTargets','preflightEvaluationComparison','getEvaluationDataset','getEvaluationComparisons','getEvaluationComparison','runEvaluationComparison','cancelEvaluationComparison'].map(k => [k,vi.fn()])));
vi.mock('../api',() => api);
const select=vi.fn();
const dataset={ id:1,name:'Fixture',version:1,status:'active',contract_version:1,agent_id:1,case_count:3 } as EvaluationDataset;
const comparison:EvaluationComparison={ id:1,name:'A/B',status:'queued',order_mode:'alternating',repetitions:2,cancel_requested:false,started_at:null,dataset_id:1,created_at:'fixture',plan:[] };
let detail:EvaluationComparisonDetail;
const clients:QueryClient[]=[];
function mount() {
  const client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } }); clients.push(client);
  render(<MemoryRouter><QueryClientProvider client={client}><EvaluationComparisonPanel datasets={[dataset]} agents={[]} onSelectExperiment={select} /></QueryClientProvider></MemoryRouter>);
}
async function choose() { fireEvent.change(await screen.findByLabelText('Saved comparison'),{ target:{ value:'1' } }); }
beforeEach(() => {
  api.getEvaluationDataset.mockResolvedValue({ dataset,cases:[] });
  api.getEvaluationTargets.mockResolvedValue({ agent:{ runtime_label:'Direct API',default_model:'A' },blocker:null,
    targets:['A','B'].map((m,i) => ({ id:i+1,model_ref:m,label:`Model ${m}`,provider_label:'Fake',effective_model:m,selectable:true })) });
  const config={ agent_id:1,agent_name:'Fixture Agent',effective_model:'A',runtime_label:'Direct API',skill_count:0,temperature:0,max_tokens:100 };
  api.preflightEvaluationComparison.mockResolvedValue({ ready:true,comparison_kind:'model',dataset:{ ...dataset,case_count:3 },repetitions:2,planned_requests:12,order_mode:'alternating',
    baseline:config,candidate:{ ...config,effective_model:'B' },differences:['effective_model'],warnings:[],preflight_sha256:'a'.repeat(64) });
  detail={ comparison,records:[{ position:1,round:1,variant:'baseline',experiment_id:10,configuration_sha256:'fixture',
    experiment:{ id:10,status:'queued',model_ref:'A',dataset_id:1,agent_id:1,credential_ref:null,evaluator_config:{},baseline_experiment_id:null,started_at:null,completed_at:null,created_at:'fixture' },results:[] }],
    summary:{ comparison_state:'inconclusive',completed_steps:0,total_steps:4,planned_requests:12,remaining_requests:12,
      cost_coverage:{ measured:0,total:0,known_subtotal_usd:0 },rounds:[],note:'No statistical significance claim.' } };
  api.getEvaluationComparisons.mockResolvedValue({ comparisons:[comparison] });
  api.getEvaluationComparison.mockImplementation(async () => detail);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.resetAllMocks(); });
describe('paired comparison controls',() => {
  it('offers the assigned Codex runtime on both sides and allows same-model comparisons',async () => {
    api.getEvaluationTargets.mockResolvedValue({ agent:{ runtime_type:'codex',runtime_label:'Codex Terra',default_model:'gpt-5.6-terra',reasoning_effort:'xhigh' },blocker:null,
      targets:[{ id:2,kind:'runtime_profile',model_ref:'gpt-5.6-terra',label:'Codex Terra',provider_label:'codex',effective_model:'gpt-5.6-terra',selectable:true }],note:'Uses subscription quota.' });
    mount();fireEvent.click(screen.getByRole('button',{ name:'New paired comparison' }));
    fireEvent.change(screen.getByLabelText('Comparison dataset'),{ target:{ value:'1' } });
    await waitFor(()=>expect(screen.getByLabelText('A · Baseline Runtime model')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('A · Baseline Runtime model'),{ target:{ value:'gpt-5.6-terra' } });
    fireEvent.change(screen.getByLabelText('B · Candidate Runtime model'),{ target:{ value:'gpt-5.6-terra' } });
    expect(screen.getAllByText(/Codex Terra · gpt-5.6-terra · xhigh/)).toHaveLength(2);
    expect(screen.getByRole('button',{ name:'Check comparison' })).not.toBeDisabled();
    expect(api.runEvaluationComparison).not.toHaveBeenCalled();
  });
  it('previews call count and saves both configurations without starting',async () => {
    api.createEvaluationComparison.mockResolvedValue({ comparison });
    mount(); fireEvent.click(screen.getByRole('button',{ name:'New paired comparison' }));
    expect(screen.getByRole('button',{ name:'Check comparison' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Comparison dataset'),{ target:{ value:'1' } });
    await waitFor(() => expect(screen.getByLabelText('A · Baseline API model')).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText('A · Baseline API model'),{ target:{ value:'A' } });
    fireEvent.change(screen.getByLabelText('B · Candidate API model'),{ target:{ value:'B' } });
    fireEvent.change(screen.getByLabelText('Repetitions'),{ target:{ value:'2' } });
    expect(screen.getByText(/12 planned provider requests/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name:'Check comparison' }));
    expect(api.createEvaluationComparison).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button',{ name:'Save comparison' }));
    await waitFor(() => expect(api.createEvaluationComparison).toHaveBeenCalledWith(expect.objectContaining({ requestId:expect.any(String),
      input:expect.objectContaining({ dataset_id:1,repetitions:2,order_mode:'alternating',reviewed_preflight_sha256:'a'.repeat(64),baseline:{ agent_id:1,model_ref:'A' },candidate:{ agent_id:1,model_ref:'B' } }) }),expect.anything()));
    expect(api.runEvaluationComparison).not.toHaveBeenCalled();
  });
  it('explains unsupported runtimes without offering a silent API fallback',async () => {
    api.getEvaluationTargets.mockResolvedValue({ agent:{ runtime_type:'codex',runtime_label:'Subscription runtime',default_model:'runtime-model' },blocker:'No isolated runtime mode',targets:[{ id:2,kind:'runtime_profile',model_ref:'runtime-model',effective_model:'runtime-model',selectable:false }],note:'No subscription or API calls.' });
    mount(); fireEvent.click(screen.getByRole('button',{ name:'New paired comparison' }));
    fireEvent.change(screen.getByLabelText('Comparison dataset'),{ target:{ value:'1' } });
    expect(await screen.findAllByText('No isolated runtime mode')).toHaveLength(2);
    expect(screen.queryByLabelText('A · Baseline API model')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Subscription runtime · runtime-model/)).toHaveLength(2);
    expect(screen.getByRole('button',{ name:'Check comparison' })).toBeDisabled();
    expect(api.preflightEvaluationComparison).not.toHaveBeenCalled();
  });
  it('requires explicit authorization and retains the same key across network errors',async () => {
    api.runEvaluationComparison.mockRejectedValue(new Error('Connection lost'));
    mount(); await choose();
    const button=await screen.findByRole('button',{ name:'Start comparison' }); expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{ name:/I authorize 12 new/ })); fireEvent.click(button);
    await screen.findByText('Connection lost');
    fireEvent.click(button); await waitFor(() => expect(api.runEvaluationComparison).toHaveBeenCalledTimes(2));
    expect(api.runEvaluationComparison.mock.calls[0][0]).toEqual(api.runEvaluationComparison.mock.calls[1][0]);
  });
  it('blocks resume until technical cases were explicitly repaired and opens the child',async () => {
    detail.comparison={ ...detail.comparison,status:'failed' }; detail.records[0].experiment.status='failed';
    mount(); await choose();
    expect(await screen.findByText(/This series needs review/)).toBeInTheDocument();
    expect(screen.queryByRole('button',{ name:'Resume comparison' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name:'Inspect experiment #10' })); expect(select).toHaveBeenCalledWith(10);
    expect(api.runEvaluationComparison).not.toHaveBeenCalled();
  });
  it('does not expose another cancel while cancellation is pending',async () => {
    detail.comparison={ ...detail.comparison,status:'running',cancel_requested:true };
    mount(); await choose();
    expect(await screen.findByRole('button',{ name:'Comparison cancellation requested…' })).toBeDisabled();
    expect(api.cancelEvaluationComparison).not.toHaveBeenCalled();
  });
  it('retains unknown cost coverage and does not present incomplete evidence as passed',async () => {
    detail.summary.cost_coverage={ measured:1,total:2,known_subtotal_usd:0.012 };
    mount(); await choose();
    expect(await screen.findByText(/Cost coverage 1\/2 attempts/)).toHaveTextContent('missing costs are unknown');
    expect(screen.getByText('inconclusive')).toBeInTheDocument();
  });
});

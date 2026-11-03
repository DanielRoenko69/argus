import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { EvaluationPage } from './EvaluationPage';

const api=vi.hoisted(()=>Object.fromEntries([
  'getEvaluationStarterSets','importEvaluationStarterSet',
  'activateEvaluationDataset','addEvaluationCase','createEvaluationDataset','createEvaluationExperiment','getAgents',
  'getEvaluationComparisons','getEvaluationComparison','createEvaluationComparison','runEvaluationComparison','cancelEvaluationComparison',
  'getEvaluationTargets','preflightEvaluationComparison',
  'getLlmCatalog','getEvaluationDataset','getEvaluationDatasets','getEvaluationExperiment','getEvaluationRegression','getEvaluationExperiments','runEvaluationExperiment','cancelEvaluationExperiment','retryEvaluationExperiment',
].map(key=>[key,vi.fn()])));
vi.mock('../api',()=>api);
const dataset={ id:1,dataset_key:'fixture',version:1,name:'Fixture dataset',description:'Synthetic',bundle_ids:[],agent_id:1,status:'draft',case_count:0,content_sha256:null,contract_version:1 };
function mount() {
  const client=new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><EvaluationPage /></QueryClientProvider></MemoryRouter>);
}
beforeEach(()=>{
  api.getEvaluationStarterSets.mockResolvedValue({ starter_sets:[] });
  api.getEvaluationComparisons.mockResolvedValue({ comparisons:[] });
  api.getAgents.mockResolvedValue([]);
  api.getLlmCatalog.mockResolvedValue({ models:[] });
  api.getEvaluationDatasets.mockResolvedValue({ datasets:[dataset] });
  api.getEvaluationDataset.mockResolvedValue({ dataset,cases:[] });
  api.getEvaluationExperiments.mockResolvedValue({ experiments:[] });
  api.getEvaluationRegression.mockResolvedValue({ candidate:{},baseline:null,result:null,reason:'Incomplete' });
});
afterEach(()=>{ cleanup(); vi.resetAllMocks(); });
describe('Evaluation foundation UI',()=>{
  it('explains the execution gate, requires rules and renders mutation errors',async()=>{
    api.addEvaluationCase.mockRejectedValue(new Error('Dataset is immutable'));
    mount();
    expect(await screen.findByText(/At most one model request per case/)).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Case name'),{ target:{ value:'checkout-test' } });
    fireEvent.change(screen.getByLabelText('Task'),{ target:{ value:'Summarize checkout incident' } });
    fireEvent.change(screen.getByLabelText('Expected value 1'),{ target:{ value:'checkout' } });
    fireEvent.click(screen.getByRole('button',{ name:'Add case' }));
    await waitFor(()=>expect(api.addEvaluationCase).toHaveBeenCalledWith(1,expect.objectContaining({ rules:expect.objectContaining({ version:'argus.deterministic.v1' }) })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Dataset is immutable');
  });
  it('labels legacy smoke and never enables an unverified start button',async()=>{
    const legacy={ id:2,dataset_id:1,model_ref:'historical-model',status:'queued',evidence_kind:'legacy_smoke',readiness:{ startable:false,reason:'Historical smoke only',code:'EVALUATION_LEGACY_SMOKE' } };
    api.getEvaluationExperiments.mockResolvedValue({ experiments:[legacy] });
    api.getEvaluationExperiment.mockResolvedValue({ experiment:legacy,results:[] });
    api.getEvaluationRegression.mockResolvedValue({ candidate:{},baseline:null,result:null,reason:'Not a quality comparison' });
    mount();
    expect(await screen.findByText('Legacy smoke · not quality evidence')).toBeInTheDocument();
    expect(screen.getByRole('button',{ name:'Run experiment' })).toBeDisabled();
    expect(api.runEvaluationExperiment).not.toHaveBeenCalled();
  });
  it('offers enabled catalog models and only runs after explicit user action',async()=>{
    api.getLlmCatalog.mockResolvedValue({ models:[{ id:1,modelName:'fixture-api',displayName:'Fixture API',providerLabel:'Local fixture',enabled:true,providerEnabled:true },
      { id:2,modelName:'disabled-api',enabled:false,providerEnabled:true }] });
    const ready={ id:3,dataset_id:1,model_ref:'fixture-api',status:'queued',evidence_kind:'frozen_v1',readiness:{ startable:true,reason:'Isolated API ready' } };
    api.getEvaluationExperiments.mockResolvedValue({ experiments:[ready] });
    api.getEvaluationExperiment.mockResolvedValue({ experiment:ready,results:[{ id:7,case_id:1,status:'passed',scores:{ overall:1 },latency_ms:20,input_tokens:10,output_tokens:null,cost_usd:null }] });
    api.getEvaluationRegression.mockResolvedValue({ candidate:{},baseline:null,result:null,reason:'Missing baseline' });
    api.runEvaluationExperiment.mockResolvedValue({ experiment_id:3,status:'running' });
    mount();
    expect(await screen.findByRole('option',{ name:'Fixture API · Local fixture' })).toBeInTheDocument();
    expect(screen.queryByRole('option',{ name:'disabled-api' })).not.toBeInTheDocument();
    expect(await screen.findByText(/Tokens: 10 in \/ unknown out · Cost: unknown/)).toBeInTheDocument();
    expect(api.runEvaluationExperiment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{ name:'Run experiment' }));
    await waitFor(()=>expect(api.runEvaluationExperiment).toHaveBeenCalledWith(3,expect.anything()));
  });
  it('requires selected cases and cost acknowledgement before retry',async()=>{
    const interrupted={ id:4,dataset_id:1,model_ref:'fixture-api',status:'interrupted',evidence_kind:'frozen_v1',expected_cases:[{ id:2,case_key:'unfinished' }] };
    api.getEvaluationExperiments.mockResolvedValue({ experiments:[interrupted] });
    api.getEvaluationExperiment.mockResolvedValue({ experiment:interrupted,results:[],progress:{ total_cases:2,completed_cases:1,recorded_attempts:1,pending_attempts:1,retryable_case_ids:[2] } });
    api.getEvaluationRegression.mockResolvedValue({ candidate:{},baseline:null,result:null,reason:'Incomplete' });
    api.retryEvaluationExperiment.mockResolvedValue({ experiment_id:4,status:'running' });
    mount();
    const button=await screen.findByRole('button',{ name:'Retry selected cases' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{ name:'unfinished' }));
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox',{ name:/I understand this creates new requests/ }));
    fireEvent.click(button);
    await waitFor(()=>expect(api.retryEvaluationExperiment).toHaveBeenCalledWith(expect.objectContaining({ id:4,caseIds:[2],requestId:expect.any(String) }),expect.anything()));
    expect(api.runEvaluationExperiment).not.toHaveBeenCalled();
  });
  it('shows pending cancellation and does not offer another cancel click',async()=>{
    const running={ id:5,dataset_id:1,model_ref:'fixture',status:'running',evidence_kind:'frozen_v1' };
    api.getEvaluationExperiments.mockResolvedValue({ experiments:[running] });
    api.getEvaluationExperiment.mockResolvedValue({ experiment:running,results:[],cancellation_requested:true });
    mount();
    expect(await screen.findByRole('button',{ name:'Cancellation requested…' })).toBeDisabled();
    expect(api.cancelEvaluationExperiment).not.toHaveBeenCalled();
  });
});

import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { fireEvent,render,screen,cleanup,within } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { currentEvaluationResult,EvaluationAnswerComparison } from './EvaluationAnswerComparison';
import type { EvaluationComparisonDetail } from '../types';
const api=vi.hoisted(() => ({ getEvaluationDataset:vi.fn() }));
vi.mock('../api',() => api);
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const record=(id:number,variant:'baseline'|'candidate',round=1) => ({ position:id,round,variant,experiment_id:id,configuration_sha256:'fixture',
  experiment:{ id,status:'completed',model_ref:variant,configuration_snapshot:{ execution:{ effective_model:`effective-${variant}` } } },
  results:[{ id,case_id:1,attempt:1,status:variant==='baseline' ? 'passed' : 'failed',scores:{ overall:variant==='baseline' ? 1 : 0 },
    output_redacted:variant==='baseline' ? 'checkout down' : '<script>wrong</script>',latency_ms:200,input_tokens:10,output_tokens:null,cost_usd:null,
    trace_id:`trace-${id}`,evidence:{ judgement:{ assertions:[{ index:0,passed:variant==='baseline',reason:'not_matched' }] } } }] });
describe('paired answer evidence',() => {
  it('renders both effective models, criteria, unknown measurements and linked evidence',async () => {
    api.getEvaluationDataset.mockResolvedValue({ cases:[{ id:1,case_key:'outage',input_redacted:'Identify affected service',context_redacted:'checkout is unavailable',expected_output:'Reviewer reference',
      rules:{ assertions:[{ type:'text_includes',value:'checkout' }] } }] });
    const detail={ comparison:{ id:1,dataset_id:1,repetitions:2 },records:[record(1,'baseline'),record(2,'candidate'),record(3,'baseline',2),record(4,'candidate',2)] } as unknown as EvaluationComparisonDetail;
    const client=new QueryClient({ defaultOptions:{ queries:{ retry:false } } });
    render(<QueryClientProvider client={client}><EvaluationAnswerComparison detail={detail} /></QueryClientProvider>);
    const candidate=await screen.findByRole('article',{ name:'B · Candidate answer' });
    expect(within(candidate).getByText(/effective-candidate/)).toBeInTheDocument();
    expect(within(candidate).getByText('<script>wrong</script>')).toBeInTheDocument();
    expect(within(candidate).getByText('Failed')).toBeInTheDocument();
    expect(within(candidate).getByText('Contains "checkout"')).toBeInTheDocument();
    expect(within(candidate).getByText('not matched')).toBeInTheDocument();
    expect(within(candidate).getByRole('link')).toHaveAttribute('href','/observe/logs?trace=trace-2');
    expect(within(candidate).getByText('Unknown')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Comparison round'),{ target:{ value:'2' } });
    expect(within(candidate).getByRole('link')).toHaveAttribute('href','/observe/logs?trace=trace-4');
    client.clear();
  });
  it('never shows an earlier passing result while the newest attempt is unfinished',() => {
    const r={ ...record(1,'baseline'),attempts:[{ case_id:1,attempt:2,status:'pending' }] } as unknown as EvaluationComparisonDetail['records'][number];
    expect(currentEvaluationResult(r,1)).toBeUndefined();
    expect(currentEvaluationResult(undefined,1)).toBeUndefined();
  });
});

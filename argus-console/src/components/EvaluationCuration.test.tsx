import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvaluationStarterSets } from './EvaluationStarterSets';
import { TraceToEvaluationButton } from './TraceToEvaluationButton';

const api=vi.hoisted(() => Object.fromEntries(['getEvaluationStarterSets','importEvaluationStarterSet','getConsoleUser','getEvaluationDatasets','previewEvaluationTrace','addEvaluationCaseFromTrace','createEvaluationDataset'].map(k => [k,vi.fn()])));
vi.mock('../api',() => api);
const trace='11111111-1111-4111-8111-111111111111';
const set={ key:'argus-dev-starter',version:1,name:'Dev starter',description:'Synthetic reference checks',content_sha256:'a'.repeat(64),evidence_kind:'synthetic',cases:[{ caseKey:'dev.ci',input:'Review CI',context:'CI failed',expectedOutput:{ passed:false },rules:{ version:'argus.deterministic.v1',assertions:[{ type:'json_field_equals',path:['passed'],value:false }] },metadata:{ rationale:'Failure is not success.' } }] };
function mount(children:React.ReactNode) { render(<QueryClientProvider client={new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } })}>{children}</QueryClientProvider>); }
beforeEach(() => {
  api.getEvaluationStarterSets.mockResolvedValue({ starter_sets:[set] });
  api.getConsoleUser.mockResolvedValue({ role:'platform_admin' });
  api.getEvaluationDatasets.mockResolvedValue({ datasets:[{ id:3,name:'Draft checks',version:1,status:'draft',contract_version:1 },{ id:4,name:'Frozen checks',status:'active',contract_version:1 }] });
  api.previewEvaluationTrace.mockResolvedValue({ source:{ trace_id:trace,span_id:null },name:'Review',status:'failed',input:'Redacted task',observed_output:'WRONG OBSERVED ANSWER',preview_sha256:'b'.repeat(64),warning:'Redaction is best-effort. Review manually.' });
  api.addEvaluationCaseFromTrace.mockResolvedValue({ case:{ id:7 } });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('evaluation curation',() => {
  it('previews starter criteria and requires review before importing a draft',async() => {
    const select=vi.fn(); api.importEvaluationStarterSet.mockResolvedValue({ dataset:{ id:9 } });
    mount(<EvaluationStarterSets datasets={[]} onSelect={select} />);
    fireEvent.click(await screen.findByRole('button',{ name:'Review Dev starter set' }));
    expect(screen.getByText('dev.ci')).toBeInTheDocument();
    expect(screen.getByRole('button',{ name:'Import 1 cases as draft' })).toBeDisabled();
    expect(api.importEvaluationStarterSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button',{ name:'Import 1 cases as draft' }));
    await waitFor(() => expect(select).toHaveBeenCalledWith(9));
    expect(api.importEvaluationStarterSet).toHaveBeenCalledWith(expect.objectContaining({ key:set.key,digest:set.content_sha256,requestId:expect.any(String) }),expect.anything());
  });
  it('opens an already imported version instead of importing another copy',async() => {
    const select=vi.fn(); mount(<EvaluationStarterSets datasets={[{ id:9,dataset_key:set.key,version:1 } as never]} onSelect={select} />);
    fireEvent.click(await screen.findByRole('button',{ name:'Open imported Dev set' }));
    expect(select).toHaveBeenCalledWith(9); expect(api.importEvaluationStarterSet).not.toHaveBeenCalled();
  });
  it('uses a redacted input, leaves expectations blank, binds provenance and saves only after review',async() => {
    mount(<TraceToEvaluationButton traceId={trace} />);
    fireEvent.click(await screen.findByRole('button',{ name:'Add as test case' }));
    fireEvent.change(await screen.findByLabelText('Destination draft test set'),{ target:{ value:'3' } });
    expect(screen.queryByRole('option',{ name:'Frozen checks' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task')).toHaveValue('Redacted task');
    expect(screen.getByLabelText('Expected answer / reviewer notes (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Reference context (optional)')).toHaveValue('');
    expect(screen.getByRole('button',{ name:'Save reviewed test case' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Expected value 1'),{ target:{ value:'Correct answer' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button',{ name:'Save reviewed test case' }));
    expect(await screen.findByRole('link',{ name:'Open test set' })).toHaveAttribute('href','/build/evaluations?dataset=3');
    const call=api.addEvaluationCaseFromTrace.mock.calls[0][0];
    expect(call).toMatchObject({ datasetId:3,input:{ source:{ trace_id:trace,span_id:null },reviewed:true,reviewed_preview_sha256:'b'.repeat(64) } });
    expect(JSON.stringify(call)).not.toContain('WRONG OBSERVED ANSWER');
  });
  it('keeps form data and the idempotency key on an ambiguous save retry',async() => {
    api.addEvaluationCaseFromTrace.mockRejectedValueOnce(new Error('Connection lost'));
    mount(<TraceToEvaluationButton traceId={trace} spanId="22222222-2222-4222-8222-222222222222" />);
    fireEvent.click(await screen.findByRole('button',{ name:'Add span as test case' }));
    fireEvent.change(await screen.findByLabelText('Destination draft test set'),{ target:{ value:'3' } });
    fireEvent.change(screen.getByLabelText('Expected value 1'),{ target:{ value:'Correct answer' } });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button',{ name:'Save reviewed test case' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
    fireEvent.click(screen.getByRole('button',{ name:'Save reviewed test case' }));
    await screen.findByRole('link',{ name:'Open test set' });
    expect(api.addEvaluationCaseFromTrace.mock.calls[0][0].requestId).toBe(api.addEvaluationCaseFromTrace.mock.calls[1][0].requestId);
  });
  it('does not fetch evidence or offer curation to a viewer',async() => {
    api.getConsoleUser.mockResolvedValue({ role:'viewer' }); mount(<TraceToEvaluationButton traceId={trace} />);
    await waitFor(() => expect(api.getConsoleUser).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(api.previewEvaluationTrace).not.toHaveBeenCalled();
  });
});

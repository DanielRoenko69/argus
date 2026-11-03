import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { fireEvent,render,screen,waitFor,cleanup } from '@testing-library/react';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { EvaluationExportButtons } from './EvaluationExportButtons';
const download=vi.hoisted(() => vi.fn());
vi.mock('../api',() => ({ downloadEvaluationComparison:download }));
const clients:QueryClient[]=[];
function mount(complete=true) { const client=new QueryClient({ defaultOptions:{ mutations:{ retry:false } } });clients.push(client);render(<QueryClientProvider client={client}><EvaluationExportButtons id={12} complete={complete}/></QueryClientProvider>); }
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear());vi.resetAllMocks(); });
describe('evaluation export controls',() => {
  it('does not export incomplete evidence',() => { mount(false);for(const format of ['PDF','JSON','CSV']) expect(screen.getByRole('button',{ name:`Download ${format}` })).toBeDisabled();expect(download).not.toHaveBeenCalled(); });
  it('offers safe MFA return and keeps idempotency key after transport errors',async () => {
    download.mockRejectedValue(Object.assign(new Error('Fresh MFA required'),{ code:'MFA_STEP_UP_REQUIRED' }));mount();
    fireEvent.click(screen.getByRole('button',{ name:'Download JSON' }));
    expect(await screen.findByRole('link',{ name:/Confirm MFA/ })).toHaveAttribute('href','/auth/oidc/step-up?returnTo=%2Fbuild%2Fevaluations%3Fcomparison%3D12');
    fireEvent.click(screen.getByRole('button',{ name:'Download JSON' }));await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(download.mock.calls[0]).toEqual(download.mock.calls[1]);
    fireEvent.click(screen.getByRole('button',{ name:'Download CSV' }));await waitFor(() => expect(download).toHaveBeenCalledTimes(3));
    expect(download.mock.calls[2][2]).not.toBe(download.mock.calls[0][2]);
    fireEvent.click(screen.getByRole('button',{ name:'Download PDF' }));await waitFor(() => expect(download).toHaveBeenCalledTimes(4));
    expect(download.mock.calls[3][1]).toBe('pdf');
    expect(download.mock.calls[3][2]).not.toBe(download.mock.calls[0][2]);
    fireEvent.click(screen.getByRole('button',{ name:'Download PDF' }));await waitFor(() => expect(download).toHaveBeenCalledTimes(5));
    expect(download.mock.calls[4]).toEqual(download.mock.calls[3]);
  });
});

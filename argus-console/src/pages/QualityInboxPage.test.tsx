import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualityInboxPage } from './QualityInboxPage';
import * as api from '../api';
vi.mock('../api',() => ({ getConsoleUser:vi.fn(),getQualityQueue:vi.fn(),getQualityReview:vi.fn(),saveQualityReview:vi.fn() }));
vi.mock('../components/TraceToEvaluationButton',() => ({ TraceToEvaluationButton:({ traceId }:{ traceId:string }) => <button data-trace={traceId}>Add as test case</button> }));
const id='11111111-1111-4111-8111-111111111111';
const item={ trace_id:id,name:'Failed CI review',agent:'Reviewer',model:'Model A',run_status:'failed',status:'open',source_sha256:'a'.repeat(64),signals:{ failed_run:true,human_feedback:1,evaluation_failures:0,evaluation_errors:0 },review:null,review_stale:false,evaluation_experiment_id:null };
const mount=(path='/observe/quality') => render(<QueryClientProvider client={new QueryClient({ defaultOptions:{ queries:{ retry:false },mutations:{ retry:false } } })}><MemoryRouter initialEntries={[path]}><QualityInboxPage /></MemoryRouter></QueryClientProvider>);
beforeEach(() => {
  vi.resetAllMocks();vi.mocked(api.getConsoleUser).mockResolvedValue({ role:'platform_admin' } as never);
  vi.mocked(api.getQualityQueue).mockResolvedValue({ items:[item],window_days:30,candidate_limit:500,possibly_truncated:false } as never);
  vi.mocked(api.getQualityReview).mockResolvedValue({ item,history:[],history_truncated:false } as never);
  vi.mocked(api.saveQualityReview).mockResolvedValue({ review:{ id:1 } } as never);
});
afterEach(cleanup);
describe('Quality Inbox',() => {
  it('shows signals, requires human judgement and saves the exact evidence binding',async () => {
    mount();fireEvent.click(await screen.findByRole('button',{ name:/Failed CI review/ }));
    expect(await screen.findByRole('button',{ name:'Add as test case' })).toHaveAttribute('data-trace',id);
    expect(screen.getByRole('link',{ name:'Open trace and feedback' })).toHaveAttribute('href',`/observe/logs?trace=${id}`);
    expect(screen.getByRole('button',{ name:'Save review' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Verdict'),{ target:{ value:'confirmed_issue' } });
    fireEvent.change(screen.getByLabelText('Reason / next action'),{ target:{ value:'CI failed; add regression coverage.' } });
    fireEvent.click(screen.getByRole('button',{ name:'Save review' }));
    await waitFor(() => expect(api.saveQualityReview).toHaveBeenCalledWith(expect.objectContaining({ traceId:id,input:{ source_sha256:item.source_sha256,previous_review_id:null,status:'reviewed',verdict:'confirmed_issue',note:'CI failed; add regression coverage.' },requestId:expect.any(String) }),expect.anything()));
  });
  it('keeps failed writes visible and uses the same key on an unchanged retry',async () => {
    vi.mocked(api.saveQualityReview).mockRejectedValue(new Error('Evidence changed. Refresh and review again.'));
    mount(`/observe/quality?trace=${id}`);
    fireEvent.change(await screen.findByLabelText('Verdict'),{ target:{ value:'acceptable' } });
    fireEvent.change(screen.getByLabelText('Reason / next action'),{ target:{ value:'False alarm' } });
    fireEvent.click(screen.getByRole('button',{ name:'Save review' }));
    expect(await screen.findByText('Evidence changed. Refresh and review again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{ name:'Save review' }));
    await waitFor(() => expect(api.saveQualityReview).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.saveQualityReview).mock.calls[0][0].requestId).toBe(vi.mocked(api.saveQualityReview).mock.calls[1][0].requestId);
  });
  it('does not fetch privileged data for a viewer',async () => {
    vi.mocked(api.getConsoleUser).mockResolvedValue({ role:'viewer' } as never);mount(`/observe/quality?trace=${id}`);
    expect(await screen.findByText(/Platform admin access is required/)).toBeInTheDocument();
    expect(api.getQualityQueue).not.toHaveBeenCalled();expect(api.getQualityReview).not.toHaveBeenCalled();
    expect(screen.queryByRole('link',{ name:'Quality Inbox' })).not.toBeInTheDocument();
  });
  it('makes truncation and stale review decisions explicit',async () => {
    vi.mocked(api.getQualityQueue).mockResolvedValue({ items:[],possibly_truncated:true } as never);
    vi.mocked(api.getQualityReview).mockResolvedValue({ item:{ ...item,review_stale:true },history:[],history_truncated:false } as never);
    mount(`/observe/quality?trace=${id}`);
    expect(await screen.findByText(/Limit reached/)).toBeInTheDocument();
    expect(await screen.findByText(/Evidence changed since the last review/)).toBeInTheDocument();
  });
});

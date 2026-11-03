import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DevelopmentDecisionCard, developmentInputLabel, readDevelopmentDecision, type DevelopmentDecision } from './DevelopmentDecisionCard';
import type { CodingThreadSummary } from '../types';

afterEach(cleanup);
const decision: DevelopmentDecision = { version: 2, id: 'a'.repeat(64), kind: 'requirement', canClarify: true,
  title: 'Product decision needed', planRevision: 2, round: 1, questions: [{ id: 'q1',
    question: 'Kompatibilität erhalten?', detail: 'The issue leaves compatibility unclear.', evidence: ['issue#6'], recommendedOptionId: 'keep', options: [
      { id: 'keep', label: 'Kompatibel bleiben', consequence: 'Vorhandene Aufrufe funktionieren weiter.' },
      { id: 'new', label: 'Neue Schnittstelle', consequence: 'Aufrufer müssen angepasst werden.' },
    ] }] };
describe('development decision card', () => {
  for (const category of ['format', 'integrity'] as const) it(`separates agent response ${category} errors from technical or product questions`, () => {
    const invalid: DevelopmentDecision = { ...decision, kind: 'technical_review', canClarify: false,
      title: `Agent response ${category} error`, technicalPolicyVersion: 1,
      responseFailure: { phase: 'qa', category, diagnostics: ['testCases.[14].id: invalid_string'] } };
    expect(readDevelopmentDecision(invalid)).toEqual(invalid);
    render(<DevelopmentDecisionCard decision={invalid} pending={false} onSubmit={vi.fn()} />);
    expect(screen.getByText('AGENT RESPONSE ERROR — NO USER INPUT REQUIRED')).toBeVisible();
    expect(screen.getByText(/response-processing problem/)).toBeVisible();
    expect(screen.getByText('Response validation diagnostics')).toBeVisible();
    expect(screen.queryByText(/team assignment/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(readDevelopmentDecision({ ...invalid, canClarify: true })).toBeNull();
    expect(readDevelopmentDecision({ ...invalid, responseFailure: { category: 'unknown' } })).toBeNull();
  });
  it('keeps exhausted technical work out of the product-owner answer form', () => {
    const submit = vi.fn();
    render(<DevelopmentDecisionCard decision={{ ...decision, kind: 'technical_review', canClarify: false,
      title: 'Technical work blocked', technicalPolicyVersion: 1, investigationCount: 1 }} pending={false} onSubmit={submit} />);
    expect(screen.getByText('TECHNICALLY BLOCKED — NO PRODUCT DECISION REQUIRED')).toBeVisible();
    expect(screen.getByText(/Your checkpoint is saved/)).toBeVisible();
    expect(screen.getByText(/Additional technical investigations: 1\/1/)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByText('Technical findings and evidence'));
    expect(screen.getByText('issue#6')).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
  });
  it('preserves the old technical-review input contract for existing checkpoints', () => {
    render(<DevelopmentDecisionCard decision={{ ...decision, kind: 'technical_review' }} pending={false} onSubmit={vi.fn()} />);
    expect(screen.getByRole('textbox')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit answer & re-evaluate' })).toBeDisabled();
  });
  it('shows consequences without preselecting or granting approval and sends version-bound selection', () => {
    const submit = vi.fn();
    render(<DevelopmentDecisionCard decision={decision} pending={false} onSubmit={submit} />);
    expect(screen.getByText('Vorhandene Aufrufe funktionieren weiter.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit answer & re-evaluate' })).toBeDisabled();
    expect(screen.getAllByRole('radio').every(input => !(input as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Kompatibel bleiben/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer & re-evaluate' }));
    expect(submit).toHaveBeenCalledWith({ decisionId: decision.id, requirements: '', answers: { q1: 'keep' } });
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
  it('allows a substantive alternative but not generic yes', () => {
    render(<DevelopmentDecisionCard decision={decision} pending={false} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ja!' } });
    expect(screen.getByRole('button')).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Die vorhandenen Aufrufe sollen funktionieren.' } });
    expect(screen.getByRole('button')).not.toBeDisabled();
  });
  it('does not offer a clarification bypass for access or scope blockers', () => {
    render(<DevelopmentDecisionCard decision={{ ...decision, kind: 'scope', canClarify: false }} pending={false} onSubmit={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    for (const input of screen.getAllByRole('radio')) expect(input).toBeDisabled();
  });
  it('resets answers on question version change and disables dispatch while pending', () => {
    const view = render(<DevelopmentDecisionCard key={decision.id} decision={decision} pending={false} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('radio')[0]!);
    const next = { ...decision, id: 'b'.repeat(64) };
    view.rerender(<DevelopmentDecisionCard key={next.id} decision={next} pending onSubmit={vi.fn()} />);
    expect(screen.getAllByRole('radio').every(input => !(input as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button')).toBeDisabled();
  });
  it('recognizes typed, legacy and canceled input states without calling them approvals', () => {
    const thread: CodingThreadSummary = { thread_id: 'fixture', metadata: {}, created_at: '', updated_at: '',
      status: 'interrupted', next: ['requirements_input'], interrupts: [{ value: { stage: 'requirements_input', decision } }] };
    expect(developmentInputLabel(thread)).toBe('Product decision needed');
    expect(developmentInputLabel({ ...thread, status: 'canceled' })).toBeNull();
    expect(developmentInputLabel({ ...thread, interrupts: [] })).toBe('Clarification needed');
    expect(readDevelopmentDecision({ ...decision, version: 99 })).toBeNull();
    expect(readDevelopmentDecision({ ...decision, questions: [{}] })).toBeNull();
  });
});

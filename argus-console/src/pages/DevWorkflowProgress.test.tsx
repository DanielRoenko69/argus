import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { developmentWorkflow as workflow, workspaceQaEvidence as qaAcceptance } from '../test-fixtures/developmentWorkflow';
import { DevWorkflowProgress, devWorkflowPresentation } from './DevWorkflowProgress';

afterEach(cleanup);
const state = 'TASK_STATE_WORKING';
const evidence = { currentStage: 'planner', qaAcceptance };

describe('compact development workflow', () => {
  it('labels the image-only path as review and image build, not a test phase', () => {
    const imageWorkflow = { ...workflow, id: 'ticket-to-image-pull-request', stages: workflow.stages.filter(stage =>
      ['setup_workspace', 'planner', 'knowledge', 'coder', 'reviewer', 'human_approval', 'finalize_build', 'external_ci', 'human_approval_pr', 'finalize_pr'].includes(stage.id)) };
    const view = devWorkflowPresentation({ workflow: imageWorkflow, evidence: { currentStage: 'reviewer', verificationMode: 'review-only-image' }, state });
    expect(view.phases.map(phase => phase.label)).toContain('Code review');
    expect(view.phases.map(phase => phase.label)).toContain('Jenkins image');
    expect(view.phases.map(phase => phase.label)).not.toContain('Tests & review');
    expect(view.phases.find(phase => phase.id === 'checks')?.hint).toContain('automated tests skipped');
  });
  it('groups the catalog in seven phases, with all applicable technical steps retained', () => {
    const before = JSON.stringify(workflow);
    const view = devWorkflowPresentation({ workflow, evidence, state });
    expect(view.phases.map(phase => phase.label)).toEqual(['Preparation', 'Implementation', 'Tests & review', 'Code approval', 'CI', 'PR approval', 'Pull request']);
    expect([...view.phases.flatMap(phase => phase.stages), ...view.conditional].map(stage => stage.id).sort()).toEqual(workflow.stages.map(stage => stage.id).sort());
    expect(JSON.stringify(workflow)).toBe(before);
  });

  it('keeps the current step visible with technical details initially collapsed', () => {
    render(<DevWorkflowProgress workflow={workflow} evidence={evidence} state={state} />);
    const phases = screen.getByRole('list', { name: 'Workflow phases' });
    expect(within(phases).getAllByRole('listitem')).toHaveLength(7);
    expect(phases.querySelector('[aria-current="step"]')).toHaveTextContent('Preparation');
    expect(screen.getByRole('status')).toHaveTextContent('In progressPreparation · Plan');
    const details = screen.getByText('Technical steps').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Technical steps'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByText('Technical investigation budget')).toBeVisible();
    fireEvent.click(screen.getByText('Technical steps'));
    expect(details).not.toHaveAttribute('open');
  });

  it.each([2, 3])('retains the test environment for policy %s', version => {
    const view = devWorkflowPresentation({ workflow, state, evidence: { ...evidence, qaAcceptance: { ...qaAcceptance, environmentPolicyVersion: version } } });
    expect(view.phases.flatMap(phase => phase.stages).find(stage => stage.id === 'stack_environment')?.hint)
      .toBe(version === 3 ? 'Reusable workspace · per-run services' : 'Automatic isolated stack · opt-in');
  });

  it('omits non-enabled optional steps but never hides the current stage', () => {
    const stages = (currentStage: string) => devWorkflowPresentation({ workflow, state, evidence: { currentStage } }).phases.flatMap(phase => phase.stages).map(stage => stage.id);
    for (const optional of ['qa_author', 'qa_execute', 'stack_environment', 'generation_plan', 'code_generation']) {
      expect(stages('coder')).not.toContain(optional);
    }
    expect(stages('qa_execute')).toContain('qa_execute');
  });

  it.each([
    ['code_generation_repair', 'Implementation', 'Generator repair'],
    ['technical_experiment', 'Preparation', 'Technical experiment'],
    ['qa_environment_repair', 'Tests & review', 'QA environment repair'],
    ['stack_environment_reserve', 'Tests & review', 'Environment repair budget'],
  ])('shows helper %s in its owning phase', (currentStage, phase, label) => {
    render(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage }} state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent(`${phase} · ${label}`);
    expect(screen.getByRole('list', { name: 'Workflow phases' }).querySelector('[aria-current="step"]')).toHaveTextContent(phase);
  });

  it('never treats a requirements interrupt at the end of the catalog as completed phases', () => {
    const { container } = render(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage: 'requirements_input' }} state="TASK_STATE_INPUT_REQUIRED" />);
    expect(screen.getByRole('status')).toHaveTextContent('Input requiredRequirements');
    expect(screen.getByRole('list', { name: 'Workflow phases' }).querySelector('[aria-current]')).toBeNull();
    expect(container.querySelector('.state-complete')).toBeNull();
    expect(container.querySelector('.state-active')).toBeNull();
  });

  it.each(['human_approval', 'human_approval_pr'])('keeps human gate %s distinct from running agents', currentStage => {
    const { container } = render(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage }} state="TASK_STATE_INPUT_REQUIRED" />);
    expect(screen.getByRole('status')).toHaveTextContent('Approval required');
    expect(container.querySelector('.dev-workflow-phases .state-waiting')).toHaveTextContent(currentStage === 'human_approval' ? 'Code approval' : 'PR approval');
    expect(container.querySelector('.state-active')).toBeNull();
  });

  it.each([
    ['TASK_STATE_FAILED', false, 'Failed'], ['TASK_STATE_REJECTED', false, 'Rejected'],
    ['TASK_STATE_CANCELED', false, 'Canceled'], [state, true, 'Cancellation requested'],
  ])('does not show stopped %s as running or passed', (taskState, canceling, label) => {
    const { container } = render(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage: 'reviewer' }} state={taskState} canceling={canceling} />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(container.querySelector('.state-active, .state-complete')).toBeNull();
  });

  it('moves back to Implementation on a coder correction without leaving a green review', () => {
    const { rerender, container } = render(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage: 'reviewer' }} state={state} />);
    rerender(<DevWorkflowProgress workflow={workflow} evidence={{ ...evidence, currentStage: 'coder', retryCount: 2, testsPassed: true, reviewPassed: true }} state={state} />);
    expect(container.querySelector('.dev-workflow-phases [aria-current]')).toHaveTextContent('Implementation');
    expect(container.querySelector('.state-complete')).toBeNull();
  });

  it('does not guess the phase of an unknown or missing current stage', () => {
    const { container, rerender } = render(<DevWorkflowProgress workflow={workflow} evidence={{ currentStage: 'future_node' }} state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent('future_nodeNot mapped');
    expect(container.querySelector('[aria-current]')).toBeNull();
    rerender(<DevWorkflowProgress workflow={workflow} state={state} />);
    expect(screen.getByRole('status')).toHaveTextContent('Stage not reported yet');
    expect(container.querySelector('[aria-current]')).toBeNull();
  });

  it('retains unknown catalog extensions without fabricating extra human gates', () => {
    const custom = { ...workflow, stages: [workflow.stages[0]!, { id: 'security_scan', label: 'Security scan', hint: 'Extra policy', kind: 'test' as const }] };
    const view = devWorkflowPresentation({ workflow: custom, state, evidence: { currentStage: 'security_scan' } });
    expect(view.phases.map(phase => phase.label)).toEqual(['Preparation', 'Security scan']);
    expect(view.currentLabel).toBe('Security scan');
  });

  it('marks a completed run at phase level, not optional steps as executed', () => {
    const { container } = render(<DevWorkflowProgress workflow={workflow} evidence={evidence} state="TASK_STATE_COMPLETED" />);
    expect(screen.getByRole('status')).toHaveTextContent('Completed');
    expect(container.querySelectorAll('.dev-workflow-phases .state-complete')).toHaveLength(7);
    expect(container.querySelectorAll('.dev-workflow-steps .state-complete, [aria-current]')).toHaveLength(0);
  });
});

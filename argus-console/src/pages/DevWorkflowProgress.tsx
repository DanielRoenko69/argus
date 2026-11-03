import { Check, Code2, GitPullRequest, Layers, ShieldCheck, TestTube2, Workflow } from 'lucide-react';
import type { SolutionPackCodingEvidence, SolutionPackWorkflowDefinition, SolutionPackWorkflowStage } from '../types';

const PHASES = [
  { id: 'preparation', label: 'Preparation', hint: 'Workspace · Plan · Knowledge · QA design', icon: Workflow,
    steps: ['setup_workspace', 'planner', 'knowledge', 'test_design', 'design_refinement', 'technical_resolution', 'technical_investigation'] },
  { id: 'implementation', label: 'Implementation', hint: 'Coder · Repository generation', icon: Code2,
    steps: ['generation_plan', 'coder', 'code_generation'] },
  { id: 'checks', label: 'Tests & review', hint: 'Environment · Tests · QA · Reviewer', icon: TestTube2,
    steps: ['stack_environment', 'tests', 'qa_author', 'qa_execute', 'reviewer'] },
  { id: 'code-approval', label: 'Code approval', hint: 'Human decision', icon: ShieldCheck, steps: ['human_approval'] },
  { id: 'ci', label: 'CI', hint: 'Branch & push · Provider checks', icon: Layers, steps: ['finalize_build', 'external_ci'] },
  { id: 'pr-approval', label: 'PR approval', hint: 'Human decision', icon: ShieldCheck, steps: ['human_approval_pr'] },
  { id: 'pr', label: 'Pull request', hint: 'Delivery evidence', icon: GitPullRequest, steps: ['finalize_pr'] },
] as const;

// Runtime-only helper nodes are not always listed in older Pack catalogs. Show
// the exact active helper, without claiming the parent step has already passed.
const HELPERS: Record<string, { parent: string; label: string }> = {
  technical_experiment: { parent: 'technical_investigation', label: 'Technical experiment' },
  technical_experiment_review: { parent: 'technical_investigation', label: 'Experiment review' },
  code_generation_repair_reserve: { parent: 'code_generation', label: 'Generator repair budget' },
  code_generation_repair: { parent: 'code_generation', label: 'Generator repair' },
  stack_environment_reserve: { parent: 'stack_environment', label: 'Environment repair budget' },
  qa_environment_reserve: { parent: 'qa_author', label: 'QA environment repair budget' },
  qa_environment_repair: { parent: 'qa_author', label: 'QA environment repair' },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function devWorkflowPresentation(input: {
  workflow: SolutionPackWorkflowDefinition;
  evidence?: Partial<SolutionPackCodingEvidence>;
  state?: string;
  canceling?: boolean;
}) {
  const { workflow, evidence = {}, state, canceling } = input;
  const current = evidence.currentStage ?? '';
  const helper = HELPERS[current];
  const currentParent = helper?.parent ?? current;
  const qa = record(evidence.qaAcceptance);
  const stages = workflow.stages.filter(stage => {
    // A known current step must remain visible even if older evidence lacks its policy.
    if (stage.id === currentParent || state === undefined) return true;
    if (['qa_author', 'qa_execute'].includes(stage.id)) return Boolean(evidence.qaAcceptance);
    if (stage.id === 'stack_environment') return [2, 3].includes(Number(qa.environmentPolicyVersion));
    if (['generation_plan', 'code_generation'].includes(stage.id)) return Boolean(qa.codeGeneration);
    return true;
  }).map(stage => stage.id === 'stack_environment' && qa.environmentPolicyVersion === 3
    ? { ...stage, hint: 'Reusable workspace · per-run services' } : stage);
  const completed = state === 'TASK_STATE_COMPLETED';
  const knownCurrent = stages.find(stage => stage.id === currentParent);
  const currentLabel = helper?.label ?? knownCurrent?.label ?? (current && current !== 'starting' ? current : 'Stage not reported yet');
  const status = completed ? 'Completed'
    : state === 'TASK_STATE_CANCELED' ? 'Canceled'
      : state === 'TASK_STATE_FAILED' ? 'Failed'
        : state === 'TASK_STATE_REJECTED' ? 'Rejected'
          : canceling ? 'Cancellation requested'
            : state === 'TASK_STATE_INPUT_REQUIRED' ? (knownCurrent?.kind === 'approval' ? 'Approval required' : 'Input required')
              : ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(state ?? '') ? 'In progress'
                : state ? 'Status unavailable' : 'Workflow overview';
  const tone = completed ? 'complete'
    : ['TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(state ?? '') ? 'failed'
      : state === 'TASK_STATE_CANCELED' || canceling ? 'stopped'
        : state === 'TASK_STATE_INPUT_REQUIRED' ? 'waiting'
          : status === 'In progress' ? 'active' : 'neutral';
  const conditional: SolutionPackWorkflowStage[] = [];
  const phases: Array<{ id: string; label: string; hint: string; icon: typeof Workflow; stages: SolutionPackWorkflowStage[] }> = [];
  for (const stage of stages) {
    // Clarification may interrupt any phase. Its catalog position is not progress.
    if (stage.id === 'requirements_input') { conditional.push(stage); continue; }
    const definition = PHASES.find(phase => (phase.steps as readonly string[]).includes(stage.id));
    // Unknown catalog extensions are kept, not silently hidden or called complete.
    const id = definition?.id ?? `stage:${stage.id}`;
    let phase = phases.find(item => item.id === id);
    if (!phase) {
      phase = { id, label: definition?.label ?? stage.label, hint: definition?.hint ?? stage.hint,
        icon: definition?.icon ?? Workflow, stages: [] };
      if (['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id) && id === 'checks') {
        phase.label = 'Code review';
        phase.hint = 'Requirements & diff · automated tests skipped';
        phase.icon = ShieldCheck;
      }
      if (['ticket-to-image-pull-request', 'ticket-follow-up-image-pull-request'].includes(workflow.id) && id === 'ci') {
        phase.label = 'Jenkins image';
        phase.hint = 'Pinned commit · build-only image receipt';
      }
      phases.push(phase);
    }
    phase.stages.push(stage);
  }
  return { phases, conditional, current: currentParent, currentLabel, helperLabel: helper?.label,
    status, tone, completed, hasTask: state !== undefined,
    unmapped: Boolean(current && current !== 'starting' && current !== 'completed' && !knownCurrent) };
}

export function DevWorkflowProgress(props: Parameters<typeof devWorkflowPresentation>[0]) {
  const view = devWorkflowPresentation(props);
  const currentPhase = view.phases.find(phase => phase.stages.some(stage => stage.id === view.current));
  return (
    <section className="dev-workflow-progress" aria-label={`${props.workflow.label} workflow`}>
      {view.hasTask && <p className={`dev-workflow-current state-${view.tone}`} role="status">
        <strong>{view.status}</strong>
        {!view.completed && <span>{currentPhase && `${currentPhase.label} · `}{view.currentLabel}</span>}
        {view.unmapped && <small>Not mapped in the current workflow catalog.</small>}
      </p>}
      <ol className="dev-workflow-phases" aria-label="Workflow phases">
        {view.phases.map((phase, index) => {
          const isCurrent = !view.completed && phase.id === currentPhase?.id;
          const Icon = view.completed ? Check : phase.icon;
          return <li key={phase.id} className={view.completed ? 'state-complete' : isCurrent ? `state-${view.tone}` : ''}
            aria-current={isCurrent ? 'step' : undefined}>
            <span className="dev-workflow-phase-icon" aria-hidden="true"><Icon size={17} /></span>
            <div><small>PHASE {index + 1}</small><b>{phase.label}</b>
              <span>{isCurrent ? view.currentLabel : phase.hint}</span></div>
          </li>;
        })}
      </ol>
      <details className="dev-workflow-steps" key={props.workflow.id}>
        <summary>Technical steps <small>Agents, tools & human gates</small></summary>
        <p>Workflow structure, not an execution checklist. Conditional steps may be skipped; attempts and results remain in Workflow activity below.</p>
        <div className="dev-workflow-step-groups">
          {[...view.phases, ...(view.conditional.length ? [{ id: 'conditional', label: 'Conditional input', stages: view.conditional }] : [])].map(phase => (
            <section key={phase.id} aria-label={`${phase.label} steps`}><h4>{phase.label}</h4><ol>
              {phase.stages.map(stage => {
                const isCurrent = !view.completed && stage.id === view.current;
                return <li key={stage.id} aria-current={isCurrent ? 'step' : undefined}>
                  <b>{stage.label}</b><span>{stage.hint}</span>
                  {isCurrent && <em>{view.status}{view.helperLabel && ` · ${view.helperLabel}`}</em>}
                </li>;
              })}
            </ol></section>
          ))}
        </div>
      </details>
    </section>
  );
}

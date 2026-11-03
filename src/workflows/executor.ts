/**
 * Workflow Executor — DAG-based execution engine.
 *
 * 1. Build dependency graph from step.depends_on
 * 2. Topological sort → group by depth level
 * 3. Execute each level: independent steps run in parallel (Promise.all)
 * 4. Template variables in args: {{input.x}}, {{steps.y.result}}, {{steps.y.status}}
 * 5. Condition evaluation before each step
 * 6. Error handling per on_error strategy
 */

import type {
  WorkflowRow, WorkflowStep, ExecutionContext,
  StepResult, StepStatus, WorkflowStatus, ToolRunner, StepCredOverride,
} from './types.js';
import { evaluateCondition } from './conditionParser.js';
import {
  AGENT_OUTPUT_CONTRACT_ARG,
  AgentOutputContractError,
  agentOutputContractInstruction,
  isAgentOutputContractName,
  parseAgentOutputContract,
} from './agentOutputContracts.js';
import { logger } from '../lib/logger.js';
import {
  finishTelemetrySpan,
  finishTelemetryTrace,
  getNativeTelemetryContext,
  startTelemetrySpan,
  startTelemetryTrace,
  withNativeTelemetryContext,
  workflowTelemetryTraceId,
  type TelemetryHandle,
  type TelemetrySpanKind,
} from '../observability/telemetryStore.js';
import { findInlineWorkflowCredentials } from './inlineCredentialPolicy.js';
import {
  ForEachExecutionError,
  normalizeDataResult,
  parseForEachItems,
  parseTableRows,
  parseVariables,
  runControlledFunction,
  runForEach,
} from './dataTransforms.js';

/**
 * Optional step-execution event callback — used by the visual builder's
 * SSE stream to surface live status (started → completed/failed).
 */
export type StepEventKind = 'started' | 'waiting' | 'completed' | 'failed' | 'skipped';
export interface StepEvent {
  kind: StepEventKind;
  stepId: string;
  ts: number;
  result?: StepResult;
}
export type StepEventListener = (ev: StepEvent) => void;

/**
 * Extra step runners for non-tool step types. The visual builder injects
 * them; the legacy code path passes only toolRunner and gets backward-
 * compatible behavior (everything resolves to `argus.tool`).
 */
export interface StepRunners {
  agentRunner?: (agentId: number, prompt: string, args: Record<string, unknown>) => Promise<string>;
  skillRunner?: (skillId: number, args: Record<string, unknown>) => Promise<string>;
  ragRunner?: (indexName: string, query: string, topK: number) => Promise<string>;
  memoryRunner?: (op: string, args: Record<string, unknown>) => Promise<string>;
  /** Persist and resolve an explicit visual human-approval gate. */
  approvalRunner?: (request: {
    workflowId: number;
    executionId: number;
    stepId: string;
    message: string;
  }) => Promise<{
    decision: 'allow' | 'pending' | 'rejected';
    requestId: number;
    comment?: string | null;
  }>;
  /** Invoke another workflow synchronously and retain its persisted execution evidence. */
  subWorkflowRunner?: (
    targetId: number,
    inputs: Record<string, unknown>,
    invocation?: SubWorkflowInvocationContext,
  ) => Promise<string | SubWorkflowRunResult>;
}

export interface SubWorkflowInvocationContext {
  parentWorkflowId: number;
  parentExecutionId: number;
  parentStepId: string;
  itemIndex?: number;
  /** Failed child execution this governed recovery attempt derives from. */
  retryOfExecutionId?: number;
  /** Internal lifecycle hook used to expose the persisted run before it settles. */
  onExecutionCreated?: (evidence: SubWorkflowExecutionEvidence) => void;
}

export interface SubWorkflowExecutionEvidence {
  workflow_id: number;
  execution_id: number;
  trace_id: string;
  root_trace_id: string;
  status: WorkflowStatus;
}

export interface SubWorkflowRunResult {
  output: unknown;
  evidence: SubWorkflowExecutionEvidence;
}

export class SubWorkflowExecutionError extends Error {
  constructor(message: string, public readonly evidence: SubWorkflowExecutionEvidence) {
    super(message);
    this.name = 'SubWorkflowExecutionError';
  }
}

/** Max recursion depth for sub-workflow execution (cycle-safety net). */
export const MAX_SUBWORKFLOW_DEPTH = 5;

/**
 * Resolves a step's cred_ref → token, server-side. Returns null when the step
 * has no cred_ref or the ref resolves to no creds. Wired by the route layer
 * (which holds the pool + RBAC context). The executor itself stays DB-agnostic.
 */
export type StepCredResolver = (step: WorkflowStep) => Promise<StepCredOverride | null>;

export interface ExecuteWorkflowOptions {
  workflow: WorkflowRow;
  inputs: Record<string, unknown>;
  toolRunner: ToolRunner;
  runners?: StepRunners;
  executionId: number;
  triggeredBy: string | null;
  telemetryUserId?: number | null;
  onStepEvent?: StepEventListener;
  /** Optional cred_ref → token resolver. Absent → default service creds. */
  credResolver?: StepCredResolver;
  /** Completed/failed/waiting results restored from a persisted checkpoint. */
  initialStepResults?: Record<string, StepResult>;
}

export interface ExecuteWorkflowResult {
  status: WorkflowStatus;
  stepResults: Record<string, StepResult>;
  error?: string;
  durationMs: number;
  approvalRequestId?: number;
  waitingStepId?: string;
}

export class WorkflowApprovalRequiredError extends Error {
  constructor(
    public readonly approvalRequestId: number,
    public readonly stepId: string,
  ) {
    super(`Workflow is waiting for runtime approval #${approvalRequestId} at step '${stepId}'`);
    this.name = 'WorkflowApprovalRequiredError';
  }
}

/** Main entry point */
export async function executeWorkflow(opts: ExecuteWorkflowOptions): Promise<ExecuteWorkflowResult> {
  const {
    workflow, inputs, toolRunner, runners, executionId,
    onStepEvent, credResolver, initialStepResults = {},
  } = opts;
  const inlineCredentials = findInlineWorkflowCredentials(workflow.steps, [], workflow.input_params);
  if (inlineCredentials.length > 0) {
    throw new Error(`Workflow credential policy blocked execution: ${inlineCredentials.map(issue => issue.issue).join('; ')}`);
  }
  const startTime = Date.now();
  const resumedInputs = { ...inputs };
  const parentTelemetryContext = getNativeTelemetryContext();
  const tenantKey = workflow.tenant_key ?? parentTelemetryContext?.tenantKey ?? 'default';
  const workspaceKey = workflow.workspace_key ?? parentTelemetryContext?.workspaceKey ?? 'default';
  const telemetryTrace = startTelemetryTrace({
    id: workflowTelemetryTraceId(executionId),
    name: `workflow.${workflow.name}`,
    kind: 'workflow',
    workflowExecutionId: executionId,
    tenantKey,
    workspaceKey,
    userId: opts.telemetryUserId,
    input: inputs,
    metadata: {
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      triggered_by: opts.triggeredBy,
      tenantKey,
      workspaceKey,
      parent_kind: parentTelemetryContext?.agentId ? 'agent' : parentTelemetryContext?.workflowId ? 'workflow' : null,
    },
  });
  const telemetryStepSpans = new Map<string, TelemetryHandle>();

  const startStepSpan = (step: WorkflowStep): TelemetryHandle => {
    const stepType = step.type ?? 'argus.tool';
    const spanKind: TelemetrySpanKind = stepType === 'argus.tool' || stepType === 'tool'
      ? 'tool'
      : stepType === 'argus.knowledge'
        ? 'rag'
        : 'workflow';
    return startTelemetrySpan({
      traceId: telemetryTrace.id,
      name: `workflow.step.${step.id}`,
      kind: spanKind,
      toolName: spanKind === 'tool' ? step.tool ?? null : null,
      tenantKey,
      workspaceKey,
      input: step.args ?? {},
      metadata: {
        step_id: step.id,
        step_type: stepType,
        label: step.label ?? step.id,
        agent_id: step.agent_id ?? null,
        skill_id: step.skill_id ?? null,
        knowledge_index: stepType === 'argus.knowledge' ? step.args?.['index_name'] ?? null : null,
        target_workflow_id: stepType === 'argus.workflow' || (
          stepType === 'logic.for_each' && step.args?.['mode'] === 'subworkflow'
        )
          ? step.args?.['target_workflow_id'] ?? null
          : null,
        for_each_mode: stepType === 'logic.for_each' ? step.args?.['mode'] ?? 'transform' : null,
        for_each_concurrency: stepType === 'logic.for_each' ? step.args?.['concurrency'] ?? 4 : null,
      },
    });
  };

  const tracedStepEvent = (event: StepEvent): void => {
    const step = workflow.steps.find(candidate => candidate.id === event.stepId);
    if (!step) {
      onStepEvent?.(event);
      return;
    }
    let span = telemetryStepSpans.get(event.stepId);
    if (event.kind === 'started' || !span) {
      span ??= startStepSpan(step);
      telemetryStepSpans.set(event.stepId, span);
    }
    if (event.kind !== 'started') {
      finishTelemetrySpan(span, {
        status: event.kind === 'failed'
          ? 'failed'
          : event.kind === 'waiting'
            ? 'waiting'
            : 'completed',
        output: event.result?.result,
        error: event.result?.error,
        metadata: { outcome: event.kind },
      });
      telemetryStepSpans.delete(event.stepId);
    }
    onStepEvent?.(event);
  };

  const context: ExecutionContext = {
    workflowId: workflow.id,
    executionId,
    input: resumedInputs,
    steps: new Map(Object.entries(initialStepResults)),
    inactiveBranchTargets: new Set<string>(),
  };
  restoreCheckpointVariables(workflow.steps, context);

  try {
    const plan = buildExecutionPlan(workflow.steps);
    logger.info({
      workflowId: workflow.id,
      workflowExecutionId: executionId,
      rootTraceId: telemetryTrace.rootTraceId,
      traceId: telemetryTrace.id,
      steps: workflow.steps.length,
      depth: plan.length,
      tenantKey,
      workspaceKey,
    }, 'Starting workflow');

    for (const group of plan) {
      // Execute steps in parallel within each depth group
      const results = await Promise.allSettled(
        group.map(stepId => {
          const step = workflow.steps.find(s => s.id === stepId)!;
          const previous = context.steps.get(step.id);
          if (previous && previous.status !== 'waiting') {
            return executeStep(step, context, toolRunner, runners, tracedStepEvent, credResolver);
          }
          const span = startStepSpan(step);
          telemetryStepSpans.set(step.id, span);
          return withNativeTelemetryContext({
            rootTraceId: telemetryTrace.rootTraceId,
            traceId: telemetryTrace.id,
            spanId: span.id,
            userId: opts.telemetryUserId ?? parentTelemetryContext?.userId ?? null,
            agentRole: step.agent_role ?? null,
            workflowStepId: step.id,
            workflowId: workflow.id,
            workflowExecutionId: executionId,
            tenantKey,
            workspaceKey,
          }, () => executeStep(step, context, toolRunner, runners, tracedStepEvent, credResolver));
        }),
      );

      // Check for stop-on-error
      let waitingError: WorkflowApprovalRequiredError | null = null;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const stepId = group[i];
        if (r.status === 'rejected') {
          if (r.reason instanceof WorkflowApprovalRequiredError) {
            waitingError ??= r.reason;
            continue;
          }
          // Unhandled rejection — step threw with 'stop' strategy
          const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
          if (!context.steps.has(stepId)) {
            context.steps.set(stepId, { status: 'failed', error: err, duration_ms: 0 });
          }
          throw new Error(`Step '${stepId}' failed: ${err}`);
        }
      }
      if (waitingError) throw waitingError;

      // Check if any step with 'skip_dependents' failed → mark dependents as skipped
      for (const stepId of group) {
        const sr = context.steps.get(stepId);
        if (sr && sr.status === 'failed') {
          const step = workflow.steps.find(s => s.id === stepId)!;
          if (step.on_error === 'skip_dependents') {
            markDependentsSkipped(stepId, workflow.steps, context);
          }
        }
      }
    }

    logger.info({
      workflowExecutionId: executionId,
      rootTraceId: telemetryTrace.rootTraceId,
      traceId: telemetryTrace.id,
      durationMs: Date.now() - startTime,
      tenantKey,
      workspaceKey,
    }, 'Workflow completed');
    const completedResult: ExecuteWorkflowResult = {
      status: 'completed',
      stepResults: Object.fromEntries(context.steps),
      durationMs: Date.now() - startTime,
    };
    finishTelemetryTrace(telemetryTrace, {
      status: 'completed',
      output: completedResult.stepResults,
      metadata: { step_count: context.steps.size },
    });
    return completedResult;
  } catch (err) {
    if (err instanceof WorkflowApprovalRequiredError) {
      logger.info(
        {
          workflowExecutionId: executionId,
          rootTraceId: telemetryTrace.rootTraceId,
          traceId: telemetryTrace.id,
          approvalRequestId: err.approvalRequestId,
          stepId: err.stepId,
          tenantKey,
          workspaceKey,
        },
        'Workflow paused for runtime approval',
      );
      const waitingResult: ExecuteWorkflowResult = {
        status: 'waiting_for_approval',
        stepResults: Object.fromEntries(context.steps),
        error: err.message,
        durationMs: Date.now() - startTime,
        approvalRequestId: err.approvalRequestId,
        waitingStepId: err.stepId,
      };
      finishTelemetryTrace(telemetryTrace, {
        status: 'waiting',
        output: waitingResult.stepResults,
        error: err.message,
        metadata: {
          approval_request_id: err.approvalRequestId,
          waiting_step_id: err.stepId,
          step_count: context.steps.size,
        },
      });
      return waitingResult;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({
      err,
      workflowExecutionId: executionId,
      rootTraceId: telemetryTrace.rootTraceId,
      traceId: telemetryTrace.id,
      tenantKey,
      workspaceKey,
    }, 'Workflow failed');
    const failedResult: ExecuteWorkflowResult = {
      status: 'failed',
      stepResults: Object.fromEntries(context.steps),
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
    finishTelemetryTrace(telemetryTrace, {
      status: 'failed',
      output: failedResult.stepResults,
      error: errorMessage,
      metadata: { step_count: context.steps.size },
    });
    return failedResult;
  }
}

/* ── DAG / Topological Sort ────────────────────────────────── */

/**
 * Build execution plan: array of step-ID groups by depth level.
 * Steps within a group can run in parallel.
 */
function buildExecutionPlan(steps: WorkflowStep[]): string[][] {
  const allIds = new Set(steps.map(s => s.id));
  const dependencyCount = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // stepId → list of steps that depend on it

  for (const step of steps) {
    dependencyCount.set(step.id, 0);
    dependents.set(step.id, []);
  }

  for (const step of steps) {
    const deps = (step.depends_on ?? []).filter(d => allIds.has(d));
    dependencyCount.set(step.id, deps.length);
    for (const depId of deps) {
      dependents.get(depId)!.push(step.id);
    }
  }

  const plan: string[][] = [];
  const queue: string[] = [];

  // Start with steps that have no dependencies
  for (const [id, count] of dependencyCount) {
    if (count === 0) queue.push(id);
  }

  while (queue.length > 0) {
    plan.push([...queue]);
    const nextQueue: string[] = [];

    for (const stepId of queue) {
      for (const dep of dependents.get(stepId) ?? []) {
        const newCount = dependencyCount.get(dep)! - 1;
        dependencyCount.set(dep, newCount);
        if (newCount === 0) nextQueue.push(dep);
      }
    }

    queue.length = 0;
    queue.push(...nextQueue);
  }

  // Cycle detection
  const planned = new Set(plan.flat());
  if (planned.size !== steps.length) {
    const missing = steps.filter(s => !planned.has(s.id)).map(s => s.id);
    throw new Error(`Circular dependency detected involving steps: ${missing.join(', ')}`);
  }

  return plan;
}

/* ── Step Execution ────────────────────────────────────────── */

async function executeStep(
  step: WorkflowStep,
  context: ExecutionContext,
  toolRunner: ToolRunner,
  runners?: StepRunners,
  onEvent?: StepEventListener,
  credResolver?: StepCredResolver,
): Promise<void> {
  const stepStart = Date.now();

  // Checkpoint resume: completed/skipped/handled-failure steps are terminal and
  // must never run twice. Only the waiting step is retried after approval.
  const previous = context.steps.get(step.id);
  if (previous && previous.status !== 'waiting') {
    if (previous.status === 'skipped') {
      onEvent?.({ kind: 'skipped', stepId: step.id, ts: stepStart, result: previous });
    }
    return;
  }
  if (previous?.status === 'waiting') context.steps.delete(step.id);

  const dependencies = step.depends_on ?? [];
  const inactiveBranch = context.inactiveBranchTargets?.has(step.id) === true;
  const allDependenciesSkipped = dependencies.length > 0
    && dependencies.every(dependency => context.steps.get(dependency)?.status === 'skipped');
  if (inactiveBranch || allDependenciesSkipped) {
    const sr: StepResult = {
      status: 'skipped',
      result: inactiveBranch ? 'branch not selected' : 'all dependencies skipped',
      duration_ms: Date.now() - stepStart,
      started_at: new Date(stepStart).toISOString(),
      completed_at: new Date().toISOString(),
    };
    context.steps.set(step.id, sr);
    onEvent?.({ kind: 'skipped', stepId: step.id, ts: Date.now(), result: sr });
    return;
  }

  // A logic.condition owns its expression and uses it to select a target.
  // Conditions on all other step types remain ordinary execution guards.
  if (step.condition && step.type !== 'logic.condition') {
    try {
      const conditionMet = evaluateCondition(step.condition, context);
      if (!conditionMet) {
        const sr: StepResult = {
          status: 'skipped',
          duration_ms: Date.now() - stepStart,
          started_at: new Date(stepStart).toISOString(),
          completed_at: new Date().toISOString(),
        };
        context.steps.set(step.id, sr);
        onEvent?.({ kind: 'skipped', stepId: step.id, ts: Date.now(), result: sr });
        logger.debug({ stepId: step.id, condition: step.condition }, 'Step skipped (condition false)');
        return;
      }
    } catch (err) {
      const msg = `Condition evaluation failed: ${err instanceof Error ? err.message : String(err)}`;
      const sr: StepResult = {
        status: 'failed', error: msg, duration_ms: Date.now() - stepStart,
        started_at: new Date(stepStart).toISOString(), completed_at: new Date().toISOString(),
      };
      context.steps.set(step.id, sr);
      onEvent?.({ kind: 'failed', stepId: step.id, ts: Date.now(), result: sr });
      if (step.on_error === 'stop' || !step.on_error) throw new Error(msg);
      return;
    }
  }

  // Render template variables in args
  const renderedArgs = renderArgs(step.args ?? {}, context);
  const stepType = step.type ?? 'argus.tool';

  onEvent?.({ kind: 'started', stepId: step.id, ts: stepStart });

  try {
    logger.info({ stepId: step.id, type: stepType, tool: step.tool }, 'Executing step');
    let resultText: string;
    let structuredResult: unknown;
    let hasStructuredResult = false;
    let stepEvidence: unknown;
    let isError = false;
    let approvalRequestId: number | undefined;

    switch (stepType) {
      case 'argus.tool':
      case 'tool': // legacy alias
      case undefined as unknown as string: {
        if (!step.tool) throw new Error(`step '${step.id}' has type=argus.tool but no tool name`);
        // Resolve optional cred_ref → token server-side. Default (no cred_ref
        // or no resolver) → undefined → backend service creds (unchanged path).
        let credOverride: StepCredOverride | undefined;
        if (step.cred_ref && credResolver) {
          const resolved = await credResolver(step);
          credOverride = resolved ?? undefined;
        }
        const r = await toolRunner(step.tool, renderedArgs, credOverride, { stepId: step.id });
        resultText = r.content.map(c => c.text).join('\n');
        isError = Boolean(r.isError);
        approvalRequestId = r.approvalRequestId;
        break;
      }
      case 'argus.agent': {
        if (!runners?.agentRunner) throw new Error(`no agentRunner provided — cannot execute argus.agent step`);
        if (!step.agent_id) throw new Error(`step '${step.id}' missing agent_id`);
        const prompt = String(renderedArgs['prompt'] ?? '');
        if (step.output_contract != null && !isAgentOutputContractName(step.output_contract)) {
          throw new Error(`step '${step.id}' has unknown output contract '${String(step.output_contract)}'`);
        }
        const contract = step.output_contract;
        if (!contract) {
          resultText = await runners.agentRunner(step.agent_id, prompt, renderedArgs);
          break;
        }

        const configuredRetries = step.output_contract_retries ?? 1;
        const maxRetries = Number.isInteger(configuredRetries)
          ? Math.max(0, Math.min(2, configuredRetries))
          : 1;
        const instruction = agentOutputContractInstruction(contract);
        const runnerArgs = { ...renderedArgs, [AGENT_OUTPUT_CONTRACT_ARG]: contract };
        let validationError = '';
        resultText = '';
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const attemptPrompt = attempt === 0
            ? `${prompt}\n\n${instruction}`
            : `${prompt}\n\nYour previous response was rejected by Argus because it violated the '${contract}' contract: ${validationError}. Regenerate the complete result.\n\n${instruction}`;
          resultText = await runners.agentRunner(step.agent_id, attemptPrompt, runnerArgs);
          try {
            structuredResult = parseAgentOutputContract(contract, resultText).value;
            hasStructuredResult = true;
            break;
          } catch (error) {
            validationError = error instanceof AgentOutputContractError ? error.message : String(error);
            if (attempt === maxRetries) {
              throw new AgentOutputContractError(
                contract,
                `step '${step.id}' failed after ${maxRetries + 1} attempt${maxRetries === 0 ? '' : 's'}: ${validationError}`,
              );
            }
          }
        }
        break;
      }
      case 'argus.skill': {
        if (!runners?.skillRunner) throw new Error(`no skillRunner provided — cannot execute argus.skill step`);
        if (!step.skill_id) throw new Error(`step '${step.id}' missing skill_id`);
        resultText = await runners.skillRunner(step.skill_id, renderedArgs);
        break;
      }
      case 'argus.knowledge': {
        if (!runners?.ragRunner) throw new Error(`no ragRunner provided — cannot execute argus.knowledge step`);
        const indexName = String(renderedArgs['index_name'] ?? '');
        const query = String(renderedArgs['query'] ?? '');
        const topK = Number(renderedArgs['top_k'] ?? 5);
        resultText = await runners.ragRunner(indexName, query, topK);
        break;
      }
      case 'argus.memory': {
        if (!runners?.memoryRunner) throw new Error(`no memoryRunner provided — cannot execute argus.memory step`);
        const op = String(renderedArgs['operation'] ?? 'retrieve');
        resultText = await runners.memoryRunner(op, renderedArgs);
        break;
      }
      case 'argus.approval': {
        if (!runners?.approvalRunner) {
          throw new Error('no approvalRunner provided — cannot execute argus.approval step');
        }
        const message = String(renderedArgs['message'] ?? step.label ?? 'Approve workflow continuation?');
        const resolution = await runners.approvalRunner({
          workflowId: context.workflowId,
          executionId: context.executionId,
          stepId: step.id,
          message,
        });
        resultText = JSON.stringify({
          decision: resolution.decision,
          request_id: resolution.requestId,
          message,
          ...(resolution.comment ? { comment: resolution.comment } : {}),
        });
        if (resolution.decision === 'pending') {
          approvalRequestId = resolution.requestId;
        } else if (resolution.decision === 'rejected') {
          throw new Error(
            `Runtime approval #${resolution.requestId} was rejected.`
            + `${resolution.comment ? ` Reviewer feedback: ${resolution.comment}` : ''}`,
          );
        } else {
          structuredResult = {
            approved: true,
            request_id: resolution.requestId,
            message,
          };
          hasStructuredResult = true;
        }
        break;
      }
      case 'logic.function': {
        // Execute a synchronous, size- and time-bounded data transform with
        // read-only JSON snapshots of workflow input and prior step results.
        const code = String(step.function_code ?? '').trim();
        if (!code) throw new Error(`step '${step.id}' has empty function_code`);
        structuredResult = runControlledFunction(code, context.input, Object.fromEntries(context.steps));
        hasStructuredResult = true;
        resultText = typeof structuredResult === 'string'
          ? structuredResult
          : JSON.stringify(structuredResult);
        break;
      }
      case 'logic.response': {
        // Terminal node — stores the rendered `value` as workflow output.
        const responseValue = renderedArgs['value'] ?? renderedArgs;
        resultText = typeof responseValue === 'string' ? responseValue : JSON.stringify(responseValue);
        if (typeof responseValue !== 'string') {
          structuredResult = responseValue;
          hasStructuredResult = true;
        }
        break;
      }
      case 'logic.wait': {
        const seconds = Math.max(0, Math.min(86400, Number(renderedArgs['seconds'] ?? 0)));
        if (seconds > 0) await new Promise((r) => setTimeout(r, seconds * 1000));
        resultText = `waited ${seconds}s`;
        break;
      }
      case 'logic.note': {
        // Sticky-note — visual only. Mark completed instantly.
        resultText = '(note)';
        break;
      }
      case 'logic.variables': {
        // Parse `variables` (JSON-string-or-object) and merge into the
        // execution-context input scope so downstream steps see them
        // via {{ input.<name> }}.
        const vars = parseVariables(renderedArgs['variables']);
        Object.assign(context.input, vars);
        structuredResult = vars;
        hasStructuredResult = true;
        resultText = JSON.stringify(vars);
        break;
      }
      case 'logic.table': {
        // Validate and retain a structured row array for downstream consumers.
        const rows = parseTableRows(renderedArgs['rows']);
        structuredResult = rows;
        hasStructuredResult = true;
        resultText = JSON.stringify(rows);
        break;
      }
      case 'logic.for_each': {
        const items = parseForEachItems(renderedArgs['items']);
        const mode = String(renderedArgs['mode'] ?? 'transform').trim().toLowerCase();
        const concurrency = Number(renderedArgs['concurrency'] ?? 4);
        const retries = Number(renderedArgs['retries'] ?? 0);
        const onItemError = String(renderedArgs['on_item_error'] ?? 'stop').trim().toLowerCase();
        if (mode !== 'transform' && mode !== 'subworkflow') {
          throw new Error(`For Each mode must be 'transform' or 'subworkflow'`);
        }
        if (onItemError !== 'stop' && onItemError !== 'continue') {
          throw new Error(`For Each on_item_error must be 'stop' or 'continue'`);
        }

        if (mode === 'transform') {
          const code = String(step.function_code ?? '').trim();
          if (!code) throw new Error(`For Each transform step '${step.id}' has empty function_code`);
          structuredResult = await runForEach(
            items,
            async (item, index) => runControlledFunction(
              code,
              context.input,
              Object.fromEntries(context.steps),
              { item, index },
            ),
            { concurrency, retries, onItemError },
          );
        } else {
          if (!runners?.subWorkflowRunner) throw new Error(`no subWorkflowRunner provided`);
          const targetId = Number(renderedArgs['target_workflow_id']);
          if (!Number.isInteger(targetId) || targetId <= 0) {
            throw new Error(`For Each subworkflow mode requires a valid target_workflow_id`);
          }
          const childInputs = renderedArgs['child_inputs'] == null || renderedArgs['child_inputs'] === ''
            ? {}
            : parseVariables(renderedArgs['child_inputs']);
          structuredResult = await runForEach(
            items,
            async (item, index) => runners.subWorkflowRunner!(
              targetId,
              normalizeDataResult({
                ...childInputs,
                parent_input: context.input,
                item,
                index,
              }, `For Each item ${index} child inputs`) as Record<string, unknown>,
              {
                parentWorkflowId: context.workflowId,
                parentExecutionId: context.executionId,
                parentStepId: step.id,
                itemIndex: index,
              },
            ),
            {
              concurrency,
              retries,
              onItemError,
              mapResult: value => isSubWorkflowRunResult(value)
                ? { value: value.output, evidence: value.evidence }
                : { value },
            },
          );
        }
        hasStructuredResult = true;
        resultText = JSON.stringify(structuredResult);
        break;
      }
      case 'argus.workflow': {
        if (!runners?.subWorkflowRunner) throw new Error(`no subWorkflowRunner provided`);
        const targetId = Number(renderedArgs['target_workflow_id']);
        if (!Number.isInteger(targetId) || targetId <= 0) {
          throw new Error(`argus.workflow step missing valid target_workflow_id`);
        }
        // Pass through the entire renderedArgs as sub-workflow inputs
        // (target_workflow_id stripped to avoid recursion confusion).
        const subInputs: Record<string, unknown> = { ...renderedArgs };
        delete subInputs['target_workflow_id'];
        const subWorkflowResult = await runners.subWorkflowRunner(targetId, subInputs, {
          parentWorkflowId: context.workflowId,
          parentExecutionId: context.executionId,
          parentStepId: step.id,
        });
        if (isSubWorkflowRunResult(subWorkflowResult)) {
          stepEvidence = subWorkflowResult.evidence;
          resultText = typeof subWorkflowResult.output === 'string'
            ? subWorkflowResult.output
            : JSON.stringify(subWorkflowResult.output);
        } else {
          resultText = subWorkflowResult;
        }
        break;
      }
      case 'logic.condition': {
        const expression = step.condition?.trim();
        if (!expression) throw new Error(`condition step '${step.id}' has no expression`);
        const matched = evaluateCondition(expression, context);
        const trueTarget = String(renderedArgs['true_target'] ?? '').trim();
        const falseTarget = String(renderedArgs['false_target'] ?? '').trim();
        if (!trueTarget || !falseTarget) {
          throw new Error(`condition step '${step.id}' requires true_target and false_target`);
        }
        const selectedTarget = matched ? trueTarget : falseTarget;
        deactivateUnselectedBranchTargets(context, [trueTarget, falseTarget], selectedTarget);
        structuredResult = { matched, selected_target: selectedTarget };
        hasStructuredResult = true;
        resultText = JSON.stringify(structuredResult);
        break;
      }
      case 'logic.router': {
        const routes = routeMap(renderedArgs['routes']);
        const routeValue = renderedArgs['route_on'];
        const routeKey = String(routeValue ?? '');
        const defaultTarget = String(renderedArgs['default_route'] ?? '').trim();
        const selectedTarget = routes[routeKey] ?? defaultTarget;
        if (!selectedTarget) {
          throw new Error(`router step '${step.id}' has no route for '${routeKey}' and no default_route`);
        }
        const targets = [...Object.values(routes), ...(defaultTarget ? [defaultTarget] : [])];
        deactivateUnselectedBranchTargets(context, targets, selectedTarget);
        structuredResult = { route: routeKey, selected_target: selectedTarget };
        hasStructuredResult = true;
        resultText = JSON.stringify(structuredResult);
        break;
      }
      case 'logic.parallel':
      case 'trigger.manual':
      case 'trigger.schedule':
      case 'trigger.webhook': {
        // Orchestration / entry — no per-step action. Pass through inputs.
        resultText = JSON.stringify(renderedArgs);
        break;
      }
      default:
        throw new Error(`unknown step type '${stepType}'`);
    }

    if (approvalRequestId != null) {
      const stepResult: StepResult = {
        status: 'waiting',
        result: resultText,
        error: resultText,
        duration_ms: Date.now() - stepStart,
        started_at: new Date(stepStart).toISOString(),
        completed_at: new Date().toISOString(),
        approval_request_id: approvalRequestId,
      };
      context.steps.set(step.id, stepResult);
      onEvent?.({ kind: 'waiting', stepId: step.id, ts: Date.now(), result: stepResult });
      throw new WorkflowApprovalRequiredError(approvalRequestId, step.id);
    }

    const stepResult: StepResult = {
      status: isError ? 'failed' : 'completed',
      result: hasStructuredResult ? structuredResult : resultText,
      ...(stepEvidence === undefined ? {} : { evidence: stepEvidence }),
      error: isError ? resultText : undefined,
      duration_ms: Date.now() - stepStart,
      started_at: new Date(stepStart).toISOString(),
      completed_at: new Date().toISOString(),
    };
    context.steps.set(step.id, stepResult);
    onEvent?.({
      kind: isError ? 'failed' : 'completed',
      stepId: step.id, ts: Date.now(), result: stepResult,
    });

    if (isError) {
      if (step.on_error === 'stop' || !step.on_error) {
        throw new Error(resultText || 'Step failed');
      }
    }
  } catch (err) {
    if (err instanceof WorkflowApprovalRequiredError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!context.steps.has(step.id)) {
      const sr: StepResult = {
        status: 'failed',
        ...(err instanceof ForEachExecutionError ? { result: err.result } : {}),
        ...(err instanceof SubWorkflowExecutionError ? { evidence: err.evidence } : {}),
        error: msg,
        duration_ms: Date.now() - stepStart,
        started_at: new Date(stepStart).toISOString(),
        completed_at: new Date().toISOString(),
      };
      context.steps.set(step.id, sr);
      onEvent?.({ kind: 'failed', stepId: step.id, ts: Date.now(), result: sr });
    }
    if (step.on_error === 'stop' || !step.on_error) throw err;
  }
}

/* ── Template Variable Rendering ───────────────────────────── */

function renderArgs(args: Record<string, unknown>, context: ExecutionContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = renderValue(value, context);
  }
  return out;
}

function renderValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === 'string') {
    const exact = /^\s*\{\{([^}]+)\}\}\s*$/.exec(value);
    if (exact?.[1]) return resolveTemplatePath(exact[1], ctx);
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const resolved = resolveTemplatePath(path, ctx);
      if (resolved === undefined || resolved === null) return '';
      return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map(v => renderValue(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderValue(v, ctx);
    }
    return out;
  }
  return value;
}

function isSubWorkflowRunResult(value: unknown): value is SubWorkflowRunResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = (value as { evidence?: unknown }).evidence;
  return evidence !== null
    && typeof evidence === 'object'
    && Number.isInteger(Number((evidence as { execution_id?: unknown }).execution_id))
    && typeof (value as { output?: unknown }).output !== 'undefined';
}

function resolveTemplatePath(path: string, ctx: ExecutionContext): unknown {
  const parts = path.trim().split('.');
  if (parts[0] === 'input') {
    let current: unknown = ctx.input;
    for (let index = 1; index < parts.length; index++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[parts[index]];
    }
    return current;
  }
  if (parts[0] === 'steps' && parts.length >= 3) {
    let current: unknown = ctx.steps.get(parts[1]);
    for (let index = 2; index < parts.length; index++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[parts[index]];
    }
    return current;
  }
  return undefined;
}

/* ── Helpers ───────────────────────────────────────────────── */

function routeMap(value: unknown): Record<string, string> {
  let candidate = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      throw new Error('router routes must be a JSON object');
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('router routes must be an object');
  }
  return Object.fromEntries(Object.entries(candidate)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
    .map(([key, target]) => [key, target.trim()]));
}

function deactivateUnselectedBranchTargets(
  context: ExecutionContext,
  targets: string[],
  selectedTarget: string,
): void {
  context.inactiveBranchTargets ??= new Set<string>();
  for (const target of new Set(targets.map(value => value.trim()).filter(Boolean))) {
    if (target !== selectedTarget) context.inactiveBranchTargets.add(target);
  }
}

function markDependentsSkipped(failedStepId: string, allSteps: WorkflowStep[], ctx: ExecutionContext): void {
  for (const step of allSteps) {
    if ((step.depends_on ?? []).includes(failedStepId) && !ctx.steps.has(step.id)) {
      ctx.steps.set(step.id, { status: 'skipped', duration_ms: 0 });
      // Recursive: skip dependents of dependents
      markDependentsSkipped(step.id, allSteps, ctx);
    }
  }
}

function restoreCheckpointVariables(steps: WorkflowStep[], ctx: ExecutionContext): void {
  for (const step of steps) {
    if (step.type !== 'logic.variables') continue;
    const checkpoint = ctx.steps.get(step.id);
    if (checkpoint?.status !== 'completed' || checkpoint.result == null) continue;
    try {
      const restored = typeof checkpoint.result === 'string'
        ? JSON.parse(checkpoint.result)
        : checkpoint.result;
      if (restored && typeof restored === 'object' && !Array.isArray(restored)) {
        Object.assign(ctx.input, restored as Record<string, unknown>);
      }
    } catch {
      logger.warn({ stepId: step.id }, 'Could not restore workflow variables from checkpoint');
    }
  }
}

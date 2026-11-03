import { randomUUID } from 'node:crypto';
import type { CoreAgentInvoker } from './coreClient.js';
import type { InvestigationPlan } from './domain.js';
import {
  completedAgentEvidence,
  buildKubernetesEvidence,
  buildSignalEvidence,
  failedAgentEvidence,
  knowledgePrompt,
  fallbackReviewerDiagnosis,
  parseReviewerDiagnosis,
  researcherPrompt,
  researcherGapPrompt,
  reviewerPrompt,
  type AgentEvidence,
  type InvestigationAgentRole,
  type InvestigationEvidence,
  type KubernetesEvidence,
} from './evidence.js';
import type { PackExecutionGrant } from './executionGrant.js';
import type { A2aTask, TaskStore } from './taskStore.js';

export interface InvestigationRunInput {
  taskId: string;
  plan: InvestigationPlan;
  grant: PackExecutionGrant;
}

export interface InvestigationExecutor {
  start(input: InvestigationRunInput): void;
}

function message(text: string): A2aTask['status']['message'] {
  return { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }] };
}

export class InvestigationRunner implements InvestigationExecutor {
  constructor(private readonly store: TaskStore, private readonly core: CoreAgentInvoker) {}

  start(input: InvestigationRunInput): void {
    void this.run(input).catch(cause => {
      console.error(JSON.stringify({ level: 'error', service: 'argus-aiops', taskId: input.taskId, message: 'investigation runner failed', error: cause instanceof Error ? cause.message : String(cause) }));
    });
  }

  private async current(taskId: string): Promise<A2aTask | null> {
    const task = await this.store.get(taskId);
    return task?.status.state === 'TASK_STATE_CANCELED' ? null : task;
  }

  private async collect(
    role: Extract<InvestigationAgentRole, 'researcher' | 'knowledge'>,
    prompt: string,
    grant: PackExecutionGrant,
    plan: InvestigationPlan,
  ): Promise<{ evidence: AgentEvidence; kubernetesEvidence?: KubernetesEvidence }> {
    const startedAt = new Date();
    try {
      const response = await this.core.callAgent({ agentName: role, message: prompt, grant });
      const evidence = completedAgentEvidence(role, startedAt, new Date(), response);
      const kubernetesEvidence = role === 'researcher' && plan.scope.resourceScope
        ? buildKubernetesEvidence(response.toolCalls, {
            namespace: plan.scope.resourceScope.namespace,
            service: plan.incident.service,
            windowStart: plan.scope.windowStart,
            windowEnd: plan.scope.windowEnd,
          })
        : undefined;
      if (role === 'researcher') {
        const prohibited = evidence.toolCalls.filter(call => call.name.startsWith('workspace_'));
        const providerEvidence = evidence.toolCalls.filter(call => !/^(?:workspace_|rag_|__)/.test(call.name));
        if (prohibited.length > 0 || providerEvidence.length === 0) {
          return { evidence: {
              ...evidence,
              status: 'failed',
              error: prohibited.length > 0
                ? `Operations researcher invoked tools outside its observe-only scope: ${prohibited.map(call => call.name).join(', ')}`
                : 'Operations researcher completed without querying a scoped provider or Argus-observability tool.',
            }, kubernetesEvidence };
        }
      }
      if (role === 'knowledge') {
        const knowledgeCalls = evidence.toolCalls.filter(call => /(?:rag_|knowledge|runbook|incident_history)/.test(call.name));
        if (knowledgeCalls.length > 0 || (evidence.ragCitations?.length ?? 0) > 0) return { evidence };
        return { evidence: {
            ...evidence,
            status: 'failed',
            outputSummary: '',
            error: 'Knowledge specialist completed without querying a scoped knowledge or incident-history tool.',
          } };
      }
      return { evidence, kubernetesEvidence };
    } catch (cause) {
      return { evidence: failedAgentEvidence(role, startedAt, new Date(), cause) };
    }
  }

  private async fillResearchGaps(
    result: { evidence: AgentEvidence; kubernetesEvidence?: KubernetesEvidence },
    grant: PackExecutionGrant,
    plan: InvestigationPlan,
  ): Promise<{ evidence: AgentEvidence; kubernetesEvidence?: KubernetesEvidence }> {
    if (result.evidence.status === 'failed') return result;
    const coverage = buildSignalEvidence([result.evidence]).signalCoverage;
    const configured = new Set(plan.evidenceLanes.map(lane => lane.id));
    const missing: Array<'metrics' | 'logs' | 'traces' | 'kubernetes'> = (['metrics', 'logs', 'traces'] as const).filter(lane =>
      configured.has(lane) &&
      !coverage.some(item => item.lane === lane && item.status === 'collected'));
    const runtimeEvidenceRequired = plan.serviceContext
      ? plan.evidenceLanes.some(lane => lane.id === 'runtime' && lane.requirement === 'required')
      : plan.scope.resourceScope?.kind === 'kubernetes';
    if (runtimeEvidenceRequired && plan.scope.resourceScope?.kind === 'kubernetes'
      && !result.evidence.toolCalls.some(call => call.name.startsWith('aiops_kubernetes_'))) {
      missing.push('kubernetes');
    }
    const calledTools = new Set(result.evidence.toolCalls.map(call => call.name));
    const missingRecipeTools = [...new Set(plan.evidenceLanes
      .flatMap(lane => lane.queryTemplates.map(query => query.toolName))
      .filter(tool => !calledTools.has(tool)))];
    if (missing.length === 0 && missingRecipeTools.length === 0) return result;
    const startedAt = new Date();
    try {
      const response = await this.core.callAgent({
        agentName: 'researcher',
        message: researcherGapPrompt(plan, missing, missingRecipeTools),
        grant,
      });
      const followUp = completedAgentEvidence('researcher', startedAt, new Date(), response);
      const followUpKubernetesEvidence = plan.scope.resourceScope
        ? buildKubernetesEvidence(response.toolCalls, {
            namespace: plan.scope.resourceScope.namespace,
            service: plan.incident.service,
            windowStart: plan.scope.windowStart,
            windowEnd: plan.scope.windowEnd,
          })
        : undefined;
      return {
        ...result,
        kubernetesEvidence: result.kubernetesEvidence ?? followUpKubernetesEvidence,
        evidence: {
          ...result.evidence,
          endedAt: followUp.endedAt,
          durationMs: result.evidence.durationMs + followUp.durationMs,
          model: followUp.model ?? result.evidence.model,
          sessionId: followUp.sessionId ?? result.evidence.sessionId,
          outputSummary: `${result.evidence.outputSummary}\n\nEvidence-gap pass:\n${followUp.outputSummary}`.slice(0, 40_000),
          toolCalls: [...result.evidence.toolCalls, ...followUp.toolCalls].slice(0, 256),
          ragCitations: [...(result.evidence.ragCitations ?? []), ...(followUp.ragCitations ?? [])].slice(0, 100),
        },
      };
    } catch {
      return result;
    }
  }

  async run(input: InvestigationRunInput): Promise<void> {
    const initial = await this.current(input.taskId);
    if (!initial) return;
    const gathering: A2aTask = {
      ...initial,
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString(), message: message('Researcher and knowledge agents are collecting bounded read-only evidence.') },
      metadata: { ...initial.metadata, currentStage: 'collect_evidence', implementationStage: 'agent-evidence' },
    };
    await this.store.save(gathering);

    const knowledgeEnabled = input.plan.evidenceLanes.some(lane => lane.id === 'knowledge');
    let [researcherResult, knowledgeResult] = await Promise.all([
      this.collect('researcher', researcherPrompt(input.plan), input.grant, input.plan),
      knowledgeEnabled
        ? this.collect('knowledge', knowledgePrompt(input.plan), input.grant, input.plan)
        : Promise.resolve(undefined),
    ]);
    researcherResult = await this.fillResearchGaps(researcherResult, input.grant, input.plan);
    const researcher = researcherResult.evidence;
    const knowledge = knowledgeResult?.evidence;
    const kubernetesEvidence = researcherResult.kubernetesEvidence;
    const afterCollection = await this.current(input.taskId);
    if (!afterCollection) return;
    const collected = [researcher, ...(knowledge ? [knowledge] : [])];
    if (researcher.status === 'failed') {
      await this.fail(afterCollection, collected, 'Operations researcher did not collect scoped provider evidence.', input.plan, kubernetesEvidence);
      return;
    }
    const runtimeEvidenceRequired = input.plan.serviceContext
      ? input.plan.evidenceLanes.some(lane => lane.id === 'runtime' && lane.requirement === 'required')
      : input.plan.scope.resourceScope?.kind === 'kubernetes';
    if (runtimeEvidenceRequired
      && input.plan.scope.resourceScope?.kind === 'kubernetes' && !kubernetesEvidence) {
      await this.fail(afterCollection, collected, 'Operations researcher did not collect scoped Kubernetes resource evidence.', input.plan);
      return;
    }
    if (collected.every(item => item.status === 'failed')) {
      await this.fail(afterCollection, collected, 'No evidence collector completed successfully.', input.plan, kubernetesEvidence);
      return;
    }

    const reviewing: A2aTask = {
      ...afterCollection,
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString(), message: message('The reviewer is validating causal claims against the collected evidence.') },
      artifacts: [
        ...(afterCollection.artifacts ?? []),
        {
          artifactId: randomUUID(),
          name: 'AIOps agent evidence',
          description: 'Bounded agent summaries and redacted tool-call metadata. Raw provider telemetry is not retained.',
          parts: [{ data: { kind: 'aiops-agent-evidence', schemaVersion: 1, evidence: collected } }],
        },
      ],
      metadata: { ...afterCollection.metadata, currentStage: 'review_evidence' },
    };
    await this.store.save(reviewing);

    const reviewStarted = new Date();
    let review: AgentEvidence;
    try {
      const response = await this.core.callAgent({ agentName: 'reviewer', message: reviewerPrompt(input.plan, collected), grant: input.grant });
      review = completedAgentEvidence('reviewer', reviewStarted, new Date(), response);
    } catch (cause) {
      review = failedAgentEvidence('reviewer', reviewStarted, new Date(), cause);
    }
    const latest = await this.current(input.taskId);
    if (!latest) return;
    if (review.status === 'failed') {
      await this.fail(latest, [...collected, review], 'Evidence was collected, but the reviewer could not validate the findings.', input.plan, kubernetesEvidence);
      return;
    }

    const allEvidence = [...collected, review];
    const signals = buildSignalEvidence(allEvidence);
    const reviewedDiagnosis = parseReviewerDiagnosis(review.outputSummary, input.plan);
    const requiredSignalLanes = input.plan.evidenceLanes
      .filter(lane => lane.requirement === 'required' && ['metrics', 'logs', 'traces'].includes(lane.id))
      .map(lane => lane.id);
    const reviewSignalsComplete = requiredSignalLanes.every(lane =>
      signals.signalCoverage.some(item => item.lane === lane && item.status === 'collected'));
    const result: InvestigationEvidence = {
      kind: 'aiops-investigation-evidence',
      schemaVersion: 2,
      implementationStage: 'agent-evidence',
      generatedAt: new Date().toISOString(),
      incident: input.plan.incident,
      scope: input.plan.scope,
      quality: collected.some(item => item.status === 'failed') || !reviewSignalsComplete || !reviewedDiagnosis.valid ? 'partial' : 'reviewed',
      agentEvidence: allEvidence,
      ...signals,
      ...(kubernetesEvidence ? { kubernetesEvidence } : {}),
      synthesis: reviewedDiagnosis.diagnosis.executiveAssessment,
      diagnosis: reviewedDiagnosis.diagnosis,
      safety: { mode: 'read-only', writesAllowed: false, rawTelemetryPersisted: false, redactionApplied: true },
    };
    await this.store.save({
      ...latest,
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString(), message: message('The read-only incident investigation completed with reviewer-validated evidence.') },
      artifacts: [
        ...(latest.artifacts ?? []),
        { artifactId: randomUUID(), name: 'Reviewed incident evidence', description: 'Provider-neutral findings produced from scoped Core Agent and MCP evidence.', parts: [{ data: result as unknown as Record<string, unknown> }] },
      ],
      metadata: { ...latest.metadata, currentStage: 'publish_findings', quality: result.quality },
    });
  }

  private async fail(
    task: A2aTask,
    evidence: AgentEvidence[],
    reason: string,
    plan: InvestigationPlan,
    kubernetesEvidence?: KubernetesEvidence,
  ): Promise<void> {
    const signals = buildSignalEvidence(evidence);
    const result: InvestigationEvidence = {
      kind: 'aiops-investigation-evidence', schemaVersion: 2, implementationStage: 'agent-evidence', generatedAt: new Date().toISOString(),
      incident: ((task.artifacts?.[0]?.parts[0]?.data['incident'] ?? {}) as InvestigationPlan['incident']),
      scope: ((task.artifacts?.[0]?.parts[0]?.data['scope'] ?? {}) as InvestigationPlan['scope']),
      quality: 'failed', agentEvidence: evidence, ...signals,
      ...(kubernetesEvidence ? { kubernetesEvidence } : {}), synthesis: reason,
      diagnosis: fallbackReviewerDiagnosis(plan, reason),
      safety: { mode: 'read-only', writesAllowed: false, rawTelemetryPersisted: false, redactionApplied: true },
    };
    await this.store.save({
      ...task,
      status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString(), message: message(reason) },
      artifacts: [...(task.artifacts ?? []), { artifactId: randomUUID(), name: 'Failed incident investigation', description: 'Failure evidence retained without raw provider telemetry.', parts: [{ data: result as unknown as Record<string, unknown> }] }],
      metadata: { ...task.metadata, currentStage: 'failed', quality: 'failed' },
    });
  }
}

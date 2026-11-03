import {
  aiActRegistrationReadinessSchema,
  type AiActRegistrationReadiness,
  type AiActSystemRevision,
} from './aiActContracts.js';

export interface AiSystemReadinessOptions {
  now?: Date;
  allowedActions?: string[];
}

type RegistrationStep = AiActRegistrationReadiness['steps'][number];

const action = (aiSystemId: string, step: string, label: string): RegistrationStep['action'] => ({
  label,
  href: `/governance/compliance?aiSystemId=${encodeURIComponent(aiSystemId)}&step=${encodeURIComponent(step)}`,
});

function prohibitedStep(revision: AiActSystemRevision): RegistrationStep {
  if (revision.prohibitedPracticeCheck.decision === 'blocked') {
    return {
      stepId: 'prohibited_practices',
      title: 'Prohibited-practice screening',
      status: 'blocked',
      blocking: true,
      issues: ['The recorded prohibited-practice screening blocks this AI system.'],
      action: action(revision.aiSystemId, 'prohibited_practices', 'Review prohibited use'),
    };
  }
  if (revision.prohibitedPracticeCheck.decision === 'external_review_required') {
    return {
      stepId: 'prohibited_practices',
      title: 'Prohibited-practice screening',
      status: 'external_review_required',
      blocking: true,
      issues: ['The current prohibited-practice screening requires an independent legal decision.'],
      action: action(revision.aiSystemId, 'prohibited_practices', 'Request independent review'),
    };
  }
  return {
    stepId: 'prohibited_practices',
    title: 'Prohibited-practice screening',
    status: 'complete',
    blocking: false,
    issues: [],
    action: null,
  };
}

function classificationStep(revision: AiActSystemRevision, now: Date): RegistrationStep {
  const assessment = revision.classification;
  if (assessment.classification === 'prohibited') {
    return {
      stepId: 'classification',
      title: 'Risk classification',
      status: 'blocked',
      blocking: true,
      issues: ['The recorded classification marks this AI system as prohibited.'],
      action: action(revision.aiSystemId, 'classification', 'Review classification'),
    };
  }
  if (assessment.classification === 'assessment_required') {
    return {
      stepId: 'classification',
      title: 'Risk classification',
      status: 'in_progress',
      blocking: true,
      issues: ['A final risk classification has not been recorded for this revision.'],
      action: action(revision.aiSystemId, 'classification', 'Complete classification'),
    };
  }
  const nextReview = new Date(assessment.nextReviewAt);
  if (nextReview.getTime() <= now.getTime()) {
    return {
      stepId: 'classification',
      title: 'Risk classification',
      status: 'blocked',
      blocking: true,
      issues: ['The classification review deadline has expired.'],
      action: action(revision.aiSystemId, 'classification', 'Reassess classification'),
    };
  }
  if (assessment.legalReviewRequired) {
    return {
      stepId: 'classification',
      title: 'Risk classification',
      status: 'external_review_required',
      blocking: true,
      issues: ['The current classification requires an independent legal review.'],
      action: action(revision.aiSystemId, 'classification', 'Request independent review'),
    };
  }
  return {
    stepId: 'classification',
    title: 'Risk classification',
    status: 'complete',
    blocking: false,
    issues: [],
    action: null,
  };
}

function controlsStep(revision: AiActSystemRevision): RegistrationStep {
  if (['ready_for_independent_review', 'externally_assessed', 'released'].includes(revision.lifecycleState)) {
    return {
      stepId: 'controls',
      title: 'Applicable control evidence',
      status: 'complete',
      blocking: false,
      issues: [],
      action: action(revision.aiSystemId, 'controls', 'View control evidence'),
    };
  }
  return {
    stepId: 'controls',
    title: 'Applicable control evidence',
    status: revision.lifecycleState === 'blocked' ? 'blocked' : 'not_started',
    blocking: true,
    issues: [revision.lifecycleState === 'blocked'
      ? 'Control assessment cannot proceed while the system registry is blocked.'
      : 'The catalog is pinned, but applicable control implementations and evidence have not been recorded yet.'],
    action: action(revision.aiSystemId, 'controls', 'Resolve control gaps'),
  };
}

function independentReviewStep(revision: AiActSystemRevision): RegistrationStep {
  if (['externally_assessed', 'released'].includes(revision.lifecycleState)) {
    return {
      stepId: 'independent_review',
      title: 'Independent conformity review',
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    };
  }
  if (revision.lifecycleState === 'ready_for_independent_review') {
    return {
      stepId: 'independent_review',
      title: 'Independent conformity review',
      status: 'in_progress',
      blocking: true,
      issues: ['The independent decision for this exact revision has not been recorded yet.'],
      action: action(revision.aiSystemId, 'independent_review', 'Review decision status'),
    };
  }
  return {
    stepId: 'independent_review',
    title: 'Independent conformity review',
    status: revision.lifecycleState === 'blocked' ? 'blocked' : 'not_started',
    blocking: true,
    issues: [revision.lifecycleState === 'blocked'
      ? 'The AI system is blocked before independent review.'
      : 'The system is not ready for an independent conformity decision.'],
    action: null,
  };
}

export function evaluateAiSystemRegistrationReadiness(
  revision: AiActSystemRevision,
  options: AiSystemReadinessOptions = {},
): AiActRegistrationReadiness {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Readiness timestamp is invalid');
  const steps: RegistrationStep[] = [
    {
      stepId: 'identity',
      title: 'System identity and owner',
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    },
    {
      stepId: 'intended_purpose',
      title: 'Intended purpose and boundaries',
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    },
    {
      stepId: 'market_roles',
      title: 'Provider and deployer responsibilities',
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    },
    prohibitedStep(revision),
    classificationStep(revision, now),
    {
      stepId: 'components',
      title: 'Models, agents, workflows and tools',
      status: 'complete',
      blocking: false,
      issues: [],
      action: null,
    },
    controlsStep(revision),
    independentReviewStep(revision),
  ];
  const satisfied = steps.filter(step => step.status === 'complete').length;
  const blocked = steps.filter(step => ['blocked', 'external_review_required'].includes(step.status)).length;
  const notAssessed = steps.length - satisfied - blocked;
  const nextReview = new Date(revision.classification.nextReviewAt).getTime();
  const expiring = nextReview > now.getTime() && nextReview <= now.getTime() + 30 * 24 * 60 * 60 * 1_000 ? 1 : 0;
  const roles = new Set(revision.marketRoles.map(role => role.role));
  const customerResponsibilities: AiActRegistrationReadiness['customerResponsibilities'] = [];
  if (roles.has('provider')) {
    customerResponsibilities.push({
      responsibilityId: 'customer-legal-classification',
      title: 'Confirm the intended-purpose legal classification',
      ownerRole: 'provider',
      status: revision.classification.legalReviewRequired ? 'open' : 'provided',
      dueAt: revision.classification.nextReviewAt,
    });
  }
  if (roles.has('deployer')) {
    customerResponsibilities.push({
      responsibilityId: 'customer-operator-training',
      title: 'Assign and train human oversight operators',
      ownerRole: 'deployer',
      status: 'open',
      dueAt: null,
    });
  }

  return aiActRegistrationReadinessSchema.parse({
    schemaVersion: 1,
    kind: 'ai-system-registration-readiness',
    aiSystemId: revision.aiSystemId,
    revisionId: revision.revisionId,
    state: revision.lifecycleState,
    generatedAt: now.toISOString(),
    evidenceCoverage: { applicable: steps.length, satisfied, blocked, notAssessed, expiring },
    steps,
    customerResponsibilities,
    allowedActions: [...new Set(options.allowedActions ?? ['read', 'view_control_gaps'])],
    claimBoundary: 'This readiness projection reports evidence and workflow gaps for the pinned revision; it is not a legal conformity decision or certification.',
  });
}

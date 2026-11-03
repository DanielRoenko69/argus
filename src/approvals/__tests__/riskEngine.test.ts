import { assessToolRisk } from '../riskEngine.js';

describe('runtime approval risk engine', () => {
  it('classifies a normal pull-request creation as medium and explains the write', () => {
    const assessment = assessToolRisk({
      toolName: 'gitea_create_pr',
      args: { repository: 'argus', head: 'feature', base: 'main' },
      isWrite: true,
      humanOversight: true,
      subjectType: 'workflow',
    });

    expect(assessment.level).toBe('medium');
    expect(assessment.score).toBe(50);
    expect(assessment.factors.map(factor => factor.id)).toEqual([
      'runtime-mutation',
      'write-action',
      'oversight-policy',
    ]);
  });

  it('escalates a production infrastructure deployment to critical', () => {
    const assessment = assessToolRisk({
      toolName: 'k8s_apply',
      args: { namespace: 'production', manifest: { kind: 'Deployment' } },
      isWrite: true,
      humanOversight: true,
      subjectType: 'workflow',
    });

    expect(assessment.level).toBe('critical');
    expect(assessment.score).toBe(100);
    expect(assessment.factors.map(factor => factor.id)).toEqual(expect.arrayContaining([
      'production-target',
      'change-operation',
      'infrastructure-control',
    ]));
  });

  it('detects broad forced destructive actions without retaining argument values', () => {
    const assessment = assessToolRisk({
      toolName: 'terraform_destroy',
      args: { environment: 'staging', target: '*', force: true, api_token: 'never-store-me' },
      isWrite: true,
    });

    expect(assessment.level).toBe('critical');
    expect(assessment.factors.map(factor => factor.id)).toEqual(expect.arrayContaining([
      'destructive-operation',
      'broad-scope',
      'safety-override',
      'sensitive-material',
    ]));
    expect(JSON.stringify(assessment)).not.toContain('never-store-me');
  });

  it('is stable for nested objects regardless of key order', () => {
    const left = assessToolRisk({
      toolName: 'jenkins_trigger_build',
      args: { parameters: { environment: 'prod', force: true }, job: 'release' },
      isWrite: true,
    });
    const right = assessToolRisk({
      toolName: 'jenkins_trigger_build',
      args: { job: 'release', parameters: { force: true, environment: 'prod' } },
      isWrite: true,
    });

    expect(right).toEqual(left);
  });
});

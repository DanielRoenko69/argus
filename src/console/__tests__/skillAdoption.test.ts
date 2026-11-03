import { buildSkillAdoptionResponse, normalizeSkillAdoptionDays } from '../skillAdoption.js';

describe('Skill Adoption Analytics', () => {
  it('accepts only exact whole-day windows from 1 through 90', () => {
    expect(normalizeSkillAdoptionDays(undefined)).toBe(30);
    expect(normalizeSkillAdoptionDays('1')).toBe(1);
    expect(normalizeSkillAdoptionDays('90')).toBe(90);
    for (const value of ['0', '91', '-1', '7.5', '30days', ' 30 ']) {
      expect(() => normalizeSkillAdoptionDays(value)).toThrow('1 to 90');
    }
  });

  it('builds complete metrics without exposing raw API-key prefixes', () => {
    const now = new Date('2026-08-02T15:00:00.000Z');
    const response = buildSkillAdoptionResponse(3, {
      bySkill: [{
        skill: 'incident-triage', label: 'Incident Triage', uses: 8,
        unique_consumers: 2, avg_ctx_len: 640, p95_ms: 42, error_count: 1,
      }],
      consumers: [{ api_key_prefix: 'argus-secret-prefix', skill_fetches: 8, distinct_skills: 1 }],
      timeSeries: [{ day: '2026-08-01', uses: 8, errors: 1 }],
      kpi: {
        dau: 1, wau: 2, mau: 3, total_skills: 4, active_skills: 1, total_uses: 8,
        avg_fetches_per_user: 4, p50_ms: 18, p95_ms: 42, error_count: 1,
      },
      stale: [{ id: 7, name: 'review-protocol', label: 'Review Protocol', icon: '🔍', days_since_last_use: '12.9' }],
      trending: [{ skill: 'incident-triage', label: 'Incident Triage', recent: 8, prior: 3, delta: 5 }],
      heatmap: [{ dow: 6, hour: 14, n: 8 }],
    }, now);

    expect(response.kpis).toMatchObject({ adoptionRate: 25, errorRate: 12.5, averageUsesPerConsumer: 4 });
    expect(response.bySkill[0]).toMatchObject({ label: 'Incident Triage', errorRate: 12.5 });
    expect(response.timeSeries).toEqual([
      { day: '2026-07-31', uses: 0, errors: 0 },
      { day: '2026-08-01', uses: 8, errors: 1 },
      { day: '2026-08-02', uses: 0, errors: 0 },
    ]);
    expect(response.stale[0]?.daysSinceLastUse).toBe(12);
    expect(response.consumers[0]?.id).toMatch(/^runtime-[a-f0-9]{8}$/);
    expect(JSON.stringify(response)).not.toContain('argus-secret-prefix');
  });

  it('keeps zero-volume workspaces numerically safe', () => {
    const response = buildSkillAdoptionResponse(1, {
      bySkill: [], consumers: [], timeSeries: [], kpi: null, stale: [], trending: [], heatmap: [],
    }, new Date('2026-08-02T00:00:00.000Z'));
    expect(response.kpis).toMatchObject({ adoptionRate: 0, errorRate: 0, totalUses: 0 });
    expect(response.timeSeries).toEqual([{ day: '2026-08-02', uses: 0, errors: 0 }]);
  });
});

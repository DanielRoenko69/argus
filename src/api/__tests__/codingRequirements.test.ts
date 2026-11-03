import { requirementsSubmission } from '../codingRequirements.js';

const thread = { status: 'interrupted', metadata: { execution_principal: 'user:7' }, interrupts: [{ value: { stage: 'requirements_input' } }] };
describe('requirements are owner-bound input, never an approval or grant', () => {
  it('accepts trimmed text with a content digest', () => {
    const result = requirementsSubmission({ requirements: ' Test the boundary ' }, thread, 7);
    expect(result.requirements).toBe('Test the boundary');
    expect(result.digest).toHaveLength(64);
  });
  it('rejects other users and approval/configuration payloads', () => {
    for (const user of [null, 8]) expect(() => requirementsSubmission({ requirements: 'text' }, thread, user)).toThrow('owner');
    for (const body of [{ approved: true }, { requirements: '' }, { requirements: 'text', approved: true }, { requirements: 'text', bundleIds: [1] }]) {
      expect(() => requirementsSubmission(body, thread, 7)).toThrow();
    }
  });
  it('cannot resume running threads or approval stages', () => {
    expect(() => requirementsSubmission({ requirements: 'text' }, { ...thread, status: 'running' }, 7)).toThrow();
    expect(() => requirementsSubmission({ requirements: 'text' }, { ...thread, interrupts: [{ value: { stage: 'code_approval' } }] }, 7)).toThrow();
  });
});

describe('version-bound development decisions', () => {
  const decision = { version: 2, id: 'a'.repeat(64), kind: 'requirement', canClarify: true,
    questions: [{ id: 'q1', question: 'Which behavior?', options: [
      { id: 'keep', label: 'Keep compatibility', consequence: 'Existing integrations remain usable.' },
      { id: 'new', label: 'New behavior', consequence: 'Existing integrations need adaptation.' },
    ] }] };
  const paused = { ...thread, values: { development_contract_version: 2 }, interrupts: [{ value: { stage: 'requirements_input', decision } }] };
  const reply = { decisionId: decision.id, requirements: '', answers: { q1: 'keep' } };
  it('resolves selected choices from the trusted interrupt and forwards the exact version', () => {
    const result = requirementsSubmission(reply, paused, 7);
    expect(result.requirements).toContain('Existing integrations remain usable.');
    expect(result.resume).toEqual(reply);
    expect(result.digest).toHaveLength(64);
  });
  it('rejects stale, foreign, invented, empty and authority-changing answers', () => {
    for (const body of [{ ...reply, decisionId: 'b'.repeat(64) }, { requirements: 'yes' },
      { ...reply, answers: { q1: 'invented' } }, { ...reply, answers: { q2: 'keep' } },
      { decisionId: decision.id, requirements: 'yes' }, { ...reply, approved: true }, { ...reply, bundleIds: [1] }]) {
      expect(() => requirementsSubmission(body, paused, 7)).toThrow();
    }
    expect(() => requirementsSubmission(reply, paused, 8)).toThrow('owner');
  });
  it('fails closed for missing decision and access/scope repair', () => {
    expect(() => requirementsSubmission({ requirements: 'text' }, { ...thread, values: paused.values }, 7)).toThrow('unavailable');
    for (const patch of [{ kind: 'scope' }, { canClarify: false }]) expect(() => requirementsSubmission(reply,
      { ...paused, interrupts: [{ value: { stage: 'requirements_input', decision: { ...decision, ...patch } } }] }, 7)).toThrow('authorized');
  });
  it('still accepts text-only substantive answers and bounds the combined response', () => {
    expect(requirementsSubmission({ decisionId: decision.id, requirements: 'Keep the existing behavior and its error contract.' }, paused, 7).requirements).toContain('existing behavior');
    expect(() => requirementsSubmission({ ...reply, requirements: 'x'.repeat(12000) }, paused, 7)).toThrow('12000');
  });
  it('rejects substantive and generic owner input for a technical blocked checkpoint', () => {
    const technical = { ...paused, interrupts: [{ value: { stage: 'requirements_input',
      decision: { ...decision, kind: 'technical_review', canClarify: false } } }] };
    for (const requirements of ['ja', 'Use atol=1e-6 and keep running.']) {
      expect(() => requirementsSubmission({ decisionId: decision.id, requirements }, technical, 7)).toThrow('Technical work is blocked');
    }
  });
});

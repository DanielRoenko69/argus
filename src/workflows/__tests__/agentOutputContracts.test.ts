import { describe, expect, it } from '@jest/globals';
import {
  AgentOutputContractError,
  parseAgentOutputContract,
} from '../agentOutputContracts.js';

describe('Agent output contracts', () => {
  it('accepts a fenced planner object and applies tolerant optional defaults', () => {
    const parsed = parseAgentOutputContract('planner_plan', `Here is the plan:\n\n\`\`\`json
{"summary":"Ship the endpoint safely","steps":["Inspect routing","Add a test"]}
\`\`\``);

    expect(parsed.value).toEqual({
      summary: 'Ship the endpoint safely',
      steps: ['Inspect routing', 'Add a test'],
      validation: [],
      risks: [],
      assumptions: [],
    });
    expect(JSON.parse(parsed.canonical)).toEqual(parsed.value);
  });

  it('normalizes a machine-readable reviewer approval', () => {
    expect(parseAgentOutputContract('review_verdict', JSON.stringify({
      verdict: 'APPROVE',
      summary: 'The scoped change and test evidence are consistent.',
    })).value).toEqual({
      verdict: 'APPROVE',
      summary: 'The scoped change and test evidence are consistent.',
      findings: [],
      required_changes: [],
    });
  });

  it('rejects malformed implementation evidence with a useful field path', () => {
    expect(() => parseAgentOutputContract('implementation_evidence', JSON.stringify({
      summary: 'Tests ran',
      validation: [{ command: 'npm test', status: 'maybe' }],
    }))).toThrow(AgentOutputContractError);
    expect(() => parseAgentOutputContract('implementation_evidence', JSON.stringify({
      summary: 'Tests ran',
      validation: [{ command: 'npm test', status: 'maybe' }],
    }))).toThrow(/validation\.0\.status/);
  });
});

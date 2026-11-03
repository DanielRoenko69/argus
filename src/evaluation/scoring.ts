import { evaluationRulesSchema, type EvaluationRules } from './contracts.js';

export const EVALUATOR_VERSION = 'argus.deterministic.v1' as const;
export interface AssertionVerdict {
  index: number;
  type: EvaluationRules['assertions'][number]['type'];
  passed: boolean;
  reason: 'matched' | 'not_matched' | 'empty_output' | 'invalid_json_object';
}
export interface EvaluationJudgement {
  version: typeof EVALUATOR_VERSION;
  status: 'passed' | 'failed';
  scores: { overall: number };
  assertions: AssertionVerdict[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Pure, local and bounded. Neither expected answers nor rules are sent to a model. */
export function scoreEvaluationOutput(output: string, rawRules: unknown): EvaluationJudgement {
  const rules = evaluationRulesSchema.parse(rawRules);
  const empty = output.trim().length === 0;
  let json: unknown;
  if (!empty && rules.assertions.some(a => a.type.startsWith('json_'))) {
    try { json = JSON.parse(output); } catch { /* Invalid JSON is a failed assertion. */ }
  }
  const assertions = rules.assertions.map((a, index): AssertionVerdict => {
    if (empty) return { index, type: a.type, passed: false, reason: 'empty_output' };
    let passed = false;
    if (a.type.startsWith('json_') && !object(json)) {
      return { index, type: a.type, passed: false, reason: 'invalid_json_object' };
    }
    switch (a.type) {
      case 'text_equals': passed = output === a.value; break;
      case 'text_includes': passed = output.includes(a.value); break;
      case 'text_excludes': passed = !output.includes(a.value); break;
      case 'json_object': passed = a.required.every(key => Object.hasOwn(json as object, key)); break;
      case 'json_field_equals': {
        let current = json;
        let found = true;
        for (const key of a.path) {
          if (!object(current) || !Object.hasOwn(current, key)) { found = false; break; }
          current = current[key];
        }
        passed = found && current === a.value;
      }
    }
    return { index, type: a.type, passed, reason: passed ? 'matched' : 'not_matched' };
  });
  const count = assertions.filter(a => a.passed).length;
  return { version: EVALUATOR_VERSION, status: count === assertions.length ? 'passed' : 'failed',
    scores: { overall: count / assertions.length }, assertions };
}

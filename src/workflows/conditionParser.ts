/**
 * Safe condition evaluator for workflow step conditions.
 * NO eval() — uses a simple recursive-descent expression parser.
 *
 * Supports:
 *   - Path resolution:  steps.get_alerts.status, input.namespace
 *   - Comparisons:      ===, !==, >, <, >=, <=
 *   - Boolean logic:    &&, ||
 *   - Negation:         !expr
 *   - Literals:         'string', 123, true, false
 *   - Truthiness:       steps.get_alerts.result  (truthy check)
 */

import type { ExecutionContext } from './types.js';

export function evaluateCondition(expr: string, context: ExecutionContext): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return true; // empty condition = always run
  return Boolean(parseOr(trimmed, context));
}

/* ── Recursive-descent parser ──────────────────────────────── */

function parseOr(expr: string, ctx: ExecutionContext): unknown {
  // split on || outside of quotes
  const parts = splitOutsideQuotes(expr, '||');
  if (parts.length === 1) return parseAnd(parts[0], ctx);
  return parts.some(p => Boolean(parseAnd(p.trim(), ctx)));
}

function parseAnd(expr: string, ctx: ExecutionContext): unknown {
  const parts = splitOutsideQuotes(expr, '&&');
  if (parts.length === 1) return parseComparison(parts[0], ctx);
  return parts.every(p => Boolean(parseComparison(p.trim(), ctx)));
}

function parseComparison(expr: string, ctx: ExecutionContext): unknown {
  // Try each comparison operator (longest first to avoid ambiguity)
  for (const op of ['===', '!==', '>=', '<=', '>', '<'] as const) {
    const idx = findOperator(expr, op);
    if (idx !== -1) {
      const left = resolveValue(expr.slice(0, idx).trim(), ctx);
      const right = resolveValue(expr.slice(idx + op.length).trim(), ctx);
      switch (op) {
        case '===': return left === right;
        case '!==': return left !== right;
        case '>':   return (left as number) > (right as number);
        case '<':   return (left as number) < (right as number);
        case '>=':  return (left as number) >= (right as number);
        case '<=':  return (left as number) <= (right as number);
      }
    }
  }
  // No comparison operator — resolve as truthiness
  const val = expr.trim();
  if (val.startsWith('!')) {
    return !resolveValue(val.slice(1).trim(), ctx);
  }
  return resolveValue(val, ctx);
}

/* ── Value resolution ──────────────────────────────────────── */

function resolveValue(token: string, ctx: ExecutionContext): unknown {
  if (!token) return undefined;

  // String literal
  if ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  // Number literal
  if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
  // Boolean literals
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  if (token === 'undefined') return undefined;

  // Dot-path resolution: steps.X.Y or input.Z
  return resolvePath(token, ctx);
}

function resolvePath(path: string, ctx: ExecutionContext): unknown {
  const parts = path.split('.');
  if (parts[0] === 'input') {
    let current: unknown = ctx.input;
    for (let i = 1; i < parts.length; i++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[parts[i]];
    }
    return current;
  }
  if (parts[0] === 'steps' && parts.length >= 2) {
    const stepResult = ctx.steps.get(parts[1]);
    if (!stepResult) return undefined;
    let current: unknown = stepResult;
    for (let i = 2; i < parts.length; i++) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[parts[i]];
    }
    return current;
  }
  return undefined;
}

/* ── Helpers ───────────────────────────────────────────────── */

/** Split expression on operator, but not inside string literals */
function splitOutsideQuotes(expr: string, operator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
    } else if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
    } else if (expr.slice(i, i + operator.length) === operator) {
      parts.push(current);
      current = '';
      i += operator.length;
      continue;
    } else {
      current += ch;
    }
    i++;
  }
  parts.push(current);
  return parts;
}

/** Find operator position outside of string literals */
function findOperator(expr: string, op: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < expr.length - op.length + 1; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === "'" || ch === '"') {
      inQuote = ch;
    } else if (expr.slice(i, i + op.length) === op) {
      return i;
    }
  }
  return -1;
}

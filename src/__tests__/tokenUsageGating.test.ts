/**
 * tokenUsageGating.test.ts
 *
 * Governance test: the public/hardened chat path must NEVER enable emitUsage.
 *
 * hardenedChat.ts calls runAgentChat with exactly 10 positional args
 * (agentId, sessionId, userMessage, pool, config, modelOverride=undefined,
 *  callingUser=undefined, ragIndexIds, allowedTools=[], disableMemory=true).
 * The 11th param (emitUsage) is absent — that is the invariant this test guards.
 *
 * Strategy: source-level inspection — fast, no server boot needed, and will
 * FAIL if anyone adds emitUsage:true (or a truthy 11th positional arg) to the
 * public path.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

describe('token_usage gating (public path stays off)', () => {
  const src = readFileSync('src/public/hardenedChat.ts', 'utf8');

  it('hardenedChat does not reference emitUsage anywhere', () => {
    // If someone adds emitUsage to hardenedChat this test will catch it.
    expect(/emitUsage/.test(src)).toBe(false);
  });

  it('RunAgentChatFn type has exactly 10 parameters (no emitUsage slot)', () => {
    // The type definition is the contract hardenedChat binds to.
    // Confirm it does not declare an emitUsage parameter.
    const typeBlock = src.match(/export type RunAgentChatFn\s*=\s*\(([\s\S]*?)\)\s*=>/);
    expect(typeBlock).toBeTruthy();
    const params = typeBlock![1];
    expect(/emitUsage/.test(params)).toBe(false);
    // Count declared params: each line with a name followed by ?: or : is a param.
    const paramLines = params.split('\n').filter(l => /^\s+\w+\??:/.test(l));
    expect(paramLines).toHaveLength(10);
  });

  it('the runAgentChat yield* call ends with disableMemory=true and no 11th arg', () => {
    // Extract the yield* runAgentChat(...) call block from hardenedChat.ts.
    const callMatch = src.match(/yield\*\s+runAgentChat\s*\(([\s\S]*?)\);/);
    expect(callMatch).toBeTruthy();
    const callArgs = callMatch![1];

    // The last meaningful argument must be the disableMemory=true comment block.
    // Confirm 'true,' does NOT appear after the disableMemory position as a new arg.
    // We do this by counting the top-level comma-separated arguments.
    // Strip comments to avoid counting commas inside comment lines.
    const stripped = callArgs
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, '').trimEnd())
      .join('\n');

    // Count top-level commas (not inside nested parens/brackets).
    // TypeScript allows a trailing comma after the last arg, so:
    //   10 args without trailing comma → 9 commas
    //   10 args with    trailing comma → 10 commas
    // hardenedChat uses a trailing comma, so we expect exactly 10.
    let depth = 0;
    let commas = 0;
    for (const ch of stripped) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) commas++;
    }
    // 10 args + trailing comma = 10 top-level commas.
    // An 11th arg would produce 11 commas (or 12 with its own trailing comma).
    expect(commas).toBe(10);

    // Double-check: no truthy emitUsage anywhere in the call.
    expect(/emitUsage/.test(callArgs)).toBe(false);
  });
});

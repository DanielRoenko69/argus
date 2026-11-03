import type { OpenApiDoc } from './parse.js';

/**
 * Resolve only intra-document `#/...` $refs. External/remote refs throw (no network).
 * Recursive object schemas are cycle-safe (memoized); a circular `$ref → $ref` chain (which has no
 * concrete node to inline) is rejected with a clear error instead of overflowing the stack.
 */
export function resolveLocalRefs(doc: OpenApiDoc): OpenApiDoc {
  const root = doc;
  const seen = new WeakMap<object, unknown>();
  const activeRefs = new Set<string>();   // $refs currently being resolved on this path
  let visitedNodes = 0;
  const maxNodes = 100_000;
  const maxDepth = 100;

  function deref(ref: string): unknown {
    if (!ref.startsWith('#/')) throw new Error(`Refusing external/remote $ref: "${ref}"`);
    const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur: any = root; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') throw new Error(`Unresolvable $ref: "${ref}"`);
      if (p === '__proto__' || p === 'prototype' || p === 'constructor' || !Object.prototype.hasOwnProperty.call(cur, p)) {
        throw new Error(`Unresolvable $ref: "${ref}"`);
      }
      cur = cur[p];
    }
    if (cur === undefined) throw new Error(`Unresolvable $ref: "${ref}"`);
    return cur;
  }

  function walk(node: unknown, depth = 0): unknown {
    if (node == null || typeof node !== 'object') return node;
    if (depth > maxDepth) throw new Error(`OpenAPI document exceeds the maximum nesting depth of ${maxDepth}`);
    visitedNodes++;
    if (visitedNodes > maxNodes) throw new Error(`OpenAPI document exceeds the maximum node count of ${maxNodes}`);
    if (seen.has(node as object)) return seen.get(node as object);
    if (Array.isArray(node)) {
      const arr: unknown[] = [];
      seen.set(node as object, arr);
      for (const item of node) arr.push(walk(item, depth + 1));
      return arr;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const ref = obj.$ref;
      if (activeRefs.has(ref)) throw new Error(`Circular $ref: "${ref}"`);
      activeRefs.add(ref);
      try { return walk(deref(ref), depth + 1); }
      finally { activeRefs.delete(ref); }
    }
    const out: Record<string, unknown> = {};
    seen.set(node as object, out);
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, depth + 1);
    return out;
  }

  return walk(root) as OpenApiDoc;
}

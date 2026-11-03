#!/usr/bin/env node
// Argus Load Test — dep-free, Node 18+ (built-in fetch).
//
// Usage:
//   node scripts/loadtest.mjs <mode> [concurrency] [durationSec]
//
// Modes:
//   nav         GET  /api/nav/badges                 — single SQL, cheapest read
//   agents      GET  /api/agents                     — list agents
//   compliance  GET  /api/admin/compliance/runs      — admin read
//   chat        POST /api/agents/:id/chat (sync)     — full LLM round-trip (COSTS TOKENS)
//
// Defaults: concurrency=10, durationSec=20

import process from 'node:process';

const BASE = process.env.ARGUS_BASE   ?? 'http://localhost:3000';
const KEY  = process.env.ARGUS_KEY    ?? 'test-api-key-12345678';
const AGENT_ID = process.env.ARGUS_AGENT_ID ?? '';

const [, , mode = 'nav', cArg = '10', dArg = '20'] = process.argv;
const concurrency = Number(cArg);
const durationMs  = Number(dArg) * 1000;

if (!['health','nav','agents','compliance','chat'].includes(mode)) {
  console.error(`unknown mode '${mode}'`);
  process.exit(2);
}
if (mode === 'chat' && !AGENT_ID) {
  console.error('chat mode requires ARGUS_AGENT_ID env var (numeric agent id)');
  process.exit(2);
}

const ENDPOINTS = {
  health:     { method: 'GET',  url: '/health' },          // no auth/DB — raw server (event-loop) ceiling
  nav:        { method: 'GET',  url: '/api/nav/badges' },
  agents:     { method: 'GET',  url: '/api/agents' },
  compliance: { method: 'GET',  url: '/api/admin/compliance/runs' },
  chat:       { method: 'POST', url: `/api/agents/${AGENT_ID}/chat` },
};

const ep = ENDPOINTS[mode];
const samples = [];
const errors  = new Map();
let inflight  = 0;
let total     = 0;
let stop      = false;

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a,b) => a-b);
  const idx = Math.min(s.length-1, Math.floor((p/100) * s.length));
  return s[idx];
}

async function oneRequest() {
  inflight++;
  total++;
  const t0 = performance.now();
  try {
    const body = mode === 'chat'
      ? JSON.stringify({ message: 'Sag in einem Satz hallo.' })
      : undefined;
    const res = await fetch(BASE + ep.url, {
      method: ep.method,
      headers: {
        'X-API-Key': KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
    });
    // Drain body so connection can be reused
    await res.text();
    const dt = performance.now() - t0;
    if (res.ok) {
      samples.push(dt);
    } else {
      errors.set(res.status, (errors.get(res.status) ?? 0) + 1);
    }
  } catch (err) {
    const key = err?.code ?? err?.name ?? 'unknown';
    errors.set(key, (errors.get(key) ?? 0) + 1);
  } finally {
    inflight--;
  }
}

async function worker() {
  while (!stop) await oneRequest();
}

const tStart = performance.now();
const deadline = setTimeout(() => { stop = true; }, durationMs);
const workers = Array.from({ length: concurrency }, () => worker());

// Progress every 2s
const progress = setInterval(() => {
  const elapsed = ((performance.now() - tStart) / 1000).toFixed(1);
  const ok = samples.length;
  const errCount = [...errors.values()].reduce((a,b)=>a+b, 0);
  process.stdout.write(`  t=${elapsed}s  ok=${ok}  err=${errCount}  inflight=${inflight}\n`);
}, 2000);

await Promise.all(workers);
clearTimeout(deadline);
clearInterval(progress);

const elapsedSec = (performance.now() - tStart) / 1000;
const ok    = samples.length;
const fail  = [...errors.values()].reduce((a,b)=>a+b, 0);
const rps   = (total / elapsedSec).toFixed(1);
const p50   = pct(samples, 50).toFixed(0);
const p95   = pct(samples, 95).toFixed(0);
const p99   = pct(samples, 99).toFixed(0);
const mean  = (samples.reduce((a,b)=>a+b,0) / Math.max(1,samples.length)).toFixed(0);
const max   = Math.max(0, ...samples).toFixed(0);

console.log('');
console.log('═══════════════════════════════════════════');
console.log(`Mode:        ${mode}  (${ep.method} ${ep.url})`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Duration:    ${elapsedSec.toFixed(1)}s`);
console.log(`Total:       ${total}   ok=${ok}   fail=${fail}`);
console.log(`Throughput:  ${rps} req/s`);
console.log(`Latency ms:  p50=${p50}  p95=${p95}  p99=${p99}  mean=${mean}  max=${max}`);
if (errors.size) {
  console.log('Errors:');
  for (const [k,v] of errors.entries()) console.log(`  ${k}: ${v}`);
}
console.log('═══════════════════════════════════════════');

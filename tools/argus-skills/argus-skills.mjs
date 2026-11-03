#!/usr/bin/env node
// argus-skills — zero-dep CLI to sync curated skills into Argus.
//
// Commands:
//   argus-skills list                            list skills currently in Argus
//   argus-skills sync <dir> [--dry-run]          upsert every *.md under <dir>
//
// Markdown format (YAML frontmatter required):
//   ---
//   name: tdd-discipline           # ^[a-z0-9_-]+$
//   label: TDD Discipline          # human label, falls back to name
//   description: When to apply ... # optional, ~1 sentence
//   category: engineering          # optional, free-form
//   icon: "🧪"                      # optional
//   ---
//   <markdown body — becomes the skill content>
//
// Env:
//   ARGUS_URL       (default http://localhost:3000)
//   ARGUS_API_KEY   admin-scoped Gateway key (required for /api/admin/skills/upsert)

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve, relative } from 'node:path';
import { argv, env, exit } from 'node:process';

const ARGUS_URL = (env.ARGUS_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY   = env.ARGUS_API_KEY ?? '';

function die(msg, code = 1) { console.error(`argus-skills: ${msg}`); exit(code); }

function authHeaders() {
  if (!API_KEY) die('ARGUS_API_KEY env var is required.');
  return { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };
}

// ── Minimal YAML-frontmatter parser ────────────────────────────────
// Supports `key: value` and `key: "quoted value"`. No nested objects,
// no arrays — that is by design; skill metadata stays flat.
function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { meta: {}, body: raw };
  const header = raw.slice(4, end);
  const bodyStart = raw.indexOf('\n', end + 4) + 1;
  const meta = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[m[1]] = val;
  }
  return { meta, body: raw.slice(bodyStart) };
}

async function walkMarkdown(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function cmdList() {
  const r = await fetch(`${ARGUS_URL}/api/admin/skills`, { headers: authHeaders() });
  if (!r.ok) die(`GET /api/admin/skills returned ${r.status}: ${await r.text()}`);
  const skills = await r.json();
  if (skills.length === 0) { console.log('(no skills in Argus)'); return; }
  const w = Math.max(...skills.map(s => s.name.length));
  console.log(`${'NAME'.padEnd(w)}  CATEGORY        SOURCE`);
  for (const s of skills) {
    const src = s.source_url
      ? (s.source_url.length > 60 ? '…' + s.source_url.slice(-59) : s.source_url)
      : '(hand-authored)';
    console.log(`${s.name.padEnd(w)}  ${(s.category ?? '-').padEnd(15)} ${src}`);
  }
  console.log(`\n${skills.length} skill(s).`);
}

async function cmdSync(dir, opts) {
  const root = resolve(dir);
  try { if (!(await stat(root)).isDirectory()) die(`Not a directory: ${root}`); }
  catch { die(`Cannot read ${root}`); }

  const files = await walkMarkdown(root);
  if (files.length === 0) die(`No *.md files under ${root}`);

  const isLocal = !/^https?:/i.test(dir);
  const sourcePrefix = isLocal ? `local:${root}` : dir.replace(/\/+$/, '');

  let created = 0, updated = 0, skipped = 0;
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const name = meta.name ?? basename(file, '.md').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!/^[a-z0-9_-]+$/.test(name)) { console.warn(`SKIP ${file}: invalid name "${name}"`); skipped++; continue; }
    if (!body.trim()) { console.warn(`SKIP ${file}: empty body`); skipped++; continue; }

    const payload = {
      name,
      label:       meta.label       ?? name,
      description: meta.description ?? '',
      content:     body.trim(),
      category:    meta.category    ?? null,
      icon:        meta.icon        ?? '🔧',
      source_url:  `${sourcePrefix}/${relative(root, file).replace(/\\/g, '/')}`,
      source_ref:  meta.source_ref  ?? null,
      imported_at: new Date().toISOString(),
    };

    if (opts.dryRun) {
      console.log(`DRY ${name.padEnd(28)} (${(body.length / 1024).toFixed(1)}kb) ← ${file}`);
      continue;
    }

    const r = await fetch(`${ARGUS_URL}/api/admin/skills/upsert`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
    });
    if (!r.ok) { console.error(`FAIL ${name}: ${r.status} ${await r.text()}`); skipped++; continue; }
    const result = await r.json();
    if (result.created) { console.log(`+   ${name}`); created++; }
    else                { console.log(`~   ${name}`); updated++; }
  }

  console.log(`\n${opts.dryRun ? 'Would import' : 'Imported'}: ${created} new, ${updated} updated, ${skipped} skipped.`);
}

function usage() {
  console.log(`argus-skills — sync curated skills into Argus

Usage:
  argus-skills list
  argus-skills sync <dir> [--dry-run]

Env:
  ARGUS_URL       Argus base URL  (default: http://localhost:3000)
  ARGUS_API_KEY   Admin API key   (required)
`);
}

const [, , cmd, ...rest] = argv;
const flags = new Set(rest.filter(x => x.startsWith('--')));
const positional = rest.filter(x => !x.startsWith('--'));

switch (cmd) {
  case 'list':                 await cmdList(); break;
  case 'sync':
    if (!positional[0]) { usage(); die('sync requires <dir>'); }
    await cmdSync(positional[0], { dryRun: flags.has('--dry-run') });
    break;
  case undefined: case 'help': case '--help': case '-h':
    usage(); break;
  default:
    usage(); die(`Unknown command: ${cmd}`);
}

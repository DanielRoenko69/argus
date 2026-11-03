#!/usr/bin/env node
// Narrow local operator step. Adds one dispatcher allowlist target to .env;
// never starts Jenkins, changes credentials or approves a workflow.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { FASTAPI_BINDING, FASTAPI_IMAGE_JOB } from './lib/showcaseFastapiCi.mjs';

const mode = process.argv[2];
assert.ok(process.argv.length === 3 && ['--apply', '--check'].includes(mode), 'Use --apply or --check.');
const path = new URL('../.env', import.meta.url);
const source = await readFile(path, 'utf8');
const env = parse(source);
const targets = JSON.parse(env.ARGUS_JENKINS_DISPATCH_TARGETS || '[]');
assert.ok(Array.isArray(targets), 'Invalid Jenkins dispatch target list.');
const image = { ...FASTAPI_BINDING, job: FASTAPI_IMAGE_JOB };
const existing = targets.filter(target => target.job === FASTAPI_IMAGE_JOB);
assert.ok(existing.length <= 1 && existing.every(target => Object.entries(image).every(([key, value]) => target[key] === value)),
  'Existing image-only Jenkins binding differs; operator review required.');
if (!existing.length) {
  if (mode !== '--apply') throw new Error('Image-only dispatcher binding is missing. Run --apply after operator review.');
  targets.push(image);
  const line = `ARGUS_JENKINS_DISPATCH_TARGETS='${JSON.stringify(targets)}'`;
  const updated = /^ARGUS_JENKINS_DISPATCH_TARGETS=.*$/m.test(source)
    ? source.replace(/^ARGUS_JENKINS_DISPATCH_TARGETS=.*$/m, line)
    : `${source.replace(/\n?$/, '\n')}${line}\n`;
  await writeFile(path, updated, { mode: 0o600 });
}
console.log(JSON.stringify({ target:image, configured:true, dockerRestarted:false, workflowStarted:false }));

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyAuditEvidencePack } from '../dist/audit/evidencePack.js';

const filename = process.argv[2];
if (!filename) {
  console.error('Usage: npm run verify:audit-evidence-pack -- <evidence-pack.json>');
  process.exitCode = 2;
} else {
  try {
    const pack = JSON.parse(await readFile(resolve(filename), 'utf8'));
    const result = verifyAuditEvidencePack(pack);
    console.log(JSON.stringify(result, null, 2));
    if (result.state !== 'valid') process.exitCode = 1;
  } catch (error) {
    console.error(`Evidence pack verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

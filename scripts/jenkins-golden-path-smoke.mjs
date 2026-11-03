import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';
import { latestJenkinsGoldenPathSource, triggerJenkinsGoldenPathBuild } from './lib/jenkinsGoldenPath.mjs';

let fileConfiguration = {};
try { fileConfiguration = parseDotEnv(readFileSync(resolve(import.meta.dirname, '..', '.env'))); } catch { /* environment-only installs are supported */ }
const configuration = { ...fileConfiguration, ...process.env };
let dev = null;
for (const filename of ['solution-showcase-dev-golden-run.json', 'solution-showcase-golden-runs.json']) {
  try {
    const report = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'test-results', filename), 'utf8'));
    if (report?.runs?.dev?.branchName && report?.runs?.dev?.commitSha) {
      dev = report.runs.dev;
      break;
    }
  } catch { /* fall back to Jenkins' last immutable successful source */ }
}
dev ??= await latestJenkinsGoldenPathSource(configuration);

const evidence = await triggerJenkinsGoldenPathBuild({
  configuration,
  branchName: dev.branchName,
  commitSha: dev.commitSha,
});
process.stdout.write(`${JSON.stringify({ passed: true, repository: 'argus/argus-dev-sample', branchName: dev.branchName, commitSha: dev.commitSha, ...evidence }, null, 2)}\n`);

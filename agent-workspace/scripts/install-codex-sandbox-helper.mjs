// Build-time only. Keep Codex's version-matched helper separate from the system
// bubblewrap used by the technical-experiment executor. Do not change its flags.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Install the sandbox helper as root while building the Linux image.');
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve(`@openai/codex-linux-${process.arch}/package.json`));
const vendorRoot = join(packageRoot, 'vendor');
const candidates = readdirSync(vendorRoot).map(target => join(vendorRoot, target, 'codex-resources', 'bwrap')).filter(existsSync);
if (candidates.length !== 1) throw new Error('Expected exactly one bundled Codex sandbox helper.');
const target = '/opt/argus-codex-sandbox';
mkdirSync(target, { recursive: true, mode: 0o755 });
copyFileSync(candidates[0], join(target, 'bwrap'));
chmodSync(target, 0o755);
chmodSync(join(target, 'bwrap'), 0o755);
console.log('Installed version-matched Codex sandbox helper outside the writable application tree.');

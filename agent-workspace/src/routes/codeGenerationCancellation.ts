import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
export const CODEGEN_STORE = '/runtime/technical-experiments/code-generation';
export function assertCodegenNotCanceled(thread: string, store = CODEGEN_STORE) {
  if (existsSync(path.join(store, thread, 'canceled'))) throw Error('codegen_canceled');
}
export async function cancelCodegen(thread: string, store = CODEGEN_STORE) {
  const dir = path.join(store, thread);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const fd = await open(path.join(dir, 'canceled'), 'a', 0o600);
  try { await fd.sync(); } finally { await fd.close(); }
  const parent = await open(dir, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}

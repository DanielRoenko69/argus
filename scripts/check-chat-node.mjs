#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Intersection of the Chat Vite/plugin-react and Vitest engine requirements.
export const chatNodeRange = '^20.19.0 || ^22.12.0 || >=24.0.0';
export function supportsChatNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 24;
}
export const chatNodeGuidance = `Chat build/tests need Node ${chatNodeRange}. Activate a compatible Node version (for example Node 24) and retry; on macOS update Homebrew Node or your version manager.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (supportsChatNode(process.versions.node)) console.log(`Chat toolchain Node check passed: ${process.version}`);
  else { console.error(`${chatNodeGuidance} Found ${process.version}.`); process.exitCode = 1; }
}

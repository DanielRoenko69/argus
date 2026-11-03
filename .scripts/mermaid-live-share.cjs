#!/usr/bin/env node
// Extract all ```mermaid blocks from a Markdown file and print shareable
// https://mermaid.live URLs for each. Uses the pako (deflate) URL format
// which is the format mermaid.live currently produces from its UI.
const fs   = require('fs');
const zlib = require('zlib');

const file = process.argv[2];
if (!file) { console.error('Usage: node mermaid-live-share.js <file.md>'); process.exit(1); }

const md = fs.readFileSync(file, 'utf8');
const re = /```mermaid\s*\n([\s\S]*?)```/g;

const mermaidConfig = JSON.stringify({
  theme: 'dark',
  themeVariables: {
    background: '#141414',
    primaryColor: '#7c3aed',
    primaryTextColor: '#e8e8e8',
    lineColor: '#444',
    secondaryColor: '#3b82f6',
    tertiaryColor: '#10b981',
    clusterBkg: '#1a1a1a',
    clusterBorder: '#2a2a2a',
  },
});

function encode(code) {
  const state = {
    code,
    mermaid: mermaidConfig,
    autoSync: true,
    updateDiagram: true,
    panZoom: true,
    rough: false,
  };
  const json = JSON.stringify(state);
  const deflated = zlib.deflateSync(Buffer.from(json, 'utf8'));
  // base64url (RFC 4648 §5) — pako = URL-safe base64
  const b64 = deflated.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `https://mermaid.live/edit#pako:${b64}`;
}

// Find titles by scanning headings before each mermaid block
const lines = md.split(/\r?\n/);
const blocks = [];
let currentHeading = '';
let inBlock = false;
let buf = [];
let blockHeading = '';

for (const ln of lines) {
  const h = ln.match(/^#{1,4}\s+(.*)$/);
  if (h && !inBlock) currentHeading = h[1].trim();
  if (ln.trim() === '```mermaid') { inBlock = true; buf = []; blockHeading = currentHeading; continue; }
  if (inBlock && ln.trim() === '```') { blocks.push({ heading: blockHeading, code: buf.join('\n') }); inBlock = false; continue; }
  if (inBlock) buf.push(ln);
}

console.log(`Found ${blocks.length} mermaid block(s) in ${file}\n`);
blocks.forEach((b, i) => {
  console.log(`## ${i + 1}. ${b.heading}`);
  console.log(encode(b.code));
  console.log('');
});

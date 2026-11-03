import DOMPurify from 'dompurify';

let initialized = false;
let counter = 0;

/** Lazy-render a mermaid diagram to a sanitized SVG string. Throws on an invalid/partial diagram. */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  if (!initialized) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    initialized = true;
  }
  const { svg } = await mermaid.render(`mmd-${counter++}`, code);
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

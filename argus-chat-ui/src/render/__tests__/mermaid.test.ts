import { describe, it, expect, vi } from 'vitest';
const initialize = vi.fn();
const renderFn = vi.fn(async (_id: string, _code: string) => ({ svg: '<svg id="m"><script>alert(1)</script><g/></svg>' }));
vi.mock('mermaid', () => ({ default: { initialize, render: renderFn } }));
import { renderMermaid } from '../mermaid.js';

describe('renderMermaid', () => {
  it('initializes with securityLevel:strict and DOMPurifies the SVG', async () => {
    const out = await renderMermaid('graph TD; A-->B');
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict' }));
    expect(renderFn).toHaveBeenCalled();
    expect(out).toContain('<svg');
    expect(out).not.toContain('<script>');
  });
});

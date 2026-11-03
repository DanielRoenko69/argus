import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
vi.mock('../mermaid.js', () => ({ renderMermaid: vi.fn(async () => '<svg/>') }));
import { CodeBlock } from '../CodeBlock.js';

describe('CodeBlock artifact delegation', () => {
  it('delegates a mermaid fence to Artifact', () => {
    const { container } = render(<CodeBlock className="language-mermaid">{'graph TD; A-->B'}</CodeBlock>);
    expect(container.querySelector('.artifact')).not.toBeNull();
  });
  it('still highlights a normal code fence (hljs spans / escaped entities)', () => {
    const { container } = render(<CodeBlock className="language-javascript">{'const x = "<b>";'}</CodeBlock>);
    expect(container.querySelector('.artifact')).toBeNull();
    const code = container.querySelector('pre code')!;
    expect(code).not.toBeNull();
    // Proves highlight.js actually ran: either hljs token spans or escaped HTML (never a live <b>).
    expect(code.innerHTML).toMatch(/hljs-|&lt;/);
    expect(code.querySelector('b')).toBeNull();
  });
});

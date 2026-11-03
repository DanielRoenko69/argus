import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderMermaid } from '../mermaid.js';
vi.mock('../mermaid.js', () => ({ renderMermaid: vi.fn() }));
import { Artifact } from '../Artifact.js';

const mockMermaid = vi.mocked(renderMermaid);

describe('Artifact', () => {
  beforeEach(() => {
    mockMermaid.mockReset();
    mockMermaid.mockResolvedValue('<svg id="mmd"><g/></svg>');
  });

  it('html: defaults to Code; Preview shows a sandboxed iframe carrying the code; toggling back restores Code', () => {
    const code = '<b>hi</b><script>alert(1)</script>';
    const { container } = render(<Artifact lang="html" code={code} />);
    // default Code view: highlighted code, no iframe
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre.artifact-code code')).not.toBeNull();
    // → Preview: a sandboxed iframe (allow-scripts, NO same-origin) whose srcDoc IS the code
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    const f = container.querySelector('iframe')!;
    expect(f).not.toBeNull();
    expect(f.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(f.getAttribute('srcdoc')).toBe(code);
    // → back to Code: iframe gone, code shown again
    fireEvent.click(screen.getByRole('button', { name: /^code$/i }));
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('pre.artifact-code code')).not.toBeNull();
  });

  it('svg: preview DOMPurifies away <script>; Code view shows escaped markup', () => {
    const { container } = render(<Artifact lang="svg" code={'<svg><script>alert(1)</script><rect/></svg>'} />);
    // default preview: sanitized svg, no <script>
    expect(container.querySelector('.artifact-svg svg')).not.toBeNull();
    expect(container.querySelector('.artifact-svg script')).toBeNull();
    // → Code: the raw markup, hljs-escaped (no live tags)
    fireEvent.click(screen.getByRole('button', { name: /^code$/i }));
    expect(container.querySelector('.artifact-svg')).toBeNull();
    const codeEl = container.querySelector('pre.artifact-code code')!;
    expect(codeEl).not.toBeNull();
    expect(codeEl.innerHTML).toContain('&lt;');
    expect(codeEl.querySelector('script')).toBeNull();
  });

  it('mermaid: default Preview renders the sanitized SVG from renderMermaid + Copy present', async () => {
    const { container } = render(<Artifact lang="mermaid" code={'graph TD; A-->B'} />);
    await waitFor(() => expect(container.querySelector('.artifact-svg svg')).not.toBeNull());
    expect(mockMermaid).toHaveBeenCalledWith('graph TD; A-->B');
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('mermaid: a render error falls back to the Code view and shows the error note', async () => {
    mockMermaid.mockReset();
    mockMermaid.mockRejectedValue(new Error('invalid diagram'));
    const { container } = render(<Artifact lang="mermaid" code={'graph BROKEN'} />);
    await waitFor(() => expect(screen.getByText(/incomplete or invalid/i)).toBeInTheDocument());
    // fell back to Code view (no rendered svg, code shown)
    expect(container.querySelector('.artifact-svg svg')).toBeNull();
    expect(container.querySelector('pre.artifact-code code')).not.toBeNull();
  });
});

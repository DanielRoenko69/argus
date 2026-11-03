import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../Markdown';

describe('Markdown sanitization', () => {
  it('renders markdown but strips script/onerror payloads', () => {
    const { container } = render(
      <Markdown
        content={
          '# Hi\n\n<img src=x onerror=alert(1)>\n<script>alert(2)</script>\n\n```yaml\nkey: val\n```'
        }
      />
    );
    expect(container.querySelector('h1')?.textContent).toBe('Hi');
    expect(container.querySelector('script')).toBeNull();
    // react-markdown (no rehype-raw) never creates a live <img> from raw HTML in content —
    // the tag is rendered as escaped text. Either no img exists, or if it does it has no onerror.
    const img = container.querySelector('img');
    if (img !== null) {
      // If somehow an img was created, it must not have an onerror attribute
      expect(img.getAttribute('onerror')).toBeNull();
    } else {
      // The img tag was fully inert (rendered as text) — this is the safer outcome
      expect(img).toBeNull();
    }
    expect(container.querySelector('code')?.textContent).toContain('key: val');
  });

  it('renders javascript: links as inert text (no live href)', () => {
    const { container } = render(
      <Markdown content={'[click me](javascript:alert(1))'} />
    );
    const anchor = container.querySelector('a');
    // react-markdown strips javascript: hrefs — the link either has no href or a safe href
    if (anchor) {
      const href = anchor.getAttribute('href');
      expect(href).not.toMatch(/^javascript:/i);
    }
    // At minimum, no <script> injected
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders GFM tables without XSS', () => {
    const tableMarkdown = [
      '| Name | Value |',
      '|------|-------|',
      '| <script>bad()</script> | safe |',
    ].join('\n');
    const { container } = render(<Markdown content={tableMarkdown} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('renders inline code without executing content', () => {
    const { container } = render(
      <Markdown content={'Use `<script>alert(1)</script>` carefully'} />
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('code')?.textContent).toContain('<script>');
  });

  // Adversarial: code-fence XSS — hljs must escape < > & in the highlighted output
  it('hljs escapes </script><img onerror> inside a fenced block', () => {
    const { container } = render(
      <Markdown
        content={'```html\n</script><img src=x onerror=alert(1)>\n```'}
      />
    );
    // No live script or img-with-onerror in the DOM
    expect(container.querySelector('script')).toBeNull();
    const imgs = container.querySelectorAll('img');
    imgs.forEach(img => {
      expect(img.getAttribute('onerror')).toBeNull();
    });
    // The raw characters must have been HTML-escaped — the code element text
    // content should contain the angle-bracket characters (as text, not tags)
    const codeEl = container.querySelector('pre > code');
    expect(codeEl).not.toBeNull();
    // dangerouslySetInnerHTML was set — verify no onerror attribute reached the DOM
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  // Adversarial: crafted fence info string with injection characters
  it('crafted fence lang (injection chars in info string) stays inert', () => {
    // A fence like ```foo"><img onerror=1 — the lang becomes the className string
    // React sets className via DOM .className property (not innerHTML), so injection chars are inert
    const { container } = render(
      <Markdown content={'```foo"><img onerror=1\ncode here\n```'} />
    );
    // No live img with onerror should appear
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  // Adversarial: javascript: image src
  it('blocks javascript: protocol in markdown image src', () => {
    const { container } = render(
      <Markdown content={'![alt](javascript:alert(1))'} />
    );
    const img = container.querySelector('img');
    if (img) {
      const src = img.getAttribute('src');
      expect(src).not.toMatch(/^javascript:/i);
    }
    // No script injection
    expect(container.querySelector('script')).toBeNull();
  });

  // Adversarial: data: URI image
  it('blocks data: URI in markdown image src', () => {
    const { container } = render(
      <Markdown content={'![alt](data:text/html,<script>alert(1)</script>)'} />
    );
    const img = container.querySelector('img');
    if (img) {
      const src = img.getAttribute('src');
      expect(src).not.toMatch(/^data:/i);
    }
    expect(container.querySelector('script')).toBeNull();
  });

  // Adversarial: KaTeX \href with javascript: URL — trust:false (default) must block it
  it('KaTeX \\href{javascript:} is blocked (trust:false default)', () => {
    const { container } = render(
      <Markdown content={'$\\href{javascript:alert(1)}{click}$'} />
    );
    // No anchor with a javascript: href should appear
    const anchors = container.querySelectorAll('a');
    anchors.forEach(a => {
      expect(a.getAttribute('href')).not.toMatch(/^javascript:/i);
    });
    expect(container.querySelector('script')).toBeNull();
  });

  // Adversarial: HTML entity encoded javascript: link — micromark decodes before urlTransform
  it('HTML-entity encoded javascript: link is blocked', () => {
    const { container } = render(
      <Markdown content={'[x](javascript&#58;alert(1))'} />
    );
    const anchor = container.querySelector('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      expect(href).not.toMatch(/^javascript:/i);
    }
    expect(container.querySelector('script')).toBeNull();
  });

  // Adversarial: &lt;script&gt; entities round-trip — must not become live script tag
  it('HTML entities like &lt;script&gt; are rendered as text, not live tags', () => {
    const { container } = render(
      <Markdown content={'&lt;script&gt;alert(1)&lt;/script&gt;'} />
    );
    expect(container.querySelector('script')).toBeNull();
    // The paragraph text should contain the angle-bracket characters literally
    expect(container.textContent).toContain('<script>');
  });
});

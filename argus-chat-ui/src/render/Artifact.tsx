import { useState, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { highlightToHtml } from './highlight.js';
import { renderMermaid } from './mermaid.js';
import type { ArtifactLang } from './artifactLang.js';

export function Artifact({ lang, code }: { lang: ArtifactLang; code: string }) {
  // Passive renders (mermaid/svg) preview by default; active HTML defaults to Code (explicit run).
  const [view, setView] = useState<'code' | 'preview'>(lang === 'html' ? 'code' : 'preview');
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (view === 'preview' && lang === 'mermaid') {
      setErr(false);
      renderMermaid(code)
        .then((s) => { if (!cancelled) setSvg(s); })
        .catch(() => { if (!cancelled) { setErr(true); setView('code'); } });
    }
    return () => { cancelled = true; };
  }, [view, lang, code]);

  const copy = () => navigator.clipboard.writeText(code).catch(() => {});

  return (
    <div className="artifact">
      <div className="artifact-bar">
        <span className="artifact-lang">{lang}</span>
        <div className="artifact-actions">
          <button className={`artifact-tab${view === 'code' ? ' active' : ''}`} onClick={() => setView('code')}>Code</button>
          <button className={`artifact-tab${view === 'preview' ? ' active' : ''}`} onClick={() => setView('preview')}>Preview</button>
          <button className="artifact-copy" onClick={copy} aria-label="Copy code">Copy</button>
        </div>
      </div>
      {err && <div className="artifact-error">Diagram is incomplete or invalid.</div>}
      {view === 'code' ? (
        <pre className="artifact-code">
          {/* eslint-disable-next-line react/no-danger */}
          <code dangerouslySetInnerHTML={{ __html: highlightToHtml(code, lang) }} />
        </pre>
      ) : lang === 'html' ? (
        <div className="artifact-frame-wrap">
          <iframe className="artifact-frame" srcDoc={code} sandbox="allow-scripts" title="HTML-Artifact" />
        </div>
      ) : lang === 'svg' ? (
        // eslint-disable-next-line react/no-danger
        <div className="artifact-svg" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />
      ) : (
        // mermaid: svg already DOMPurified inside renderMermaid
        // eslint-disable-next-line react/no-danger
        <div className="artifact-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  );
}

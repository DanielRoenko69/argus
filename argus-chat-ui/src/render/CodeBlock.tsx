import { type ComponentPropsWithoutRef } from 'react';
import { highlightToHtml } from './highlight.js';
import { isArtifactLang } from './artifactLang.js';
import { Artifact } from './Artifact.js';

// Props passed by react-markdown for the `code` component slot
type CodeProps = ComponentPropsWithoutRef<'code'> & {
  // react-markdown sets className="language-xxx" for fenced blocks
  className?: string;
  // inline is true when the code is inside a paragraph (not a fenced block)
  // react-markdown v9 passes this as a boolean attribute via the node
  // We detect inline by checking parent context via className absence
  children?: React.ReactNode;
};

function isInlineCode(className: string | undefined, children: React.ReactNode): boolean {
  // Fenced blocks always have a "language-*" class; inline code never does
  if (className && /^language-/.test(className)) return false;
  // Also consider it block if the content has newlines
  if (typeof children === 'string' && children.includes('\n')) return false;
  return true;
}

function getCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(getCodeText).join('');
  return '';
}

export function CodeBlock({ className, children, node: _node, ...rest }: CodeProps & { node?: unknown }) {
  const codeText = getCodeText(children).replace(/\n$/, '');

  if (isInlineCode(className, children)) {
    return <code className={className} {...rest}>{children}</code>;
  }

  // Extract language from "language-xxx" class
  const langMatch = className?.match(/^language-(.+)/);
  const lang = langMatch ? langMatch[1] : undefined;

  if (isArtifactLang(lang)) {
    return <Artifact lang={lang} code={codeText} />;
  }

  const highlighted = highlightToHtml(codeText, lang);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText).catch(() => {/* ignore */});
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        style={{
          position: 'absolute',
          top: '0.4rem',
          right: '0.4rem',
          padding: '0.2rem 0.5rem',
          fontSize: '0.7rem',
          cursor: 'pointer',
          background: 'rgba(255,255,255,0.1)',
          color: '#ccc',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '4px',
        }}
      >
        Copy
      </button>
      <pre>
        {/*
          dangerouslySetInnerHTML is safe here: highlight.js escapes all
          HTML special characters in user input before adding <span class>
          markup. No raw LLM/user content ever reaches the DOM unescaped.
        */}
        <code
          className={className}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

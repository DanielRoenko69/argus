import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CodeBlock } from './CodeBlock';

// SECURITY NOTE:
// - rehype-raw is intentionally NOT used. react-markdown's default pipeline
//   escapes raw HTML in LLM output (untrusted), so <script> and <img onerror>
//   are rendered as inert text, never as live DOM nodes.
// - The only dangerouslySetInnerHTML in this render path lives in CodeBlock,
//   where highlight.js output is used — hljs escapes all input before emitting
//   <span class> markup, so it is safe.
// - If you ever add a rehype-raw path or any other dangerouslySetInnerHTML,
//   you MUST DOMPurify the content first.

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{ code: CodeBlock as never }}
    >
      {content}
    </ReactMarkdown>
  );
}

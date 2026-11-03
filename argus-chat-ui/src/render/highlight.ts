// The full Highlight.js distribution registers every supported language and
// bloats the chat's initial bundle. `lib/common` retains the languages a
// developer-facing Argus response normally needs while keeping unknown input
// safely handled by highlightAuto().
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';

/** Highlight code → HTML string. hljs escapes all input before emitting <span class> markup, so the
 *  result is safe to inject (the only reason the result is HTML is the syntax-coloring spans). */
export function highlightToHtml(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  return hljs.highlightAuto(code).value;
}

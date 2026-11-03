import { useState } from 'react';
import type { Citation } from '../data-provider/types.js';

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const label = (s: string) => (s ? (isUrl(s) ? s : s.split(/[\\/]/).pop() || s) : 'Quelle');

export function Citations({ items }: { items: Citation[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="citations">
      <div className="citations-title">Sources</div>
      <div className="citations-list">
        {items.map((c, i) => (
          <div key={i} className="citation">
            <button
              className="citation-chip"
              onClick={() => setOpen(open === i ? null : i)}
              title={c.source || c.index}
            >
              <span className="citation-idx">{c.index}</span>
              <span className="citation-src">{label(c.source)}</span>
              <span className="citation-score">{c.score.toFixed(2)}</span>
            </button>
            {open === i && (
              <div className="citation-snippet">
                {c.snippet}
                {isUrl(c.source) && (
                  <div>
                    <a href={c.source} target="_blank" rel="noopener noreferrer" className="citation-link">Open ↗</a>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

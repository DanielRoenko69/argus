import { useState, useRef, useEffect } from 'react';
import { useMyShares, useCreateShare, useRevokeShare } from '../data-provider/hooks.js';

interface Props { agentId: number; sid: string }

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ShareModal({ agentId, sid }: Props) {
  const [open, setOpen] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const [password, setPassword] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { data: shares } = useMyShares(open);
  const createShare = useCreateShare(agentId, sid);
  const revokeShare = useRevokeShare();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function handleShare() {
    setError(null);
    try {
      const res = await createShare.mutateAsync({ expiryDays, password: password || undefined });
      setUrl(res.url);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="share-panel" ref={ref}>
      <button type="button" className="share-toggle" aria-label="Share conversation" aria-expanded={open}
        title="Share conversation" onClick={() => { setOpen((o) => !o); setUrl(null); setError(null); }}>
        🔗 Share
      </button>
      {open && (
        <div className="share-popover" role="dialog" aria-label="Share conversation">
          <div className="share-row">
            <label className="share-label" htmlFor="share-expiry">Expires</label>
            <select id="share-expiry" className="share-select" aria-label="Expires"
              value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))}>
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
          <div className="share-row">
            <label className="share-label" htmlFor="share-pw">Password</label>
            <input id="share-pw" type="password" className="share-num" placeholder="optional"
              aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <button type="button" className="share-create" onClick={handleShare} disabled={createShare.isPending}>Share</button>
          {error && <p className="share-error">{error}</p>}
          {url && (
            <div className="share-result">
              <input className="share-url" readOnly value={url} aria-label="Shared link"
                onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="share-copy" onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>
              <div className="share-note">Visible once — copy it now.</div>
            </div>
          )}

          <div className="share-list-head">Shared links</div>
          <div className="share-list">
            {(!shares || shares.length === 0) && <div className="share-empty">No shared links.</div>}
            {shares?.map((s) => (
              <div key={s.id} className="share-item">
                <div className="share-item-meta">
                  <span className="share-item-title">{s.title || 'Shared conversation'}{s.hasPassword ? ' 🔒' : ''}</span>
                  <span className="share-item-exp">expires {formatDate(s.expires_at)}</span>
                </div>
                <button type="button" className="share-revoke" aria-label="Revoke share"
                  onClick={() => revokeShare.mutateAsync(s.id)}>Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

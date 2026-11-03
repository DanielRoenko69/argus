function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SHELL = (title: string, body: string): string =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex,nofollow">` +
  `<title>${esc(title)} · Argus</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;background:#0f1117;color:#e5e7eb}` +
  `.bubble{border-radius:10px;padding:.6rem .9rem;margin:.5rem 0;white-space:pre-wrap;word-break:break-word}` +
  `.user{background:#1e293b}.assistant{background:#15212e}.role{font-size:.7rem;text-transform:uppercase;color:#94a3b8;margin-bottom:.2rem}` +
  `pre{background:#0b0e14;padding:.6rem;border-radius:6px;overflow:auto}.foot{color:#64748b;font-size:.75rem;margin-top:1.5rem;border-top:1px solid #1e293b;padding-top:.6rem}</style>` +
  `</head><body>${body}</body></html>`;

function renderContent(content: string): string {
  // Split out ```code fences``` into <pre>; everything escaped. No markdown→HTML (XSS-safe).
  const parts = content.split(/```/);
  return parts.map((p, i) => (i % 2 === 1 ? `<pre>${esc(p)}</pre>` : esc(p))).join('');
}

export function renderSharePage(share: { title: string; expires_at: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): string {
  const body =
    `<h2>${esc(share.title || 'Geteilte Konversation')}</h2>` +
    share.messages.map((m) =>
      `<div class="bubble ${m.role}"><div class="role">${m.role === 'user' ? 'Du' : 'Assistant'}</div>${renderContent(m.content)}</div>`,
    ).join('') +
    `<div class="foot">Schreibgeschützt · PII-redaktiert · läuft ab am ${esc(new Date(share.expires_at).toLocaleString('de-DE'))}</div>`;
  return SHELL(share.title || 'Geteilte Konversation', body);
}

export function renderPasswordGate(token: string, error?: string): string {
  const body =
    `<h2>Passwort erforderlich</h2>` +
    (error ? `<p style="color:#fca5a5">${esc(error)}</p>` : '') +
    `<form method="POST" action="/share/${esc(token)}/unlock">` +
    `<input type="password" name="password" placeholder="Passwort" autofocus style="padding:.5rem;border-radius:6px;border:1px solid #334155;background:#0b0e14;color:#e5e7eb">` +
    `<button type="submit" style="margin-left:.5rem;padding:.5rem .9rem;border-radius:6px;border:0;background:#6366f1;color:#fff">Ansehen</button></form>`;
  return SHELL('Geschützt', body);
}

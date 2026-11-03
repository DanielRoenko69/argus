import { CSS_VARS } from '../shared/navHtml.js';

export function renderLoginHtml(options: {
  error?: string;
  registrationMode?: boolean;
  success?: string;
  entraSsoEnabled?: boolean;
  ssoProviderName?: string;
  ssoProvider?: 'entra' | 'generic_oidc';
  localAuthEnabled?: boolean;
}): string {
  const {
    error,
    registrationMode,
    success,
    entraSsoEnabled,
    ssoProviderName = 'Microsoft',
    ssoProvider = 'entra',
    localAuthEnabled = true,
  } = options;

  const title = registrationMode ? 'Argus – Registrierung' : 'Argus – Anmelden';
  const heading = registrationMode ? 'Ersten Administrator anlegen' : 'Anmelden';
  const submitLabel = registrationMode ? 'Registrieren' : 'Anmelden';
  const action = registrationMode ? '/auth/register' : '/auth/login';

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    ${CSS_VARS}
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo {
      text-align: center;
      margin-bottom: 1.5rem;
    }
    .logo h1 {
      font-size: 1.6rem;
      font-weight: 600;
      color: var(--accent-light);
    }
    .logo p {
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 500;
      margin-bottom: 1.5rem;
      text-align: center;
      color: var(--text);
    }
    .form-group {
      margin-bottom: 1rem;
    }
    label {
      display: block;
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-bottom: 0.35rem;
      font-weight: 500;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.75rem;
      background: var(--bg-input);
      border: 1px solid var(--border-mid);
      border-radius: 6px;
      color: var(--text);
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .btn {
      display: block;
      width: 100%;
      padding: 0.65rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      margin-top: 1.25rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #6d28d9; }
    .error {
      background: rgba(248,81,73,0.08);
      border: 1px solid var(--red);
      color: var(--red);
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.82rem;
      margin-bottom: 1rem;
    }
    .success {
      background: rgba(63,185,80,0.08);
      border: 1px solid var(--green-dim);
      color: var(--green);
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.82rem;
      margin-bottom: 1rem;
    }
    .hint {
      text-align: center;
      font-size: 0.78rem;
      color: var(--text-muted);
      margin-top: 1rem;
    }
    .sso-section { margin-top: 0.5rem; }
    .sso-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.6rem;
      width: 100%;
      padding: 0.65rem;
      background: #2f2f2f;
      color: #fff;
      border: 1px solid var(--border-mid);
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s, border-color 0.2s;
    }
    .sso-btn:hover { background: #3a3a3a; border-color: var(--accent); }
    .sso-btn svg { width: 18px; height: 18px; flex-shrink: 0; }
    .divider {
      display: flex;
      align-items: center;
      margin: 1.25rem 0;
      font-size: 0.78rem;
      color: var(--text-muted);
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }
    .divider span { padding: 0 0.75rem; }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <img src="/assets/logo.png" alt="Argus" style="height: 56px;">
    </div>
    <h2>${heading}</h2>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    ${success ? `<div class="success">${esc(success)}</div>` : ''}
    ${entraSsoEnabled && !registrationMode ? `
    <div class="sso-section">
      <a href="/auth/oidc/login" class="sso-btn">
        ${ssoProvider === 'entra' ? `
        <svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="11" height="11" fill="#f25022"/>
          <rect x="12" y="0" width="11" height="11" fill="#7fba00"/>
          <rect x="0" y="12" width="11" height="11" fill="#00a4ef"/>
          <rect x="12" y="12" width="11" height="11" fill="#ffb900"/>
        </svg>
        ` : `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path fill="currentColor" d="M12 2 4 5.5v5.8c0 5.1 3.4 9.8 8 10.7 4.6-.9 8-5.6 8-10.7V5.5L12 2Zm0 3.1 5 2.2v4c0 3.5-2.1 6.9-5 7.7-2.9-.8-5-4.2-5-7.7v-4l5-2.2Zm0 2.4a2.7 2.7 0 0 0-2.7 2.7c0 .8.3 1.5.8 2a4.1 4.1 0 0 0-1.6 3.2h7a4.1 4.1 0 0 0-1.6-3.2c.5-.5.8-1.2.8-2A2.7 2.7 0 0 0 12 7.5Z"/>
        </svg>
        `}
        Mit ${esc(ssoProviderName)} anmelden
      </a>
    </div>
    ${localAuthEnabled ? '<div class="divider"><span>oder</span></div>' : ''}
    ` : ''}
    ${localAuthEnabled || registrationMode ? `
    <form method="POST" action="${action}">
      <div class="form-group">
        <label for="username">Benutzername</label>
        <input type="text" id="username" name="username" required autocomplete="username" autofocus>
      </div>
      ${registrationMode ? `
      <div class="form-group">
        <label for="display_name">Anzeigename</label>
        <input type="text" id="display_name" name="display_name" required>
      </div>` : ''}
      <div class="form-group">
        <label for="password">Passwort</label>
        <input type="password" id="password" name="password" required autocomplete="${registrationMode ? 'new-password' : 'current-password'}" minlength="8">
      </div>
      ${registrationMode ? `
      <div class="form-group">
        <label for="password_confirm">Passwort wiederholen</label>
        <input type="password" id="password_confirm" name="password_confirm" required autocomplete="new-password" minlength="8">
      </div>` : ''}
      <button type="submit" class="btn">${submitLabel}</button>
    </form>
    ` : ''}
    ${registrationMode ? '<p class="hint">Der erste Benutzer erhaelt automatisch die Admin-Rolle.</p>' : ''}
  </div>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

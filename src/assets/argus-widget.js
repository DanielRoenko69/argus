/**
 * argus-widget.js — floating bubble chat widget loader
 *
 * Internal mode (authenticated, same-origin):
 *   <script src="/assets/argus-widget.js"
 *           data-agent-id="42"
 *           data-accent="#7c3aed"
 *           data-title="Chat"
 *           data-greeting="Hello! How can we help?"
 *           data-placeholder="Ask a question..."
 *           data-icon-url="/brand/assistant.png"
 *           data-icon-alt="Company assistant"
 *           data-position="right">
 *   </script>
 *
 * Public mode (anonymous, cross-origin iframe):
 *   <script src="https://argus.example/assets/argus-widget.js"
 *           data-slug="my-widget"
 *           data-argus-origin="https://argus.example"
 *           data-accent="#7c3aed"
 *           data-title="Chat"
 *           data-greeting="Hello! How can we help?"
 *           data-placeholder="Ask a question..."
 *           data-icon-url="/brand/assistant.png"
 *           data-icon-alt="Company assistant"
 *           data-position="right">
 *   </script>
 *
 * Config attributes:
 *   Internal mode (data-agent-id required):
 *     data-agent-id   — required; numeric agent ID
 *   Public mode (data-slug + data-argus-origin required):
 *     data-slug        — widget slug (configured in Argus admin)
 *     data-argus-origin — full origin of the Argus server, e.g. https://argus.example
 *   Common (all optional):
 *     data-accent     — bubble/panel accent color (default #111318)
 *     data-title      — aria label + panel title     (default 'Chat')
 *     data-greeting   — optional welcome message     (max 500 characters)
 *     data-placeholder — optional composer text      (max 160 characters)
 *     data-icon-url   — optional HTTP(S) launcher image (relative URLs allowed)
 *     data-icon-alt   — launcher image alternative text
 *     data-position   — 'right' or 'left'            (default 'right')
 *
 * Internal mode: iframe src is same-origin-relative (/embed/chat/<agentId>).
 * Public mode:   iframe src is <argusOrigin>/public/widget/<slug>.
 *   The iframe handles all token management internally — the host page never
 *   sees the widget token. The browser-enforced frame-ancestors CSP on the
 *   Argus page controls which hosts may embed; no token handling in the loader.
 *
 * The iframe is lazy-loaded: src is set only on first open.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return; // safety guard — shouldn't happen for a normal <script> tag

  // ── Detect mode ─────────────────────────────────────────────────────────────
  var slug        = script.getAttribute('data-slug');
  var argusOrigin = script.getAttribute('data-argus-origin');
  var isPublicMode = !!(slug && argusOrigin);

  // ── Read config from the script tag ────────────────────────────────────────

  // Internal mode: validate agentId
  var agentId;
  if (!isPublicMode) {
    agentId = script.getAttribute('data-agent-id');
    if (!agentId || isNaN(Number(agentId))) {
      console.warn('[argus-widget] data-agent-id is required and must be a number (internal mode). Widget not loaded.');
      return;
    }
  }

  // Public mode: validate slug + argusOrigin
  if (isPublicMode) {
    if (!slug || !argusOrigin) {
      console.warn('[argus-widget] data-slug and data-argus-origin are both required for public mode. Widget not loaded.');
      return;
    }
    // Only absolute HTTP(S) origins are accepted. Paths, credentials and
    // script-capable schemes never become an iframe source.
    try {
      var parsedArgusOrigin = new URL(argusOrigin);
      if (parsedArgusOrigin.protocol !== 'https:' && parsedArgusOrigin.protocol !== 'http:') throw new Error('unsupported protocol');
      if (parsedArgusOrigin.username || parsedArgusOrigin.password) throw new Error('credentials are not allowed');
      if ((parsedArgusOrigin.pathname && parsedArgusOrigin.pathname !== '/') || parsedArgusOrigin.search || parsedArgusOrigin.hash) throw new Error('origin must not contain a path, query or fragment');
      argusOrigin = parsedArgusOrigin.origin;
    } catch(e) {
      console.warn('[argus-widget] data-argus-origin is not a valid URL. Widget not loaded.');
      return;
    }
    if (!/^[a-z0-9_-]{1,128}$/.test(slug)) {
      console.warn('[argus-widget] data-slug is invalid. Widget not loaded.');
      return;
    }
  }

  function boundedAttribute(name, fallback, maxLength) {
    var value = script.getAttribute(name);
    if (!value) return fallback;
    value = value.trim();
    return value && value.length <= maxLength ? value : fallback;
  }

  var accent   = boundedAttribute('data-accent', '#111318', 7);
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) accent = '#111318';
  var title    = boundedAttribute('data-title', 'Chat', 80);
  var greeting = boundedAttribute('data-greeting', '', 500);
  var placeholder = boundedAttribute('data-placeholder', '', 160);
  var iconAlt = boundedAttribute('data-icon-alt', title, 120);
  var iconUrl = null;
  var rawIconUrl = boundedAttribute('data-icon-url', '', 2048);
  if (rawIconUrl) {
    try {
      var parsedIconUrl = new URL(rawIconUrl, document.baseURI);
      if (parsedIconUrl.protocol !== 'https:' && parsedIconUrl.protocol !== 'http:') throw new Error('unsupported protocol');
      if (parsedIconUrl.username || parsedIconUrl.password) throw new Error('credentials are not allowed');
      iconUrl = parsedIconUrl.href;
    } catch (e) {
      console.warn('[argus-widget] data-icon-url is not a valid HTTP(S) URL. Using the default icon.');
    }
  }
  var position = script.getAttribute('data-position') || 'right';

  var SIDE   = position === 'left' ? 'left' : 'right';
  var PREFIX = 'argus-widget-';

  // ── Inject styles ────────────────────────────────────────────────────────────
  var css = [
    '.' + PREFIX + 'bubble {',
    '  position: fixed;',
    '  bottom: 20px;',
    '  ' + SIDE + ': 20px;',
    '  width: 56px;',
    '  height: 56px;',
    '  border-radius: 50%;',
    '  background: ' + accent + ';',
    '  color: #fff;',
    '  border: none;',
    '  cursor: pointer;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  font-size: 22px;',
    '  box-shadow: 0 4px 18px rgba(0,0,0,0.28);',
    '  z-index: 2147483646;',
    '  transition: transform 0.15s, box-shadow 0.15s;',
    '  outline: none;',
    '  font-family: sans-serif;',
    '}',
    '.' + PREFIX + 'bubble:hover {',
    '  transform: scale(1.07);',
    '  box-shadow: 0 6px 22px rgba(0,0,0,0.35);',
    '}',
    '.' + PREFIX + 'bubble-image {',
    '  width: 100%;',
    '  height: 100%;',
    '  object-fit: cover;',
    '  border-radius: inherit;',
    '  display: block;',
    '}',
    '.' + PREFIX + 'panel {',
    '  position: fixed;',
    '  bottom: 88px;',
    '  ' + SIDE + ': 20px;',
    '  width: 380px;',
    '  height: 560px;',
    '  border-radius: 14px;',
    '  overflow: hidden;',
    '  box-shadow: 0 8px 40px rgba(0,0,0,0.32);',
    '  z-index: 2147483645;',
    '  display: none;',
    '  flex-direction: column;',
    '  background: #0f0f0f;',
    '  border: 1px solid rgba(255,255,255,0.08);',
    '}',
    '.' + PREFIX + 'panel.' + PREFIX + 'open {',
    '  display: flex;',
    '}',
    '.' + PREFIX + 'iframe {',
    '  width: 100%;',
    '  height: 100%;',
    '  border: none;',
    '  display: block;',
    '  border-radius: 14px;',
    '}',
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.id = PREFIX + 'styles';
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ── Build panel ──────────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.className = PREFIX + 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  panel.setAttribute('aria-modal', 'true');

  var iframe = document.createElement('iframe');
  iframe.className = PREFIX + 'iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  iframe.setAttribute('title', title);
  // src is set lazily on first open
  panel.appendChild(iframe);
  document.body.appendChild(panel);

  // ── Build bubble button ──────────────────────────────────────────────────────
  var bubble = document.createElement('button');
  bubble.className = PREFIX + 'bubble';
  bubble.setAttribute('aria-label', title);
  bubble.setAttribute('aria-expanded', 'false');
  bubble.setAttribute('aria-controls', PREFIX + 'panel');
  panel.id = PREFIX + 'panel';
  var chatGlyph = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 2C6.477 2 2 6.163 2 11.333c0 2.742 1.23 5.21 3.2 6.934L4 21l4.267-1.6A10.8 10.8 0 0 0 12 20.667C17.523 20.667 22 16.503 22 11.333S17.523 2 12 2Z" fill="currentColor"/></svg>';
  var closeGlyph = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function renderLauncher(open) {
    if (open) {
      bubble.innerHTML = closeGlyph;
      return;
    }
    if (!iconUrl) {
      bubble.innerHTML = chatGlyph;
      return;
    }
    bubble.replaceChildren();
    var image = document.createElement('img');
    image.className = PREFIX + 'bubble-image';
    image.src = iconUrl;
    image.alt = iconAlt;
    image.addEventListener('error', function () {
      iconUrl = null;
      bubble.innerHTML = chatGlyph;
    }, { once: true });
    bubble.appendChild(image);
  }

  renderLauncher(false);

  document.body.appendChild(bubble);

  // ── State ────────────────────────────────────────────────────────────────────
  var isOpen = false;
  var iframeLoaded = false;

  function openPanel() {
    if (!iframeLoaded) {
      if (isPublicMode) {
        // Public mode: open the Argus-served public widget page.
        // The iframe manages its own token lifecycle internally (ensureSession).
        // The host page never handles tokens — they live inside the iframe sandbox.
        // frame-ancestors CSP on the Argus page controls who may embed.
        var publicUrl = new URL('/public/widget/' + encodeURIComponent(slug), argusOrigin);
        publicUrl.searchParams.set('accent', accent);
        publicUrl.searchParams.set('title', title);
        if (greeting) publicUrl.searchParams.set('greeting', greeting);
        if (placeholder) publicUrl.searchParams.set('placeholder', placeholder);
        iframe.src = publicUrl.href;
      } else {
        // Internal mode: same-origin relative URL (requires auth cookie)
        iframe.src = '/embed/chat/' + agentId;
      }
      iframeLoaded = true;
    }
    isOpen = true;
    panel.classList.add(PREFIX + 'open');
    bubble.setAttribute('aria-expanded', 'true');
    // Switch to close glyph (✕)
    renderLauncher(true);
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove(PREFIX + 'open');
    bubble.setAttribute('aria-expanded', 'false');
    // Switch back to chat glyph
    renderLauncher(false);
  }

  // ── Toggle on bubble click ───────────────────────────────────────────────────
  bubble.addEventListener('click', function () {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  });

  // ── Close on Escape ──────────────────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (isOpen && (e.key === 'Escape' || e.key === 'Esc')) {
      closePanel();
      bubble.focus();
    }
  });
})();

import { chatCoreCss, chatCoreScript, chatCoreMarkup } from '../chatCore.js';

describe('chatCoreCss', () => {
  it('is a non-empty string', () => {
    expect(typeof chatCoreCss).toBe('string');
    expect(chatCoreCss.length).toBeGreaterThan(0);
  });

  it('contains chat layout rules', () => {
    expect(chatCoreCss).toContain('.agents-root');
    expect(chatCoreCss).toContain('.chat-messages');
    expect(chatCoreCss).toContain('.chat-input-wrap');
  });
});

describe('chatCoreScript', () => {
  const fullOpts = {
    authMode: 'session' as const,
    features: { sessions: true, attachments: true, modelOverride: true },
    sessionsApiBase: '/api/agents',
    agentsJson: '[]',
  };

  it('returns a non-empty string', () => {
    const script = chatCoreScript(fullOpts);
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('contains the markdown renderer', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).toContain('renderMarkdown');
  });

  it('contains SSE/fetch call to /sessions/', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).toContain('/sessions/');
  });

  it('uses sessionsApiBase in fetch calls', () => {
    const script = chatCoreScript({ ...fullOpts, sessionsApiBase: '/api/agents' });
    expect(script).toContain('/api/agents');
  });

  it('contains session-sidebar marker when sessions feature is true', () => {
    const script = chatCoreScript(fullOpts);
    // The session area is wired via loadSessions() / renderSessionList()
    expect(script).toContain('loadSessions');
    expect(script).toContain('sessionList');
  });

  it('omits session-sidebar wiring when sessions feature is false', () => {
    const script = chatCoreScript({
      ...fullOpts,
      features: { ...fullOpts.features, sessions: false },
    });
    expect(script).not.toContain('loadSessions');
    expect(script).not.toContain('sessionList');
  });

  it('contains attachment wiring when attachments feature is true', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).toContain('attachBtn');
  });

  it('omits attachment wiring when attachments feature is false', () => {
    const script = chatCoreScript({
      ...fullOpts,
      features: { ...fullOpts.features, attachments: false },
    });
    expect(script).not.toContain('attachBtn');
  });

  it('contains model-override wiring when modelOverride feature is true', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).toContain('modelDisplay');
  });

  it('omits model-override wiring when modelOverride feature is false', () => {
    const script = chatCoreScript({
      ...fullOpts,
      features: { ...fullOpts.features, modelOverride: false },
    });
    expect(script).not.toContain('modelDisplay');
  });

  it('does not include wrapping <script> tags', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).not.toMatch(/<script/i);
    expect(script).not.toMatch(/<\/script>/i);
  });

  it('authMode session: has no public-token stub active', () => {
    const script = chatCoreScript(fullOpts);
    // The session mode should use cookie auth (credentials: same-origin)
    expect(script).toContain("credentials:'same-origin'");
  });

  // ── Embed surface (sessions:false) lifecycle tests ───────────────────────────
  const embedOpts = {
    authMode: 'session' as const,
    features: { sessions: false, attachments: true, modelOverride: false },
    sessionsApiBase: '/api/agents',
    agentsJson: '[]',
  };

  it('embed (sessions:false): contains function newSession so currentSessionId can be set', () => {
    const script = chatCoreScript(embedOpts);
    expect(script).toContain('function newSession');
  });

  it('embed (sessions:false): newSession POSTs to /sessions to create a session', () => {
    const script = chatCoreScript(embedOpts);
    // Must contain POST create call for a session
    expect(script).toMatch(/method\s*:\s*['"]POST['"]/);
    expect(script).toContain('/sessions');
  });

  it('embed (sessions:false): selectAgent calls newSession so embed can actually send', () => {
    const script = chatCoreScript(embedOpts);
    // The false-branch of selectAgent must call newSession()
    expect(script).toContain('newSession()');
  });

  it('embed (sessions:false): omits session-list sidebar renderer function body (getElementById sessionList)', () => {
    const script = chatCoreScript(embedOpts);
    // renderSessionList function body references getElementById('sessionList') — sidebar-only
    expect(script).not.toContain("getElementById('sessionList')");
  });

  it('embed (sessions:false): omits loadSessions (sidebar history fetch)', () => {
    const script = chatCoreScript(embedOpts);
    expect(script).not.toContain('loadSessions');
  });

  it('embed (sessions:false): omits handleSessionClick / handleSessionDelete (sidebar handlers)', () => {
    const script = chatCoreScript(embedOpts);
    expect(script).not.toContain('handleSessionClick');
    expect(script).not.toContain('handleSessionDelete');
  });

  it('embed (sessions:false): omits loadSession (sidebar history load)', () => {
    const script = chatCoreScript(embedOpts);
    expect(script).not.toContain('function loadSession');
  });

  it('sessions:true still contains sidebar renderer and loadSessions', () => {
    const script = chatCoreScript(fullOpts);
    expect(script).toContain('renderSessionList');
    expect(script).toContain('loadSessions');
    expect(script).toContain("getElementById('sessionList')");
  });
});

describe('chatCoreMarkup', () => {
  const fullFeatures = { sessions: true, attachments: true, modelOverride: true };

  it('returns a non-empty string', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(typeof markup).toBe('string');
    expect(markup.length).toBeGreaterThan(0);
  });

  it('contains #agentList when showAgentList:true', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup).toContain('id="agentList"');
  });

  it('omits #agentList when showAgentList:false', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: false });
    expect(markup).not.toContain('id="agentList"');
  });

  it('contains #sessionArea and #sessionList when sessions:true', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup).toContain('id="sessionArea"');
    expect(markup).toContain('id="sessionList"');
  });

  it('omits #sessionArea and #sessionList when sessions:false', () => {
    const markup = chatCoreMarkup({
      features: { ...fullFeatures, sessions: false },
      showAgentList: true,
    });
    expect(markup).not.toContain('id="sessionArea"');
    expect(markup).not.toContain('id="sessionList"');
  });

  it('contains #attachBtn, #fileInput, #attachBar when attachments:true', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup).toContain('id="attachBtn"');
    expect(markup).toContain('id="fileInput"');
    expect(markup).toContain('id="attachBar"');
  });

  it('omits #attachBtn, #fileInput, #attachBar when attachments:false', () => {
    const markup = chatCoreMarkup({
      features: { ...fullFeatures, attachments: false },
      showAgentList: true,
    });
    expect(markup).not.toContain('id="attachBtn"');
    expect(markup).not.toContain('id="fileInput"');
    expect(markup).not.toContain('id="attachBar"');
  });

  it('contains #modelDisplay and #modelOverrideHint when modelOverride:true', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup).toContain('id="modelDisplay"');
    expect(markup).toContain('id="modelOverrideHint"');
  });

  it('omits #modelDisplay and #modelOverrideHint when modelOverride:false', () => {
    const markup = chatCoreMarkup({
      features: { ...fullFeatures, modelOverride: false },
      showAgentList: true,
    });
    expect(markup).not.toContain('id="modelDisplay"');
    expect(markup).not.toContain('id="modelOverrideHint"');
  });

  it('always contains core IDs regardless of feature flags', () => {
    const markup = chatCoreMarkup({
      features: { sessions: false, attachments: false, modelOverride: false },
      showAgentList: false,
    });
    const alwaysPresent = [
      'chatPlaceholder', 'chatMain', 'chatAgentName', 'chatAgentModel',
      'chatHeaderDot', 'chatMessages', 'chatInput', 'chatInputBox',
      'sendBtn', 'settingsPanel', 'settingsToggleBtn', 'settingsPanelBody',
    ];
    for (const id of alwaysPresent) {
      expect(markup).toContain(`id="${id}"`);
    }
  });

  it('renders a customer-facing shell without operator controls and with branded copy', () => {
    const markup = chatCoreMarkup({
      features: { sessions: false, attachments: false, modelOverride: false },
      showAgentList: false,
      visitorMode: true,
      welcomeMessage: 'Welcome <visitor>',
      inputPlaceholder: 'Ask us anything',
    });
    expect(markup).not.toContain('id="settingsToggleBtn"');
    expect(markup).not.toContain('id="settingsPanel"');
    expect(markup).not.toContain('class="chat-header-actions"');
    expect(markup).not.toContain('Neue Session');
    expect(markup).not.toContain('Drag &amp; Drop');
    expect(markup).toContain('Welcome &lt;visitor&gt;');
    expect(markup).toContain('placeholder="Ask us anything"');
  });

  it('agents-root wraps everything', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup.trim()).toMatch(/class="agents-root"/);
  });

  it('renders a visible AI interaction notice by default', () => {
    const markup = chatCoreMarkup({ features: fullFeatures, showAgentList: true });
    expect(markup).toContain('aria-label="AI interaction notice"');
    expect(markup).toContain('You are interacting with an AI agent');
  });

  it('supports reviewed disclosure text, escapes it, and allows explicit disablement', () => {
    const custom = chatCoreMarkup({
      features: fullFeatures,
      showAgentList: true,
      aiTransparency: { enabled: true, notice: 'AI <notice> & review' },
    });
    expect(custom).toContain('AI &lt;notice&gt; &amp; review');
    expect(custom).not.toContain('AI <notice>');

    const disabled = chatCoreMarkup({
      features: fullFeatures,
      showAgentList: true,
      aiTransparency: { enabled: false, notice: 'hidden' },
    });
    expect(disabled).not.toContain('aria-label="AI interaction notice"');
    expect(disabled).not.toContain('hidden');
  });
});

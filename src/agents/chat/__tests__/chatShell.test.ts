import { renderChatShell, renderEmbedChat } from '../chatShell.js';

const agents = [
  { id: 1, label: 'Support Bot', model: 'gpt-5.6-terra', visibility: 'public' },
  { id: 2, label: 'Dev Agent', model: 'claude-opus-4-6', visibility: 'internal' },
];

const mockUser = {
  id: 1,
  username: 'testuser',
  display_name: 'Test User',
  role: 'admin',
  allowed_bundles: null,
  entra_groups: [] as string[],
};

describe('renderChatShell', () => {
  let html: string;

  beforeAll(() => {
    html = renderChatShell({ agents, activeAgentId: 1, user: mockUser });
  });

  it('is a full HTML document starting with <!DOCTYPE html>', () => {
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('has NO admin sidebar (.sidebar class)', () => {
    expect(html).not.toContain('class="sidebar"');
    // The admin nav is NOT rendered
    expect(html).not.toContain('sidebar-nav');
  });

  it('contains argus branding', () => {
    expect(html.toLowerCase()).toContain('argus');
  });

  it('contains an agent <select> picker', () => {
    expect(html).toContain('<select');
    // Both agents appear as options
    expect(html).toContain('Support Bot');
    expect(html).toContain('Dev Agent');
  });

  it('contains a logout form (POST /auth/logout)', () => {
    expect(html).toContain('/auth/logout');
  });

  it('contains all chat contract IDs', () => {
    const ids = [
      'agentList', 'sessionArea', 'sessionList',
      'chatPlaceholder', 'chatMain', 'chatAgentName', 'chatAgentModel',
      'chatHeaderDot', 'chatMessages', 'chatInput', 'chatInputBox',
      'sendBtn', 'attachBtn', 'fileInput', 'attachBar',
      'settingsPanel', 'settingsToggleBtn', 'settingsPanelBody',
    ];
    for (const id of ids) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('uses /api/agents as sessionsApiBase in the script', () => {
    expect(html).toContain('/api/agents');
  });

  it('embeds agents JSON in the script', () => {
    // agentsJson must appear as a JS variable assignment
    expect(html).toContain('"Support Bot"');
    expect(html).toContain('"model"');
  });

  it('bootstraps the server-selected agent so picker and chat state agree', () => {
    expect(html).toContain("document.addEventListener('DOMContentLoaded', function() {");
    expect(html).toContain('selectAgent(1);');
  });

  it('does not bootstrap an agent when no valid server default exists', () => {
    const withoutDefault = renderChatShell({ agents, user: mockUser });
    expect(withoutDefault).not.toContain("document.addEventListener('DOMContentLoaded', function() {\n      selectAgent(1);");
  });

  it('does NOT include #modelDisplay (modelOverride:false)', () => {
    expect(html).not.toContain('id="modelDisplay"');
  });

  it('includes sessions and attachments features in the markup', () => {
    // sessions:true → sessionArea present (already checked via contract IDs)
    // attachments:true → attachBtn present (already checked via contract IDs)
    expect(html).toContain('id="attachBtn"');
    expect(html).toContain('id="sessionArea"');
  });
});

describe('renderEmbedChat', () => {
  let html: string;

  beforeAll(() => {
    html = renderEmbedChat({ agentId: 42, agent: { id: 42, label: 'Embed Agent' } });
  });

  it('is a full HTML document', () => {
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('is bare — no logout button, no top bar', () => {
    expect(html).not.toContain('/auth/logout');
    // No sidebar or top-bar nav chrome
    expect(html).not.toContain('sidebar-nav');
    expect(html).not.toContain('class="sidebar"');
  });

  it('contains #chatMessages', () => {
    expect(html).toContain('id="chatMessages"');
  });

  it('does NOT include #sessionArea (sessions:false)', () => {
    expect(html).not.toContain('id="sessionArea"');
    expect(html).not.toContain('id="sessionList"');
  });

  it('does NOT include #agentList sidebar (showAgentList:false)', () => {
    expect(html).not.toContain('id="agentList"');
  });

  it('includes the single agent in agentsJson', () => {
    expect(html).toContain('"Embed Agent"');
  });

  it('is 100%/100% sized for an iframe', () => {
    expect(html).toMatch(/height:\s*100%/);
    expect(html).toMatch(/width:\s*100%/);
  });

  it('contains #attachBtn (attachments:true)', () => {
    expect(html).toContain('id="attachBtn"');
  });

  it('does NOT contain #modelDisplay (modelOverride:false)', () => {
    expect(html).not.toContain('id="modelDisplay"');
  });
});

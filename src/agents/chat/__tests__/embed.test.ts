/**
 * Tests for Task 2.1 + 2.3:
 *   - renderEmbedChat produces a bare document (no sidebar, no logout) with #chatMessages
 *     and the single agent in AGENTS JSON.
 *   - chatCoreCss contains a height:100% fill rule so the chat layout fills an iframe.
 */

import { renderEmbedChat } from '../chatShell.js';
import { chatCoreCss } from '../chatCore.js';

describe('renderEmbedChat — bare embed document', () => {
  let html: string;

  beforeAll(() => {
    html = renderEmbedChat({ agentId: 1, agent: { id: 1, label: 'KB' } });
  });

  it('is a full HTML document starting with <!DOCTYPE html>', () => {
    expect(html.trimStart()).toMatch(/^<!DOCTYPE html>/i);
  });

  it('is bare — no .sidebar class', () => {
    expect(html).not.toContain('class="sidebar"');
  });

  it('is bare — no logout form', () => {
    expect(html).not.toContain('/auth/logout');
  });

  it('is bare — no sidebar-nav', () => {
    expect(html).not.toContain('sidebar-nav');
  });

  it('contains #chatMessages', () => {
    expect(html).toContain('id="chatMessages"');
  });

  it('contains the single agent label in AGENTS JSON', () => {
    expect(html).toContain('"KB"');
  });

  it('does NOT include #agentList sidebar (showAgentList:false)', () => {
    expect(html).not.toContain('id="agentList"');
  });

  it('does NOT include #sessionArea (sessions:false)', () => {
    expect(html).not.toContain('id="sessionArea"');
  });

  it('is sized 100%×100% for iframe fill', () => {
    expect(html).toMatch(/height:\s*100%/);
    expect(html).toMatch(/width:\s*100%/);
  });
});

describe('chatCoreCss — iframe fill rules', () => {
  it('contains a height:100% rule for the chat root (iframe-fill safeguard)', () => {
    // body > .agents-root { height: 100% } is the safeguard for the embed context
    expect(chatCoreCss).toContain('height: 100%');
  });

  it('contains flex layout on .agents-root', () => {
    expect(chatCoreCss).toContain('.agents-root');
    expect(chatCoreCss).toContain('display: flex');
  });

  it('has the body > .agents-root height:100% selector for iframe fill', () => {
    expect(chatCoreCss).toContain('body > .agents-root');
    expect(chatCoreCss).toMatch(/body\s*>\s*\.agents-root\s*\{[^}]*height:\s*100%/);
  });
});

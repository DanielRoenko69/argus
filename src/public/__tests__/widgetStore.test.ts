/**
 * widgetStore.test.ts — TDD for P3-3
 *
 * Tests:
 *   1. isOriginAllowed — full matrix (no live DB needed)
 *   2. getWidgetBySlug — stub pool, assert SQL filters enabled + visibility='public'
 */

import { isOriginAllowed } from '../widgetStore.js';
import type { PublicWidget } from '../widgetStore.js';

// ── Minimal widget fixture ────────────────────────────────────

function makeWidget(allowed_origins: string[]): PublicWidget {
  return {
    id: 1,
    agent_id: 10,
    slug: 'test-widget',
    allowed_origins,
    enabled: true,
    greeting: null,
    accent: null,
    title: null,
    input_placeholder: null,
    launcher_icon_url: null,
    launcher_icon_alt: null,
    launcher_position: 'right',
    rate_limit_per_ip: 20,
    daily_token_cap: 50000,
    created_by: null,
    created_at: new Date(),
  };
}

// ── isOriginAllowed matrix ────────────────────────────────────

describe('isOriginAllowed', () => {

  test('null origin → false', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, undefined)).toBe(false);
  });

  test('empty string origin → false', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, '')).toBe(false);
  });

  test('exact match → true', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'https://example.com')).toBe(true);
  });

  test('trailing slash on origin normalised → true', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'https://example.com/')).toBe(true);
  });

  test('trailing slash on stored value normalised → true', () => {
    const w = makeWidget(['https://example.com/']);
    expect(isOriginAllowed(w, 'https://example.com')).toBe(true);
  });

  test('case-insensitive host → true', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'https://Example.COM')).toBe(true);
  });

  test('non-matching origin → false', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'https://evil.com')).toBe(false);
  });

  test('subdomain not in list → false', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'https://sub.example.com')).toBe(false);
  });

  test('empty allowed_origins list → false', () => {
    const w = makeWidget([]);
    expect(isOriginAllowed(w, 'https://example.com')).toBe(false);
  });

  test('origin in multi-entry list → true', () => {
    const w = makeWidget(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(isOriginAllowed(w, 'https://b.com')).toBe(true);
  });

  test('no wildcard support — asterisk does not match', () => {
    const w = makeWidget(['*']);
    expect(isOriginAllowed(w, 'https://example.com')).toBe(false);
  });

  test('http vs https are different origins → false', () => {
    const w = makeWidget(['https://example.com']);
    expect(isOriginAllowed(w, 'http://example.com')).toBe(false);
  });
});

// ── getWidgetBySlug — SQL filter assertions ───────────────────

import { getWidgetBySlug } from '../widgetStore.js';

describe('getWidgetBySlug SQL filter', () => {
  /**
   * Stub pool that captures the SQL query text so we can assert
   * the three required guards:
   *   mcp_public_widgets.enabled = true
   *   mcp_agents.visibility = 'public'
   *   mcp_agents.enabled = true
   */

  function makeStubPool(row: Record<string, unknown> | null) {
    const queryCalls: { text: string; values: unknown[] }[] = [];
    const pool = {
      queryCalls,
      query: async (text: string, values?: unknown[]) => {
        queryCalls.push({ text, values: values ?? [] });
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      },
    };
    return pool as never;
  }

  const WIDGET_ROW = {
    id: 1, agent_id: 10, slug: 'hello', allowed_origins: ['https://a.com'],
    enabled: true, greeting: null, accent: null, title: null, input_placeholder: null,
    launcher_icon_url: null, launcher_icon_alt: null, launcher_position: 'right',
    rate_limit_per_ip: 20, daily_token_cap: 50000, created_by: null, created_at: new Date(),
  };

  test('returns widget when row present', async () => {
    const pool = makeStubPool(WIDGET_ROW);
    const result = await getWidgetBySlug(pool, 'hello');
    expect(result).not.toBeNull();
    expect(result?.slug).toBe('hello');
  });

  test('returns null when no row', async () => {
    const pool = makeStubPool(null);
    const result = await getWidgetBySlug(pool, 'not-found');
    expect(result).toBeNull();
  });

  test('SQL includes mcp_public_widgets.enabled = true filter', async () => {
    const pool = makeStubPool(null);
    await getWidgetBySlug(pool, 'x');
    const sql = (pool as { queryCalls: { text: string }[] }).queryCalls[0].text;
    // Check that the widget enabled filter is present (case-insensitive)
    expect(sql.toLowerCase()).toMatch(/mcp_public_widgets\.enabled\s*=\s*true/);
  });

  test('SQL includes mcp_agents.visibility = \'public\' filter', async () => {
    const pool = makeStubPool(null);
    await getWidgetBySlug(pool, 'x');
    const sql = (pool as { queryCalls: { text: string }[] }).queryCalls[0].text;
    expect(sql.toLowerCase()).toMatch(/mcp_agents\.visibility\s*=\s*'public'/);
  });

  test('SQL includes mcp_agents.enabled = true filter', async () => {
    const pool = makeStubPool(null);
    await getWidgetBySlug(pool, 'x');
    const sql = (pool as { queryCalls: { text: string }[] }).queryCalls[0].text;
    expect(sql.toLowerCase()).toMatch(/mcp_agents\.enabled\s*=\s*true/);
  });

  test('slug is passed as parameterised value (not interpolated)', async () => {
    const pool = makeStubPool(null);
    await getWidgetBySlug(pool, 'my-slug');
    const call = (pool as { queryCalls: { text: string; values: unknown[] }[] }).queryCalls[0];
    // The slug must appear as a parameter, not embedded in the SQL text
    expect(call.values).toContain('my-slug');
    expect(call.text).not.toContain('my-slug');
  });
});

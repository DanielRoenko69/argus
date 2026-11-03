import { inferLlmProvider, resolveLlmTarget } from '../targets.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('direct LLM target resolution', () => {
  it('routes Claude models to Anthropic', () => {
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test';
    const target = resolveLlmTarget('claude-opus-4-6');
    expect(target.provider).toBe('anthropic');
    expect(target.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(target.apiKey).toBe('anthropic-test');
  });

  it('routes other models to OpenAI by default', () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    const target = resolveLlmTarget('gpt-5.1');
    expect(target.provider).toBe('openai');
    expect(target.baseUrl).toBe('https://api.openai.com/v1');
    expect(target.apiKey).toBe('openai-test');
  });

  it('supports exact and prefix provider overrides', () => {
    process.env['LLM_PROVIDER_OVERRIDES'] = JSON.stringify({
      'local-*': 'openai-compatible',
      'special-model': 'anthropic',
    });
    expect(inferLlmProvider('local-qwen')).toBe('openai-compatible');
    expect(inferLlmProvider('special-model')).toBe('anthropic');
  });

  it('uses per-agent provider keys only when explicitly enabled', () => {
    process.env['OPENAI_API_KEY'] = 'global-key';
    expect(resolveLlmTarget('gpt-4o', 'agent-key').apiKey).toBe('global-key');
    process.env['DIRECT_AGENT_API_KEYS'] = 'true';
    expect(resolveLlmTarget('gpt-4o', 'agent-key').apiKey).toBe('agent-key');
  });
});

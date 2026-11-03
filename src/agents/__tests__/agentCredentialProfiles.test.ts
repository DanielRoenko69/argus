import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  AgentCredentialProfileAssignmentError,
  validateAgentCredentialProfileAssignment,
} from '../agentStore.js';

jest.mock('../../identity/entra.js', () => ({ EntraSidecarClient: class {} }));
jest.mock('../../identity/blueprint.js', () => ({ resolveBlueprintId: () => null }));
jest.mock('../../config/env.js', () => ({ loadConfig: () => ({ entraAgentRegistration: false }) }));
jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

function poolWith(row: Record<string, unknown> | null): pg.Pool {
  return {
    query: jest.fn(async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 })),
  } as unknown as pg.Pool;
}

const compatible = {
  provider_type: 'openai',
  model_provider_type: 'openai',
  enabled: true,
  expires_at: null,
  credential_configured: true,
};

describe('Agent credential profile assignments', () => {
  it('accepts an available profile matching the model provider', async () => {
    await expect(validateAgentCredentialProfileAssignment(
      poolWith(compatible), 'gpt-production', 12,
    )).resolves.toBeUndefined();
  });

  it('rejects protocol mismatches before an agent is saved', async () => {
    await expect(validateAgentCredentialProfileAssignment(
      poolWith({ ...compatible, provider_type: 'anthropic' }), 'gpt-production', 12,
    )).rejects.toThrow('unterschiedliche Protokolle');
  });

  it.each([
    [{ ...compatible, enabled: false }, 'deaktiviert'],
    [{ ...compatible, expires_at: '2020-01-01T00:00:00.000Z' }, 'abgelaufen'],
    [{ ...compatible, credential_configured: false }, 'kein konfiguriertes Secret'],
    [{ ...compatible, model_provider_type: null }, 'keinen registrierten Provider'],
  ])('rejects unavailable assignment state %#', async (row, message) => {
    await expect(validateAgentCredentialProfileAssignment(
      poolWith(row), 'gpt-production', 12,
    )).rejects.toThrow(message);
  });

  it('returns a typed client error for a missing profile', async () => {
    const error = await validateAgentCredentialProfileAssignment(
      poolWith(null), 'gpt-production', 12,
    ).catch(reason => reason);
    expect(error).toBeInstanceOf(AgentCredentialProfileAssignmentError);
    expect(error.status).toBe(400);
  });
});

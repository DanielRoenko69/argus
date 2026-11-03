import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import { runtimeMcpSessionOwner } from '../runtimeMcpTransport.js';

function request(overrides: Record<string, unknown> = {}): Request {
  return {
    executionGrant: {
      jti: '9d9e7f3b-4745-405a-83ec-91f3988f9ae4',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
    },
    runtimeMcpLease: {
      lease: { leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1' },
    },
    ...overrides,
  } as unknown as Request;
}

describe('runtime MCP transport session ownership', () => {
  it('uses the full lease, grant JTI and root trace rather than a display prefix', () => {
    const owner = runtimeMcpSessionOwner(request());
    expect(owner).toContain('81d84476-b44e-4bb3-9d10-9f44ec04d4f1');
    expect(owner).toContain('9d9e7f3b-4745-405a-83ec-91f3988f9ae4');
    expect(owner).toContain('ab5513cf-5a7b-4c64-a235-2998c836766b');
  });

  it('does not produce an owner without both a verified grant and active lease state', () => {
    expect(runtimeMcpSessionOwner({} as Request)).toBeNull();
    expect(runtimeMcpSessionOwner(request({ executionGrant: undefined }))).toBeNull();
    expect(runtimeMcpSessionOwner(request({ runtimeMcpLease: undefined }))).toBeNull();
  });
});

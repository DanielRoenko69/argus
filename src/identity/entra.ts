/**
 * EntraSidecarClient — thin HTTP client around the Microsoft Entra SDK Sidecar.
 *
 * The sidecar runs in the same pod as Argus (in AKS) and brokers all
 * Microsoft Graph calls + handles Workload Identity Federation. Argus
 * therefore never directly calls graph.microsoft.com — egress + auth +
 * retries are the sidecar's responsibility.
 *
 * In local-dev (no sidecar), this client can also be pointed at a mock
 * server or skipped entirely via the ENTRA_AGENT_REGISTRATION=false flag
 * checked at the call-site.
 */

import type { EntraServicePrincipal } from './types.js';

export interface EntraClientConfig {
  sidecarUrl: string;
  /** Inserted into SP displayName as `argus-agent-<envSlug>-<agentName>` */
  envSlug: string;
}

export interface SpawnInput {
  agentName: string;
  blueprintId: string;
}

export class EntraSidecarClient {
  constructor(private cfg: EntraClientConfig) {}

  private base(): string { return this.cfg.sidecarUrl.replace(/\/+$/, ''); }

  async createAgentSP(input: SpawnInput): Promise<EntraServicePrincipal> {
    const displayName = `argus-agent-${this.cfg.envSlug}-${input.agentName}`;
    const res = await fetch(`${this.base()}/blueprints/${input.blueprintId}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      const code = body.error?.code ?? `http_${res.status}`;
      const msg  = body.error?.message ?? `Sidecar returned ${res.status}`;
      const err = new Error(`${code}: ${msg}`) as Error & { status: number; graphCode?: string };
      err.status = res.status;
      if (body.error?.code) err.graphCode = body.error.code;
      throw err;
    }

    return await res.json() as EntraServicePrincipal;
  }

  async deleteAgentSP(objectId: string): Promise<boolean> {
    const res = await fetch(`${this.base()}/servicePrincipals/${objectId}`, { method: 'DELETE' });
    if (res.status === 204) return true;
    if (res.status === 404) return false; // already gone — idempotent
    throw new Error(`Delete failed: ${res.status}`);
  }

  async getHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base()}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

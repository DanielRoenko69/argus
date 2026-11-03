/**
 * Microsoft Entra Agent ID — TypeScript surface.
 *
 * Mirrors the response shapes from the Entra SDK Sidecar (HTTP) which
 * proxies Microsoft Graph. We keep these types isolated from the Agent
 * type so the rest of Argus doesn't depend on Graph internals.
 */

export interface EntraServicePrincipal {
  /** Microsoft-issued Object ID (UUID v4) */
  objectId: string;
  /** Microsoft-issued Application (Client) ID (UUID v4) */
  appId: string;
  /** displayName the SP was created with — Argus convention: argus-agent-<env>-<name> */
  displayName: string;
  /** The blueprint identifier the SP was spawned from */
  blueprintId: string;
}

/**
 * A Blueprint defines a permission template in Entra. Argus knows about
 * blueprints by string id; the actual permission set is configured in
 * Entra by Argus-IT, not by Argus. Argus only picks WHICH blueprint to
 * use per agent (typically by agent_role).
 */
export interface BlueprintConfig {
  /** Stable id used in Argus DB (e.g. "argus-test-worker") */
  id: string;
  /** Description shown in admin UI */
  description: string;
}

/** Errors returned by the Entra SDK Sidecar */
export interface EntraError extends Error {
  status: number;
  graphCode?: string;  // e.g. "Authorization_RequestDenied"
}

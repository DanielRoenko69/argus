export const HERMES_RUNTIME_ADAPTER_ID = 'hermes-http';
export const ARGUS_RUNTIME_PROTOCOL = 'argus-runtime-v1alpha1';

/**
 * The complete, versioned contract that a provisioned Argus-managed Hermes
 * runtime may report. Pack discovery consumes this ceiling, while the live
 * capability endpoint deliberately reports only the subset usable now.
 */
export const HERMES_RUNTIME_CAPABILITY_CEILING = [
  'health',
  'runs',
  'events-sse',
  'cancel',
  'mcp-fabric',
] as const;

/** The fail-closed capability set before an isolated managed runner exists. */
export const HERMES_RUNTIME_UNPROVISIONED_CAPABILITIES = ['health'] as const;

export type HermesRuntimeMode = 'attached' | 'managed';
export type HermesConnectionState = 'not_configured' | 'ready' | 'degraded' | 'unreachable';
export type ArgusRuntimeAdapterState = 'ready' | 'degraded' | 'unavailable';

export interface HermesEndpointProbe {
  endpoint: 'health' | 'capabilities';
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

/** A redacted status representation safe to expose to Core's admin UI. */
export interface HermesAttachedRuntimeStatus {
  configured: boolean;
  mode: 'attached';
  state: HermesConnectionState;
  checkedAt: string;
  endpoint?: string;
  health?: HermesEndpointProbe;
  capabilities?: HermesEndpointProbe;
  detail: string;
}

export type AttachedHermesRunState =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'stopping'
  | 'cancelled'
  | 'completed'
  | 'failed';

/**
 * Bounded projection of a native run from an attached Hermes service.
 * Attached execution remains external / attested: this shape is evidence,
 * not a claim that Core governed Hermes' native tools.
 */
export interface AttachedHermesRunSummary {
  id: string;
  mode: 'attached';
  state: AttachedHermesRunState;
  updatedAt: string;
  output?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ArgusRuntimeAdapterIdentity {
  id: typeof HERMES_RUNTIME_ADAPTER_ID;
  runtime: 'hermes';
  protocol: typeof ARGUS_RUNTIME_PROTOCOL;
}

/**
 * Strict, runtime-neutral control-plane response consumed by Argus Core.
 * It deliberately contains neither an upstream endpoint nor credentials.
 */
export interface ArgusRuntimeAdapterCapabilities {
  adapter: ArgusRuntimeAdapterIdentity;
  modes: readonly HermesRuntimeMode[];
  capabilities: readonly string[];
}

export interface ArgusRuntimeAdapterModeStatus {
  mode: HermesRuntimeMode;
  state: ArgusRuntimeAdapterState;
  detail: string;
}

/**
 * Strict, runtime-neutral control-plane response consumed by Argus Core.
 * Native Hermes probe data remains Pack-internal and is never returned here.
 */
export interface ArgusRuntimeAdapterStatus {
  adapter: ArgusRuntimeAdapterIdentity;
  state: ArgusRuntimeAdapterState;
  checkedAt: string;
  modes: readonly ArgusRuntimeAdapterModeStatus[];
}

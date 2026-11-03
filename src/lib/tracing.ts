/**
 * OpenTelemetry tracing helpers.
 *
 * Actual SDK initialization happens in src/instrumentation.ts which is
 * loaded via --import before the main entry point. This ensures http,
 * express, and pg modules are patched before any application code
 * imports them (ESM static imports are hoisted).
 *
 * This file only provides initTracing() as a no-op (for backwards
 * compatibility) and shutdownTracing() via the global provider.
 */
import { logger } from './logger.js';

// No-op: SDK is initialized in instrumentation.ts via --import
export function initTracing(): void {
  // Initialization moved to src/instrumentation.ts
}

export async function shutdownTracing(): Promise<void> {
  // SDK shutdown is handled by SIGTERM/SIGINT handlers in instrumentation.ts
  logger.info('OpenTelemetry shutdown requested');
}

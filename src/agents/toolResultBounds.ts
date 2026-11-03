const TRUNCATION_MARKER = '\n[ARGUS: tool result truncated to the governed context limit]';
const TEXT_RESOURCE_MARKER = '\n[ARGUS: middle of text resource omitted; use targeted search for omitted content]\n';
const TEXT_RESOURCE_PROJECTION_LIMIT = 64 * 1024;
const TEXT_RESOURCE_PROJECTION_THRESHOLD = 64 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactValue);
  const record = object(value);
  if (!record) return value;
  const compact: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'managedFields') continue;
    if (key === 'annotations') {
      const annotations = object(entry);
      if (!annotations) continue;
      const retained = Object.fromEntries(Object.entries(annotations)
        .filter(([name]) => name !== 'kubectl.kubernetes.io/last-applied-configuration')
        .map(([name, annotation]) => [name, compactValue(annotation)]));
      if (Object.keys(retained).length > 0) compact[key] = retained;
      continue;
    }
    compact[key] = compactValue(entry);
  }
  return compact;
}

function eventTimestamp(value: unknown): number {
  const event = object(value);
  const metadata = object(event?.['metadata']);
  for (const candidate of [event?.['eventTime'], event?.['lastTimestamp'], event?.['firstTimestamp'], metadata?.['creationTimestamp']]) {
    if (typeof candidate !== 'string') continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function parseJsonResult(raw: string): Record<string, unknown> | null {
  const candidates = [raw];
  const firstObject = raw.indexOf('{');
  const lastObject = raw.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(raw.slice(firstObject, lastObject + 1));
  }
  for (const candidate of candidates) {
    try {
      let parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      const record = object(parsed);
      if (record) return record;
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return null;
}

function countTextLines(text: string): number {
  if (!text) return 0;
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return breaks + (/\r\n$|\r$|\n$/.test(text) ? 0 : 1);
}

function boundedTextResource(parsed: Record<string, unknown>, requestedLimit: number): string | null {
  const resource = object(parsed['resource']);
  const text = resource?.['text'];
  if (!resource || typeof text !== 'string' || text.length <= TEXT_RESOURCE_PROJECTION_THRESHOLD) return null;

  const maxChars = Math.min(requestedLimit, TEXT_RESOURCE_PROJECTION_LIMIT);
  const metadata = {
    kind: 'text-resource',
    truncated: true,
    originalCharacterCount: text.length,
    originalByteCount: Buffer.byteLength(text, 'utf8'),
    originalLineCount: countTextLines(text),
    retainedCharacterCount: 0,
  };
  const base: Record<string, unknown> = {
    ...parsed,
    resource: { ...resource, text: '' },
    argusProjection: metadata,
  };
  const fixedSize = JSON.stringify(base).length + TEXT_RESOURCE_MARKER.length;
  let retained = Math.max(0, Math.min(text.length, maxChars - fixedSize - 256));

  while (retained >= 0) {
    const head = Math.ceil(retained / 2);
    const tail = retained - head;
    (base['resource'] as Record<string, unknown>)['text'] = `${text.slice(0, head)}${TEXT_RESOURCE_MARKER}${tail > 0 ? text.slice(-tail) : ''}`;
    metadata.retainedCharacterCount = retained;
    const serialized = JSON.stringify(base);
    if (serialized.length <= maxChars) return serialized;
    if (retained === 0) return null;
    retained = Math.max(0, Math.floor(retained * 0.75));
  }
  return null;
}

function boundedJsonList(toolName: string, parsed: Record<string, unknown>, maxChars: number): string | null {
  if (!Array.isArray(parsed['items'])) return null;
  const originalItems = parsed['items'];
  const isEvents = /(?:kubernetes|k8s).*get_events/i.test(toolName);
  const ordered = originalItems.map(compactValue);
  if (isEvents) ordered.sort((left, right) => eventTimestamp(right) - eventTimestamp(left));
  let items = ordered.slice(0, isEvents ? 32 : 64);
  const base = compactValue({ ...parsed, items }) as Record<string, unknown>;
  base['argusProjection'] = {
    truncated: items.length < originalItems.length,
    originalItemCount: originalItems.length,
    retainedItemCount: items.length,
  };
  let serialized = JSON.stringify(base);
  while (serialized.length > maxChars && items.length > 1) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    base['items'] = items;
    base['argusProjection'] = {
      truncated: true,
      originalItemCount: originalItems.length,
      retainedItemCount: items.length,
    };
    serialized = JSON.stringify(base);
  }
  return serialized.length <= maxChars ? serialized : null;
}

/**
 * Keeps untrusted provider output below the worker-runtime context ceiling.
 * Kubernetes List payloads remain valid JSON so Solution Packs can normalize
 * retained evidence instead of receiving an unusable string fragment.
 */
export function boundAgentToolResult(toolName: string, raw: string, requestedLimit: number): string {
  const maxChars = Number.isFinite(requestedLimit)
    ? Math.max(1_024, Math.min(Math.floor(requestedLimit), 512 * 1_024))
    : 32 * 1_024;
  const parsed = parseJsonResult(raw);
  if (parsed) {
    const textResource = boundedTextResource(parsed, maxChars);
    if (textResource) return textResource;
  }
  if (raw.length <= maxChars) return raw;
  if (parsed) {
    const boundedList = boundedJsonList(toolName, parsed, maxChars);
    if (boundedList) return boundedList;
  }
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return `${raw.slice(0, keep)}${TRUNCATION_MARKER}`;
}

export const SOLUTION_PACK_TOOL_RESULT_MAX_CHARS = 32 * 1_024;

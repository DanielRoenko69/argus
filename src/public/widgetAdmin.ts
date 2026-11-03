export interface PublicWidgetMutation {
  agentId?: number;
  slug?: string;
  allowedOrigins?: string[];
  enabled?: boolean;
  greeting?: string | null;
  accent?: string | null;
  title?: string | null;
  inputPlaceholder?: string | null;
  launcherIconUrl?: string | null;
  launcherIconAlt?: string | null;
  launcherPosition?: 'left' | 'right';
  rateLimitPerIp?: number;
  dailyTokenCap?: number;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} muss Text oder null sein`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} darf maximal ${maxLength} Zeichen enthalten`);
  return normalized || null;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} muss eine ganze Zahl zwischen ${min} und ${max} sein`);
  }
  return parsed;
}

function launcherIconUrl(value: unknown): string | null | undefined {
  const normalized = optionalString(value, 'launcherIconUrl', 2048);
  if (normalized == null) return normalized;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error('launcherIconUrl enthÃ¤lt ungÃ¼ltige Steuerzeichen');
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return normalized;
  let parsed: URL;
  try { parsed = new URL(normalized); } catch { throw new Error('launcherIconUrl muss eine absolute HTTP(S)-URL oder ein Root-Pfad sein'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('launcherIconUrl muss eine HTTP(S)-URL ohne Zugangsdaten sein');
  }
  return parsed.href;
}

export function normalizePublicWidgetOriginList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error('allowedOrigins muss eine Liste mit höchstens 20 Einträgen sein');
  }
  const origins = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') throw new Error('Jede Allowed Origin muss Text sein');
    const raw = candidate.trim();
    if (!raw || raw.includes('*')) throw new Error('Allowed Origins dürfen nicht leer sein oder Wildcards enthalten');
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error(`Ungültige Allowed Origin: ${raw}`); }
    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      throw new Error(`Allowed Origin muss ein exakter HTTP(S)-Origin ohne Pfad sein: ${raw}`);
    }
    origins.add(parsed.origin);
  }
  return [...origins];
}

export function normalizePublicWidgetMutation(value: unknown, create: boolean): PublicWidgetMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Widget-Konfiguration fehlt');
  const input = value as Record<string, unknown>;
  const slugValue = input['slug'];
  let slug: string | undefined;
  if (slugValue !== undefined) {
    if (typeof slugValue !== 'string') throw new Error('slug muss Text sein');
    slug = slugValue.trim();
    if (!/^[a-z0-9_-]{1,128}$/.test(slug)) throw new Error('slug muss 1–128 Zeichen aus a-z, 0-9, _ oder - enthalten');
  } else if (create) {
    throw new Error('slug ist erforderlich');
  }

  const agentId = boundedInteger(input['agentId'], 'agentId', 1, Number.MAX_SAFE_INTEGER);
  if (create && agentId == null) throw new Error('agentId ist erforderlich');
  if (input['enabled'] !== undefined && typeof input['enabled'] !== 'boolean') throw new Error('enabled muss true oder false sein');
  const accent = optionalString(input['accent'], 'accent', 7);
  if (accent != null && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error('accent muss eine sechsstellige Hex-Farbe sein');
  const launcherPosition = input['launcherPosition'];
  if (launcherPosition !== undefined && launcherPosition !== 'left' && launcherPosition !== 'right') {
    throw new Error('launcherPosition muss left oder right sein');
  }

  return {
    ...(agentId !== undefined ? { agentId } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(input['allowedOrigins'] !== undefined ? { allowedOrigins: normalizePublicWidgetOriginList(input['allowedOrigins'])! } : {}),
    ...(input['enabled'] !== undefined ? { enabled: input['enabled'] as boolean } : {}),
    ...(input['greeting'] !== undefined ? { greeting: optionalString(input['greeting'], 'greeting', 500) } : {}),
    ...(input['accent'] !== undefined ? { accent: accent?.toLowerCase() ?? null } : {}),
    ...(input['title'] !== undefined ? { title: optionalString(input['title'], 'title', 80) } : {}),
    ...(input['inputPlaceholder'] !== undefined ? { inputPlaceholder: optionalString(input['inputPlaceholder'], 'inputPlaceholder', 160) } : {}),
    ...(input['launcherIconUrl'] !== undefined ? { launcherIconUrl: launcherIconUrl(input['launcherIconUrl']) } : {}),
    ...(input['launcherIconAlt'] !== undefined ? { launcherIconAlt: optionalString(input['launcherIconAlt'], 'launcherIconAlt', 120) } : {}),
    ...(launcherPosition !== undefined ? { launcherPosition } : {}),
    ...(input['rateLimitPerIp'] !== undefined ? { rateLimitPerIp: boundedInteger(input['rateLimitPerIp'], 'rateLimitPerIp', 1, 1000)! } : {}),
    ...(input['dailyTokenCap'] !== undefined ? { dailyTokenCap: boundedInteger(input['dailyTokenCap'], 'dailyTokenCap', 1000, 10_000_000)! } : {}),
  };
}

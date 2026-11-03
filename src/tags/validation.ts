import {
  TAGGABLE_RESOURCE_TYPES,
  type NormalizedTagMutation,
  type TagMutationInput,
  type TaggableResourceType,
} from './types.js';

export const MAX_TAGS_PER_WORKSPACE = 500;
export const MAX_TAGS_PER_RESOURCE = 20;
export const MAX_TAG_QUERY_LENGTH = 128;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

export class TagValidationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'TagValidationError';
  }
}

function text(value: unknown, field: string, max: number, required: boolean): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new TagValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new TagValidationError(`${field} is required`);
  if (normalized.length > max) throw new TagValidationError(`${field} must be at most ${max} characters`);
  return normalized;
}

export function normalizeTagMutation(input: TagMutationInput, requireSlug = true): NormalizedTagMutation {
  const label = text(input.label, 'label', 128, true);
  const slug = text(input.slug, 'slug', 64, requireSlug).toLowerCase();
  if (requireSlug && !SLUG_PATTERN.test(slug)) {
    throw new TagValidationError('slug must contain only lowercase letters, numbers, underscores or hyphens');
  }
  const rawColor = text(input.color, 'color', 9, false);
  if (rawColor && !COLOR_PATTERN.test(rawColor)) {
    throw new TagValidationError('color must be a six- or eight-digit hex value');
  }
  return {
    slug,
    label,
    color: rawColor ? rawColor.toLowerCase() : null,
    description: text(input.description, 'description', 512, false),
  };
}

export function parseTaggableResourceType(value: unknown): TaggableResourceType {
  if (typeof value !== 'string' || !TAGGABLE_RESOURCE_TYPES.includes(value as TaggableResourceType)) {
    throw new TagValidationError('unsupported resource type');
  }
  return value as TaggableResourceType;
}

export function parseResourceId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  const positiveInteger = /^[1-9]\d{0,18}$/.test(id);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  if (!positiveInteger && !uuid) throw new TagValidationError('resource id must be a positive integer or UUID');
  return id;
}

export function parseTagIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TagValidationError('tagIds must be an array');
  if (value.length > MAX_TAGS_PER_RESOURCE) {
    throw new TagValidationError(`at most ${MAX_TAGS_PER_RESOURCE} tags may be assigned to one resource`);
  }
  const ids = value.map(item => {
    const id = typeof item === 'number' || typeof item === 'string' ? String(item).trim() : '';
    if (!/^[1-9]\d{0,18}$/.test(id)) throw new TagValidationError('tagIds must contain positive integers');
    return id;
  });
  return [...new Set(ids)];
}

export function normalizeTagQuery(value: unknown): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TagValidationError('query must be a string');
  const query = value.trim();
  if (query.length > MAX_TAG_QUERY_LENGTH) {
    throw new TagValidationError(`query must be at most ${MAX_TAG_QUERY_LENGTH} characters`);
  }
  return query;
}

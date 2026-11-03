import {
  MAX_TAGS_PER_RESOURCE,
  normalizeTagMutation,
  normalizeTagQuery,
  parseResourceId,
  parseTaggableResourceType,
  parseTagIds,
  TagValidationError,
} from '../validation.js';

describe('workspace tag validation', () => {
  it('normalizes safe tag input', () => {
    expect(normalizeTagMutation({
      slug: ' Team_Platform ',
      label: ' Platform Team ',
      color: '#AABBCC',
      description: ' Owns the platform ',
    })).toEqual({
      slug: 'team_platform',
      label: 'Platform Team',
      color: '#aabbcc',
      description: 'Owns the platform',
    });
  });

  it.each([
    [{ slug: '../admin', label: 'Admin' }, 'slug'],
    [{ slug: 'platform', label: '' }, 'label'],
    [{ slug: 'platform', label: 'Platform', color: 'purple' }, 'color'],
    [{ slug: 'x'.repeat(65), label: 'Long' }, 'slug'],
  ])('rejects invalid mutations', (input, field) => {
    expect(() => normalizeTagMutation(input)).toThrow(field);
  });

  it('accepts only the closed resource type set and positive numeric IDs', () => {
    expect(parseTaggableResourceType('repository_snapshot')).toBe('repository_snapshot');
    expect(parseTaggableResourceType('aiops_service_profile')).toBe('aiops_service_profile');
    expect(parseTaggableResourceType('ai_system')).toBe('ai_system');
    expect(() => parseTaggableResourceType('postgres_table')).toThrow(TagValidationError);
    expect(parseResourceId('42')).toBe('42');
    expect(parseResourceId('10000000-0000-4000-8000-000000000001')).toBe('10000000-0000-4000-8000-000000000001');
    expect(() => parseResourceId('../42')).toThrow(TagValidationError);
    expect(() => parseResourceId('0')).toThrow(TagValidationError);
  });

  it('deduplicates tag IDs and enforces the assignment cap before SQL', () => {
    expect(parseTagIds([1, '2', 1])).toEqual(['1', '2']);
    expect(() => parseTagIds(Array.from({ length: MAX_TAGS_PER_RESOURCE + 1 }, (_, index) => index + 1)))
      .toThrow(`at most ${MAX_TAGS_PER_RESOURCE} tags`);
  });

  it('bounds search text', () => {
    expect(normalizeTagQuery(' platform ')).toBe('platform');
    expect(() => normalizeTagQuery('x'.repeat(129))).toThrow('at most 128');
  });
});

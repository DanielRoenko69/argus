import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandIcon, hasLocalBrandAsset, resolveBackendBrand } from './BrandIcon';

describe('BrandIcon', () => {
  it('uses a locally bundled asset for supported brands', () => {
    render(<BrandIcon brand="github" label="GitHub" />);
    expect(screen.getByRole('img', { name: 'GitHub logo' }).querySelector('img'))
      .toHaveAttribute('src', '/console-assets/brand/github.svg');
    expect(hasLocalBrandAsset('github')).toBe(true);
  });

  it('falls back to a neutral vector glyph when an asset is unavailable', () => {
    render(<BrandIcon brand="filesystem" label="Filesystem" />);
    expect(screen.getByRole('img', { name: 'Filesystem logo' }).querySelector('svg')).toBeTruthy();
  });

  it('fails safely when a bundled image cannot be loaded', () => {
    render(<BrandIcon brand="github" label="GitHub" />);
    fireEvent.error(screen.getByRole('img', { name: 'GitHub logo' }).querySelector('img')!);
    expect(screen.getByRole('img', { name: 'GitHub logo' }).querySelector('svg')).toBeTruthy();
  });

  it('resolves common backend providers from names and endpoints', () => {
    expect(resolveBackendBrand('github_argus_core', 'https://api.github.com')).toBe('github');
    expect(resolveBackendBrand('production-postgresql', 'postgres://db:5432/argus')).toBe('ref-postgres');
    expect(resolveBackendBrand('incident notifications', 'https://slack.com/api')).toBe('slack');
    expect(resolveBackendBrand('internal custom service')).toBeNull();
  });
});

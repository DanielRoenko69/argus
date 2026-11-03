export const ARTIFACT_LANGS = ['mermaid', 'html', 'svg'] as const;
export type ArtifactLang = (typeof ARTIFACT_LANGS)[number];
export function isArtifactLang(lang?: string): lang is ArtifactLang {
  return !!lang && (ARTIFACT_LANGS as readonly string[]).includes(lang);
}

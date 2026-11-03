export interface ChangeTitleState {
  description: string;
  plan: string;
}

function cleanTitle(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,\-]+$/, '');
}

export function commitTitleFor(state: ChangeTitleState, ticket: string): string {
  const descriptionSentences = state.description
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map(cleanTitle)
    .filter(Boolean);
  const actionableDescription = descriptionSentences.find(value =>
    !/^(?:implement|resolve|address)\s+(?:(?:gitea|github|gitlab)\s+)?(?:issue|ticket|task)\b/i.test(value),
  );
  const planFirstLine = state.plan.split('\n').map(cleanTitle).find(Boolean) ?? '';
  return (actionableDescription || descriptionSentences[0] || planFirstLine || `Implement ${ticket}`).slice(0, 80);
}

export function pullRequestTitleFor(state: ChangeTitleState, ticket: string): string {
  return `${ticket}: ${commitTitleFor(state, ticket)}`.slice(0, 100);
}

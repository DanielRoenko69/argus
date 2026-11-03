/** Decide whether to serve the new SPA shell vs the classic chatCore for /chat. */
export function shouldServeChatSpa(flagEnabled: boolean, query: Record<string, unknown>): boolean {
  if (!flagEnabled) return false;
  if (query['classic'] === '1' || query['classic'] === 'true') return false;
  return true;
}

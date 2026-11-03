import { normalizeRole } from './roles.js';

/** Post-login landing path by role: chat-only users go to the chat window. */
export function landingFor(role?: string): string {
  return normalizeRole(role ?? 'viewer') === 'chat_user' ? '/chat' : '/home';
}

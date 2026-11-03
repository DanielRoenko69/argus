import type { ChatMessage } from '../data-provider/types.js';

export function resolveActivePath(messages: ChatMessage[], activeLeafId: string | null | undefined): ChatMessage[] {
  if (!activeLeafId) return messages;
  const byId = new Map<string, ChatMessage>();
  for (const m of messages) if (m.id) byId.set(m.id, m);
  if (!byId.has(activeLeafId)) return messages;
  const path: ChatMessage[] = [];
  const seen = new Set<string>();
  let cur: ChatMessage | undefined = byId.get(activeLeafId);
  while (cur && cur.id && !seen.has(cur.id)) { seen.add(cur.id); path.push(cur); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
  return path.reverse();
}

export function variantInfo(messages: ChatMessage[], id: string): { index: number; count: number; siblingIds: string[] } {
  const target = messages.find((x) => x.id === id);
  if (!target) return { index: 0, count: 1, siblingIds: [id] };
  const sibs = messages.filter((x) => x.id && (x.parentId ?? null) === (target.parentId ?? null));
  const siblingIds = sibs.map((x) => x.id as string);
  const index = siblingIds.indexOf(id);
  return { index: index < 0 ? 0 : index, count: siblingIds.length, siblingIds };
}

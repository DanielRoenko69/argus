import type pg from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { resolveActivePath } from '../agents/messageTree.js';
import { redactJson, listDetectors } from '../lib/redaction.js';
import { hashPassword, verifyPassword } from '../auth/userAuth.js';
import type { ChatMessage } from '../agents/types.js';

export class ShareForbiddenError extends Error {}

export interface ShareRecord {
  id: number; title: string; agent_id: number;
  redacted_messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  hasPassword: boolean; password_hash: string | null; expires_at: string;
}

const ALLOWED_EXPIRY = new Set([1, 7, 30]);

function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** Coerce ChatMessage.content (string | ContentPart[] | null) to a display string. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof (p as { text?: string }).text === 'string' ? (p as { text: string }).text : '[Bild]')).join('\n');
  }
  return '';
}

/** Snapshot the active path → keep user+assistant turns → redact (forced) → store the redacted copy. */
export async function createShare(
  pool: pg.Pool,
  input: { sessionId: string; userId: number; expiryDays: number; password?: string },
): Promise<{ id: number; token: string }> {
  const { rows } = await pool.query<{ user_id: number | null; agent_id: number; active_leaf_id: string | null; messages: ChatMessage[] }>(
    'SELECT user_id, agent_id, active_leaf_id, messages FROM mcp_agent_sessions WHERE id=$1', [input.sessionId],
  );
  const s = rows[0];
  if (!s) throw new ShareForbiddenError('session not found');
  if (s.user_id !== input.userId) throw new ShareForbiddenError('not the session owner');

  const path = resolveActivePath(s.messages ?? [], s.active_leaf_id);
  const turns = path
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m.content) }));
  // Pin the FULL detector set so the public snapshot is independent of any
  // runtime narrowing (admin UI may have disabled e.g. iban) — an anon link
  // must never store unredacted PII.
  const { value: redacted } = redactJson(turns, { forceEnabled: true, detectors: new Set(listDetectors()) });

  const token = randomBytes(32).toString('base64url');
  const days = ALLOWED_EXPIRY.has(input.expiryDays) ? input.expiryDays : 7;
  const pwHash = input.password ? await hashPassword(input.password) : null;
  // Derive the title from the REDACTED copy — it is stored and rendered verbatim
  // on the anonymous /share page, so it must never contain raw PII.
  const title = (redacted.find((t) => t.role === 'user')?.content ?? 'Geteilte Konversation').slice(0, 120);

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO mcp_shared_conversations (token_hash, agent_id, source_session_id, title, redacted_messages, password_hash, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval) RETURNING id`,
    [sha256(token), s.agent_id, input.sessionId, title, JSON.stringify(redacted), pwHash, input.userId, String(days)],
  );
  return { id: ins.rows[0].id, token };
}

export async function verifySharePassword(record: ShareRecord, password: string): Promise<boolean> {
  if (!record.password_hash) return true;
  return verifyPassword(password, record.password_hash);
}

export async function getShareByToken(pool: pg.Pool, token: string): Promise<ShareRecord | null> {
  const { rows } = await pool.query<{ id: number; title: string; agent_id: number; redacted_messages: ShareRecord['redacted_messages']; password_hash: string | null; expires_at: string }>(
    `SELECT id, title, agent_id, redacted_messages, password_hash, expires_at
       FROM mcp_shared_conversations
      WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, title: r.title, agent_id: r.agent_id, redacted_messages: r.redacted_messages, hasPassword: r.password_hash != null, password_hash: r.password_hash, expires_at: r.expires_at };
}

export async function listSharesByUser(pool: pg.Pool, userId: number): Promise<Array<{ id: number; title: string; created_at: string; expires_at: string; hasPassword: boolean }>> {
  const { rows } = await pool.query<{ id: number; title: string; created_at: string; expires_at: string; password_hash: string | null }>(
    `SELECT id, title, created_at, expires_at, password_hash FROM mcp_shared_conversations
      WHERE created_by=$1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, created_at: r.created_at, expires_at: r.expires_at, hasPassword: r.password_hash != null }));
}

export async function revokeShare(pool: pg.Pool, id: number, userId: number): Promise<boolean> {
  const res = await pool.query('UPDATE mcp_shared_conversations SET revoked_at=now() WHERE id=$1 AND created_by=$2 AND revoked_at IS NULL', [id, userId]);
  return (res.rowCount ?? 0) > 0;
}

export async function cleanupExpiredShares(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM mcp_shared_conversations WHERE expires_at < now()');
}

import type pg from 'pg';

const TICKET_LOCK_NAMESPACE = 0x4154_4c53;

export interface TicketLockHandle {
  release: () => Promise<void>;
}

export async function tryAcquireTicketLock(
  pool: pg.Pool,
  ticketId: string,
): Promise<TicketLockHandle | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1::int4, hashtext($2)) AS ok`,
      [TICKET_LOCK_NAMESPACE, ticketId],
    );
    if (rows[0]?.ok !== true) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query(
          `SELECT pg_advisory_unlock($1::int4, hashtext($2))`,
          [TICKET_LOCK_NAMESPACE, ticketId],
        );
      } finally {
        client.release();
      }
    },
  };
}

/** New workflow attempts must never reuse a previous run's pushed feature branch. */
export function deriveBranchName(ticket: string, threadId: string, requiredPrefix?: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw new Error('A durable workflow thread is required before creating a feature branch.');
  }
  if (requiredPrefix !== undefined && !/^feature\/[A-Za-z0-9-]+-$/.test(requiredPrefix)) {
    throw new Error('The authorized Jenkins branch prefix is invalid.');
  }

  const attempt = threadId.replaceAll('-', '').toLowerCase();
  const sanitized = ticket.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
  const policyStem = requiredPrefix?.slice('feature/'.length) ?? '';
  const basePrefix = requiredPrefix && !sanitized.startsWith(policyStem)
    ? requiredPrefix
    : 'feature/';
  const maxTicketLength = 200 - basePrefix.length - attempt.length - 1;
  if (maxTicketLength < 1) {
    throw new Error('The authorized Jenkins branch prefix is too long.');
  }
  const safe = sanitized.slice(0, maxTicketLength).replace(/-+$/g, '') || 'untitled';
  const branch = `${basePrefix}${safe}-${attempt}`;
  if (requiredPrefix && !branch.startsWith(requiredPrefix)) {
    throw new Error('The generated branch does not satisfy the authorized Jenkins branch policy.');
  }
  return branch;
}

/** Resolve a fresh or checkpointed delivery branch against the immutable CI policy. */
export function resolveDeliveryBranch(
  ticket: string,
  threadId: string,
  existingBranch = '',
  requiredPrefix?: string,
): string {
  const branch = existingBranch || deriveBranchName(ticket, threadId, requiredPrefix);
  if (requiredPrefix && !branch.startsWith(requiredPrefix)) {
    throw new Error('The delivery branch does not satisfy the authorized Jenkins branch policy.');
  }
  return branch;
}

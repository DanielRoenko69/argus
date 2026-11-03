/** Public checkpoint projections must not expose internal execution authority,
 * including partial node results and metadata, not just top-level state. */
export function publicCheckpointData(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map(item => publicCheckpointData(item, parentKey));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (['argus_execution_grant', 'approvalGrant', 'gitApproval', 'qa_response_receipt'].includes(key)) return [];
    if (parentKey === 'bitbucket_creds' && key === 'token') return [[key, child === null ? null : '[REDACTED]']];
    return [[key, publicCheckpointData(child, key)]];
  }));
}

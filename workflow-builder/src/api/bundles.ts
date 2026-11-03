import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';

export interface AccessibleBundle {
  id: number;
  name: string;
}

/**
 * Bundles the current user may bind a step's creds to. Reads /api/admin/bundles;
 * non-admins (403) get an empty list and the UI falls back to the service
 * account default. cred_ref stores only { bundle_id } — never the secret.
 */
export function useAccessibleBundles() {
  return useQuery<AccessibleBundle[]>({
    queryKey: ['accessible-bundles'],
    queryFn: async () => {
      try {
        const rows = await api.get<Array<{ id: number; name: string }>>('/api/admin/bundles');
        return rows.map((b) => ({ id: b.id, name: b.name }));
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) return [];
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

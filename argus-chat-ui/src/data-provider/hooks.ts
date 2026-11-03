import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ep } from './endpoints';
import { apiGet, apiSend } from './client';
import type { Me, AgentSummary, AllowedModels, Session } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => apiGet<Me>(ep.me()) });
export const useAgents = () => useQuery({ queryKey: ['agents'], queryFn: () => apiGet<AgentSummary[]>(ep.agents()) });
export const useAllowedModels = (id?: number) =>
  useQuery({ queryKey: ['allowed-models', id], enabled: !!id, queryFn: () => apiGet<AllowedModels>(ep.allowedModels(id!)) });
export const useSessions = (id?: number) =>
  useQuery({ queryKey: ['sessions', id], enabled: !!id, queryFn: () => apiGet<Session[]>(ep.sessions(id!)) });
export const useSession = (id?: number, sid?: string) =>
  useQuery({ queryKey: ['session', id, sid], enabled: !!id && !!sid, queryFn: () => apiGet<Session>(ep.session(id!, sid!)) });
export function useCreateSession(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiSend<Session>(ep.sessions(id), 'POST', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', id] }),
  });
}
export function useDeleteSession(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sid: string) => apiSend<{ deleted: boolean }>(ep.session(id, sid), 'DELETE'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', id] }),
  });
}
export function useSetActiveLeaf(id: number, sid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (leafId: string) => apiSend<{ active_leaf_id: string }>(ep.activeLeaf(id, sid), 'PATCH', { leafId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', id, sid] }),
  });
}

export interface ShareSummary { id: number; title: string; created_at: string; expires_at: string; hasPassword: boolean }
export const useMyShares = (enabled = true) =>
  useQuery({ queryKey: ['my-shares'], enabled, queryFn: () => apiGet<ShareSummary[]>(ep.myShares()) });
export function useCreateShare(agentId: number, sid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { expiryDays: number; password?: string }) =>
      apiSend<{ id: number; url: string }>(ep.share(agentId, sid), 'POST', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-shares'] }),
  });
}
export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: number) => apiSend<{ revoked: boolean }>(ep.revokeShare(shareId), 'DELETE'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-shares'] }),
  });
}

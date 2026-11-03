import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export function useNamespaces() {
  return useQuery({
    queryKey: ['k8s', 'namespaces'],
    queryFn: () => api.get<{ items: string[]; error?: string }>('/api/workflows/k8s/namespaces'),
    staleTime: 60_000,
  });
}

export function usePods(namespace: string | undefined) {
  return useQuery({
    queryKey: ['k8s', 'pods', namespace],
    queryFn: () => api.get<{ items: string[]; error?: string }>(`/api/workflows/k8s/pods?namespace=${encodeURIComponent(namespace ?? '')}`),
    enabled: !!namespace,
    staleTime: 30_000,
  });
}

export function useServices(namespace: string | undefined) {
  return useQuery({
    queryKey: ['k8s', 'services', namespace],
    queryFn: () => api.get<{ items: string[]; error?: string }>(`/api/workflows/k8s/services?namespace=${encodeURIComponent(namespace ?? '')}`),
    enabled: !!namespace,
    staleTime: 30_000,
  });
}

export function useStepBundles(workflowId: number | null) {
  return useQuery({
    queryKey: ['step-bundles', workflowId],
    queryFn: () => api.get<{ stepBundles: Record<string, string[]> }>(`/api/workflows/${workflowId}/bundles`),
    enabled: workflowId != null,
    staleTime: 30_000,
  });
}

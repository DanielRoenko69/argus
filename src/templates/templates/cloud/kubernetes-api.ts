import type { ServiceTemplate } from '../../serviceTemplates.js';

export const kubernetesApiTemplate: ServiceTemplate = {
  id: 'kubernetes-api',
  name: 'Kubernetes API',
  description: 'Kubernetes-Cluster über die REST-API abfragen: Pods, Deployments, Services und Events.',
  icon: '☸️',
  category: 'cloud',
  tags: ['kubernetes', 'k8s', 'cluster', 'containers', 'pods'],
  docsUrl: 'https://kubernetes.io/docs/reference/kubernetes-api/',

  fields: [
    {
      name: 'base_url',
      label: 'Kubernetes API URL',
      type: 'string',
      required: true,
      placeholder: 'https://kubernetes.default.svc',
    },
    {
      name: 'token',
      label: 'Service Account Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_pods',
      description: 'Pods in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/namespaces/{{namespace}}/pods?limit={{limit}}',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '100',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_deployments',
      description: 'Deployments in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /apis/apps/v1/namespaces/{{namespace}}/deployments',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_services',
      description: 'Services in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/namespaces/{{namespace}}/services',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_events',
      description: 'Events in einem Namespace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/v1/namespaces/{{namespace}}/events?limit={{limit}}',
      parameters: [
        {
          name: 'namespace',
          type: 'string',
          description: 'Kubernetes-Namespace',
          required: false,
          default: 'default',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '50',
        },
      ],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/healthz',
};

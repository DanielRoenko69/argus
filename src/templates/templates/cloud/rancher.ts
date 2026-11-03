import type { ServiceTemplate } from '../../serviceTemplates.js';

export const rancherTemplate: ServiceTemplate = {
  id: 'rancher',
  name: 'Rancher',
  description: 'Rancher-Cluster und Namespaces über die API verwalten und überwachen.',
  icon: '🐄',
  category: 'cloud',
  tags: ['rancher', 'kubernetes', 'cluster-management', 'suse'],
  docsUrl: 'https://ranchermanager.docs.rancher.com/api/',

  fields: [
    {
      name: 'base_url',
      label: 'Rancher URL',
      type: 'string',
      required: true,
      placeholder: 'https://rancher.example.com',
    },
    {
      name: 'bearer_token',
      label: 'Bearer Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_clusters',
      description: 'Alle verwalteten Cluster auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v3/clusters',
      parameters: [],
      category: 'Cloud',
    },
    {
      nameSuffix: 'get_cluster',
      description: 'Details zu einem bestimmten Cluster abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /v3/clusters/{{cluster_id}}',
      parameters: [
        {
          name: 'cluster_id',
          type: 'string',
          description: 'ID des Clusters',
          required: true,
        },
      ],
      category: 'Cloud',
    },
    {
      nameSuffix: 'list_namespaces',
      description: 'Namespaces eines Clusters auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /k8s/clusters/{{cluster_id}}/v1/namespaces',
      parameters: [
        {
          name: 'cluster_id',
          type: 'string',
          description: 'ID des Clusters',
          required: true,
        },
      ],
      category: 'Cloud',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.bearer_token,

  buildHealthPath: () => '/healthz',
};

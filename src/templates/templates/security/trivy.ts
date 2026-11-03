import type { ServiceTemplate } from '../../serviceTemplates.js';

export const trivyTemplate: ServiceTemplate = {
  id: 'trivy',
  name: 'Trivy Server',
  description: 'Trivy Server für Container-Image-Scanning anbinden.',
  icon: '🛡️',
  category: 'security',
  tags: ['trivy', 'vulnerability', 'scanning', 'container', 'security'],
  docsUrl: 'https://aquasecurity.github.io/trivy/',

  fields: [
    {
      name: 'base_url',
      label: 'Trivy Server URL',
      type: 'string',
      required: true,
      placeholder: 'http://trivy:4954',
    },
  ],

  tools: [
    {
      nameSuffix: 'scan_image',
      description: 'Ein Container-Image auf Schwachstellen scannen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /v1/scan\n\n{"image": "{{image}}", "severity": "{{severity}}"}',
      parameters: [
        {
          name: 'image',
          type: 'string',
          description: 'Name des Container-Images (z.B. nginx:latest)',
          required: true,
        },
        {
          name: 'severity',
          type: 'string',
          description: 'Schweregrad-Filter (z.B. CRITICAL,HIGH)',
          required: false,
          default: 'CRITICAL,HIGH',
        },
      ],
      category: 'Security',
    },
    {
      nameSuffix: 'get_health',
      description: 'Den Gesundheitsstatus des Trivy-Servers abfragen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /healthz',
      parameters: [],
      category: 'Security',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'none',

  buildAuthValue: () => '',

  buildHealthPath: () => '/healthz',
};

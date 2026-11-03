import type { ServiceTemplate } from '../../serviceTemplates.js';

export const teamsWebhookTemplate: ServiceTemplate = {
  id: 'teams-webhook',
  name: 'Microsoft Teams Webhook',
  description: 'Nachrichten über einen Microsoft Teams Incoming Webhook senden.',
  icon: '🟣',
  category: 'communication',
  tags: ['teams', 'microsoft', 'webhook', 'notifications'],

  fields: [
    {
      name: 'webhook_url',
      label: 'Webhook URL',
      type: 'string',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'send_message',
      description: 'Eine Nachricht über den Webhook senden',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'POST /\n\n{"text": "{{message}}"}',
      parameters: [
        {
          name: 'message',
          type: 'string',
          description: 'Nachrichtentext',
          required: true,
        },
      ],
      category: 'Communication',
    },
  ],

  buildBaseUrl: (fields) => fields.webhook_url,

  buildAuthType: () => 'none',

  buildAuthValue: () => '',

  buildHealthPath: () => null as unknown as string,
};

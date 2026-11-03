import type { ServiceTemplate } from '../../serviceTemplates.js';

export const discordWebhookTemplate: ServiceTemplate = {
  id: 'discord-webhook',
  name: 'Discord Webhook',
  description: 'Nachrichten über einen Discord Webhook senden.',
  icon: '🎮',
  category: 'communication',
  tags: ['discord', 'webhook', 'notifications', 'chat'],

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
      queryTemplate: 'POST /\n\n{"content": "{{message}}"}',
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

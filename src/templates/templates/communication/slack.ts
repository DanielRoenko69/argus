import type { ServiceTemplate } from '../../serviceTemplates.js';

export const slackTemplate: ServiceTemplate = {
  id: 'slack',
  name: 'Slack',
  description: 'Slack-Kanaele, Nachrichten und Benutzer über die Web-API abfragen, durchsuchen und benachrichtigen.',
  icon: '💬',
  category: 'communication',
  tags: ['slack', 'chat', 'messaging', 'notifications'],
  docsUrl: 'https://api.slack.com/methods',

  fields: [
    {
      name: 'bot_token',
      label: 'Bot Token (xoxb-...)',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'post_message',
      description: 'Eine Nachricht in einen Slack-Kanal senden',
      backend: 'custom:{{prefix}}',
      queryTemplate: [
        'POST /api/chat.postMessage',
        'Content-Type: application/json',
        '',
        '{"channel":"{{channel_id}}","text":"{{text}}"}',
      ].join('\n'),
      parameters: [
        {
          name: 'channel_id',
          type: 'string',
          description: 'Slack-Kanal-ID (z.B. C01234567)',
          required: true,
        },
        {
          name: 'text',
          type: 'string',
          description: 'Nachrichtentext',
          required: true,
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'list_channels',
      description: 'Alle Kanaele auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/conversations.list?types={{types}}&limit={{limit}}',
      parameters: [
        {
          name: 'types',
          type: 'string',
          description: 'Kanaltypen (z.B. public_channel, private_channel)',
          required: false,
          default: 'public_channel',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '100',
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'get_channel_history',
      description: 'Nachrichten-Verlauf eines Kanals abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/conversations.history?channel={{channel_id}}&limit={{limit}}',
      parameters: [
        {
          name: 'channel_id',
          type: 'string',
          description: 'ID des Kanals',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Nachrichten',
          required: false,
          default: '20',
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'search_messages',
      description: 'Nachrichten in Slack durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/search.messages?query={{query}}&count={{count}}',
      parameters: [
        {
          name: 'query',
          type: 'string',
          description: 'Suchbegriff',
          required: true,
        },
        {
          name: 'count',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '20',
        },
      ],
      category: 'Communication',
    },
    {
      nameSuffix: 'list_users',
      description: 'Alle Benutzer im Workspace auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/users.list?limit={{limit}}',
      parameters: [
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '100',
        },
      ],
      category: 'Communication',
    },
  ],

  buildBaseUrl: () => 'https://slack.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.bot_token,

  buildHealthPath: () => '/api/auth.test',

  buildConfig: () => ({ response_contract: 'slack-web-api' }),
};

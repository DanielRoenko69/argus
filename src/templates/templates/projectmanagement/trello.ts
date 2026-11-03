import type { ServiceTemplate } from '../../serviceTemplates.js';

export const trelloTemplate: ServiceTemplate = {
  id: 'trello',
  name: 'Trello',
  description: 'Trello-Boards, Listen und Karten abfragen und verwalten.',
  icon: '📌',
  category: 'projectmanagement',
  tags: ['trello', 'kanban', 'boards', 'cards'],
  docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/',

  fields: [
    {
      name: 'token',
      label: 'API Token / Personal Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_boards',
      description: 'Alle Boards des Benutzers auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /1/members/me/boards?fields=name,desc,url,dateLastActivity',
      parameters: [],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'get_board',
      description: 'Details eines Boards mit Listen und Karten abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /1/boards/{{board_id}}?fields=name,desc,url&lists=open&cards=visible',
      parameters: [
        {
          name: 'board_id',
          type: 'string',
          description: 'Board-ID',
          required: true,
        },
      ],
      category: 'Projektmanagement',
    },
    {
      nameSuffix: 'list_cards',
      description: 'Alle Karten eines Boards auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /1/boards/{{board_id}}/cards?fields=name,desc,due,labels,idMembers&limit={{limit}}',
      parameters: [
        {
          name: 'board_id',
          type: 'string',
          description: 'Board-ID',
          required: true,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximale Anzahl Karten',
          required: false,
          default: '50',
        },
      ],
      category: 'Projektmanagement',
    },
  ],

  buildBaseUrl: () => 'https://api.trello.com',

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/1/members/me',
};

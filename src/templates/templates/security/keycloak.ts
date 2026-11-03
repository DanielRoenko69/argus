import type { ServiceTemplate } from '../../serviceTemplates.js';

export const keycloakTemplate: ServiceTemplate = {
  id: 'keycloak',
  name: 'Keycloak',
  description: 'Keycloak-Benutzer, Realms und Clients verwalten.',
  icon: '🔑',
  category: 'security',
  tags: ['keycloak', 'iam', 'oauth', 'identity', 'sso'],
  docsUrl: 'https://www.keycloak.org/docs-api/latest/rest-api/',

  fields: [
    {
      name: 'base_url',
      label: 'Keycloak URL',
      type: 'string',
      required: true,
      placeholder: 'https://keycloak.example.com',
    },
    {
      name: 'realm',
      label: 'Realm',
      type: 'string',
      required: true,
      default: 'master',
    },
    {
      name: 'token',
      label: 'Admin Bearer Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'list_users',
      description: 'Benutzer eines Realms auflisten und durchsuchen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /admin/realms/{{realm}}/users?max={{max}}&search={{search}}',
      parameters: [
        {
          name: 'realm',
          type: 'string',
          description: 'Name des Realms',
          required: true,
          default: 'master',
        },
        {
          name: 'max',
          type: 'string',
          description: 'Maximale Anzahl der Ergebnisse',
          required: false,
          default: '20',
        },
        {
          name: 'search',
          type: 'string',
          description: 'Suchbegriff für Benutzer',
          required: false,
        },
      ],
      category: 'Security',
    },
    {
      nameSuffix: 'get_user',
      description: 'Details zu einem bestimmten Benutzer abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /admin/realms/{{realm}}/users/{{user_id}}',
      parameters: [
        {
          name: 'realm',
          type: 'string',
          description: 'Name des Realms',
          required: true,
        },
        {
          name: 'user_id',
          type: 'string',
          description: 'ID des Benutzers',
          required: true,
        },
      ],
      category: 'Security',
    },
    {
      nameSuffix: 'list_realms',
      description: 'Alle verfügbaren Realms auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /admin/realms',
      parameters: [],
      category: 'Security',
    },
    {
      nameSuffix: 'list_clients',
      description: 'Alle Clients eines Realms auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /admin/realms/{{realm}}/clients',
      parameters: [
        {
          name: 'realm',
          type: 'string',
          description: 'Name des Realms',
          required: true,
        },
      ],
      category: 'Security',
    },
    {
      nameSuffix: 'get_realm_roles',
      description: 'Alle Rollen eines Realms auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /admin/realms/{{realm}}/roles',
      parameters: [
        {
          name: 'realm',
          type: 'string',
          description: 'Name des Realms',
          required: true,
        },
      ],
      category: 'Security',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/health',
};

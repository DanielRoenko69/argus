import type { ServiceTemplate } from '../../serviceTemplates.js';

export const remoteMcpTemplate: ServiceTemplate = {
  id: 'remote-mcp',
  name: 'Remote MCP Server',
  description: 'Einen externen MCP-Server anbinden. Tools werden automatisch erkannt.',
  icon: '\uD83D\uDD17',
  category: 'api',
  tags: ['mcp', 'remote', 'gateway', 'proxy'],
  backendType: 'mcp',

  fields: [
    {
      name: 'base_url',
      label: 'Base URL',
      type: 'string',
      required: true,
      placeholder: 'https://mcp-server.example.com',
    },
    {
      name: 'mcp_endpoint',
      label: 'MCP-Endpunkt',
      type: 'string',
      required: false,
      default: '/mcp',
      placeholder: '/mcp',
    },
    {
      name: 'auth_type',
      label: 'Auth-Typ',
      type: 'select',
      required: true,
      default: 'none',
      options: ['none', 'bearer', 'basic', 'header'],
    },
    {
      name: 'auth_value',
      label: 'Auth-Wert',
      type: 'password',
      required: false,
      placeholder: 'Token, user:password oder Header-Wert',
    },
  ],

  tools: [],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: (fields) => fields.auth_type || 'none',

  buildAuthValue: (fields) => fields.auth_value || '',

  buildMcpEndpoint: (fields) => fields.mcp_endpoint || '/mcp',
};

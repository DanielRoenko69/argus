import type { ServiceTemplate } from '../../serviceTemplates.js';

export const sonarqubeTemplate: ServiceTemplate = {
  id: 'sonarqube',
  name: 'SonarQube',
  description: 'SonarQube-Codequalitaet, Schwachstellen und Metriken abfragen.',
  icon: '🔎',
  category: 'devops',
  tags: ['sonarqube', 'code-quality', 'static-analysis', 'security'],
  docsUrl: 'https://docs.sonarqube.org/latest/extension-guide/web-api/',

  fields: [
    {
      name: 'base_url',
      label: 'SonarQube URL',
      type: 'string',
      required: true,
      placeholder: 'http://sonarqube:9000',
    },
    {
      name: 'token',
      label: 'Token',
      type: 'password',
      required: true,
    },
  ],

  tools: [
    {
      nameSuffix: 'get_project_status',
      description: 'Quality-Gate-Status eines Projekts abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/qualitygates/project_status?projectKey={{project_key}}',
      parameters: [
        {
          name: 'project_key',
          type: 'string',
          description: 'Schlüssel des Projekts',
          required: true,
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_issues',
      description: 'Issues und Schwachstellen eines Projekts auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/issues/search?componentKeys={{project_key}}&severities={{severities}}&ps={{page_size}}',
      parameters: [
        {
          name: 'project_key',
          type: 'string',
          description: 'Schlüssel des Projekts',
          required: true,
        },
        {
          name: 'severities',
          type: 'string',
          description: 'Schweregrade filtern (INFO, MINOR, MAJOR, CRITICAL, BLOCKER)',
          required: false,
          default: '',
        },
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '25',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'get_metrics',
      description: 'Metriken und Messwerte eines Projekts abrufen',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/measures/component?component={{project_key}}&metricKeys={{metric_keys}}',
      parameters: [
        {
          name: 'project_key',
          type: 'string',
          description: 'Schlüssel des Projekts',
          required: true,
        },
        {
          name: 'metric_keys',
          type: 'string',
          description: 'Kommagetrennte Liste der Metriken',
          required: false,
          default: 'bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density',
        },
      ],
      category: 'DevOps',
    },
    {
      nameSuffix: 'list_projects',
      description: 'Alle SonarQube-Projekte auflisten',
      backend: 'custom:{{prefix}}',
      queryTemplate: 'GET /api/projects/search?ps={{page_size}}&p={{page}}',
      parameters: [
        {
          name: 'page_size',
          type: 'number',
          description: 'Anzahl Ergebnisse pro Seite',
          required: false,
          default: '50',
        },
        {
          name: 'page',
          type: 'number',
          description: 'Seitennummer',
          required: false,
          default: '1',
        },
      ],
      category: 'DevOps',
    },
  ],

  buildBaseUrl: (fields) => fields.base_url,

  buildAuthType: () => 'bearer',

  buildAuthValue: (fields) => fields.token,

  buildHealthPath: () => '/api/system/health',
};

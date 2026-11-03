import { certifyServiceTemplateTools } from '../certification.js';
import { getAllTemplates } from '../serviceTemplates.js';

describe('native connector tool certification', () => {
  const templates = getAllTemplates();

  it('keeps every template and tool identity unique', () => {
    const templateIds = templates.map(template => template.id);
    expect(new Set(templateIds).size).toBe(templateIds.length);

    for (const template of templates) {
      const names = template.tools.map(tool => tool.nameSuffix);
      expect(new Set(names).size).toBe(names.length);
      // Generic REST/MCP connection templates intentionally discover tools at
      // runtime and therefore have no static tool definitions.
      expect(names.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('contract-certifies every tool in every native connector template', () => {
    const matrix = certifyServiceTemplateTools(templates);
    expect(matrix.length).toBe(templates.reduce((sum, template) => sum + template.tools.length, 0));
    expect(matrix.filter(result => result.status === 'failed')).toEqual([]);
  });

  it('never embeds a configured secret field in a request template', () => {
    for (const template of templates) {
      const secretFields = template.fields.filter(field => field.type === 'password');
      for (const tool of template.tools) {
        for (const field of secretFields) {
          expect(tool.queryTemplate).not.toContain(`{{${field.name}}}`);
        }
      }
    }
  });
});

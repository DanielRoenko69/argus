import { renderTemplate } from '../../tools/dynamic/index.js';
import { getTemplateById } from '../serviceTemplates.js';

describe('Slack connector template', () => {
  it('provides the governed post-message capability required by visual workflows', () => {
    const template = getTemplateById('slack');
    const tool = template?.tools.find(candidate => candidate.nameSuffix === 'post_message');

    expect(tool).toBeDefined();
    expect(tool?.queryTemplate).toContain('POST /api/chat.postMessage');
    expect(tool?.parameters.filter(parameter => parameter.required).map(parameter => parameter.name))
      .toEqual(['channel_id', 'text']);
    expect(template?.buildConfig?.({})).toEqual({ response_contract: 'slack-web-api' });
  });

  it('keeps multiline and quoted Agent output valid inside the Slack JSON request', () => {
    const template = getTemplateById('slack');
    const tool = template?.tools.find(candidate => candidate.nameSuffix === 'post_message');
    if (!tool) throw new Error('Slack post_message capability missing');

    const rendered = renderTemplate(tool.queryTemplate, {
      channel_id: 'C-ARGUS',
      text: 'Severity: "high"\nOwner: Platform',
    }, tool.parameters);
    const body = rendered.split('\n\n')[1];

    expect(JSON.parse(body ?? '{}')).toEqual({
      channel: 'C-ARGUS',
      text: 'Severity: "high"\nOwner: Platform',
    });
  });
});
